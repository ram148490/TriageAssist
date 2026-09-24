import { Router } from 'express';
import { pool } from '../db';
import { mapClassificationHistory, mapOverrideLog, mapSubmission } from '../lib/mappers';
import { DEPARTMENTS, URGENCY_LEVELS, type OverrideRequest } from '../../shared/types';

const router = Router();

// GET /api/queue — all submissions, sorted by urgency (high first), then
// oldest-first within the same urgency level so nobody gets skipped.
router.get('/queue', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM intake_submissions
       ORDER BY
         CASE final_urgency_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         submitted_at ASC`,
    );
    return res.json({ success: true, submissions: result.rows.map(mapSubmission) });
  } catch (error) {
    console.error('Error in GET /api/queue:', error);
    return res.status(500).json({ success: false, error: 'Failed to load the triage queue.' });
  }
});

// GET /api/queue/:id — one submission with its full classification + override audit trail.
router.get('/queue/:id', async (req, res) => {
  try {
    const submissionResult = await pool.query('SELECT * FROM intake_submissions WHERE id = $1', [req.params.id]);
    if (submissionResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Submission not found.' });
    }

    const [historyResult, overridesResult] = await Promise.all([
      pool.query('SELECT * FROM classification_history WHERE intake_id = $1 ORDER BY classified_at ASC', [req.params.id]),
      pool.query('SELECT * FROM override_logs WHERE intake_id = $1 ORDER BY overridden_at ASC', [req.params.id]),
    ]);

    return res.json({
      success: true,
      detail: {
        submission: mapSubmission(submissionResult.rows[0]),
        classificationHistory: historyResult.rows.map(mapClassificationHistory),
        overrideLogs: overridesResult.rows.map(mapOverrideLog),
      },
    });
  } catch (error) {
    console.error('Error in GET /api/queue/:id:', error);
    return res.status(500).json({ success: false, error: 'Failed to load submission.' });
  }
});

// POST /api/queue/:id/confirm — staff confirms the AI classification is correct
// as-is. Satisfies the mandatory human-review requirement without changing anything.
router.post('/queue/:id/confirm', async (req, res) => {
  const confirmedBy = (req.body?.confirmedBy as string | undefined)?.trim();
  if (!confirmedBy) {
    return res.status(400).json({ success: false, error: 'confirmedBy is required.' });
  }

  try {
    const result = await pool.query(
      `UPDATE intake_submissions
       SET review_status = 'reviewed', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, confirmedBy],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Submission not found.' });
    }
    return res.json({ success: true, submission: mapSubmission(result.rows[0]) });
  } catch (error) {
    console.error('Error in POST /api/queue/:id/confirm:', error);
    return res.status(500).json({ success: false, error: 'Failed to confirm submission.' });
  }
});

// POST /api/queue/:id/override — manual override of a classification. A reason
// is mandatory and every override is written to override_logs for audit.
router.post('/queue/:id/override', async (req, res) => {
  const body = req.body as Partial<OverrideRequest>;
  const newUrgencyLevel = body.newUrgencyLevel;
  const newDepartment = body.newDepartment;
  const reason = body.reason?.trim();
  const overriddenBy = body.overriddenBy?.trim();

  if (!newUrgencyLevel || !URGENCY_LEVELS.includes(newUrgencyLevel)) {
    return res.status(400).json({ success: false, error: 'A valid newUrgencyLevel is required.' });
  }
  if (!newDepartment || !DEPARTMENTS.includes(newDepartment)) {
    return res.status(400).json({ success: false, error: 'A valid newDepartment is required.' });
  }
  if (!reason) {
    return res.status(400).json({ success: false, error: 'A reason is required to override a classification.' });
  }
  if (!overriddenBy) {
    return res.status(400).json({ success: false, error: 'overriddenBy is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM intake_submissions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Submission not found.' });
    }
    const current = currentResult.rows[0];

    const updateResult = await client.query(
      `UPDATE intake_submissions
       SET final_urgency_level = $2, final_department = $3, review_status = 'overridden',
           reviewed_by = $4, reviewed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, newUrgencyLevel, newDepartment, overriddenBy],
    );

    await client.query(
      `INSERT INTO override_logs
         (intake_id, previous_urgency_level, previous_department, new_urgency_level, new_department, reason, overridden_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.params.id, current.final_urgency_level, current.final_department, newUrgencyLevel, newDepartment, reason, overriddenBy],
    );

    await client.query('COMMIT');
    return res.json({ success: true, submission: mapSubmission(updateResult.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in POST /api/queue/:id/override:', error);
    return res.status(500).json({ success: false, error: 'Failed to override classification.' });
  } finally {
    client.release();
  }
});

export default router;
