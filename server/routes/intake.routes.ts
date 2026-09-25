import { Router } from 'express';
import { pool } from '../db';
import { classifySymptoms } from '../lib/classifier';
import { mapSubmission } from '../lib/mappers';
import { isReviewRequired, parseConfidenceThreshold } from '../../shared/logic';
import { asyncHandler, trimmedString } from '../lib/http';
import type { CreateIntakeRequest } from '../../shared/types';

const router = Router();

// Throws at startup on an invalid value, so a typo can't silently disable mandatory review.
const CONFIDENCE_THRESHOLD = parseConfidenceThreshold(process.env.CONFIDENCE_THRESHOLD);

// POST /api/intake — front-desk symptom intake. Classifies the submission with
// AI, then persists ONLY the classification outcome. The raw symptomText from
// the request body is never written to the database or logged.
router.post('/intake', asyncHandler(async (req, res) => {
  const body = req.body as Partial<CreateIntakeRequest>;
  const patientName = trimmedString(body.patientName);
  const symptomText = trimmedString(body.symptomText);
  const contactPhone = trimmedString(body.contactPhone) || null;

  if (!patientName) {
    return res.status(400).json({ success: false, error: 'patientName is required.' });
  }
  if (!symptomText || symptomText.length < 3) {
    return res.status(400).json({ success: false, error: 'symptomText is required.' });
  }

  try {
    const classification = await classifySymptoms(symptomText);
    const needsHumanReview = isReviewRequired(classification.confidenceScore, CONFIDENCE_THRESHOLD);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO intake_submissions
           (patient_name, contact_phone, urgency_level, suggested_department,
            confidence_score, needs_human_review, final_urgency_level, final_department)
         VALUES ($1, $2, $3, $4, $5, $6, $3, $4)
         RETURNING *`,
        [
          patientName,
          contactPhone,
          classification.urgencyLevel,
          classification.suggestedDepartment,
          classification.confidenceScore,
          needsHumanReview,
        ],
      );
      const submissionRow = insertResult.rows[0];

      await client.query(
        `INSERT INTO classification_history
           (intake_id, urgency_level, suggested_department, confidence_score, model_name, prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          submissionRow.id,
          classification.urgencyLevel,
          classification.suggestedDepartment,
          classification.confidenceScore,
          classification.modelName,
          classification.promptVersion,
        ],
      );

      await client.query('COMMIT');

      return res.status(201).json({ success: true, submission: mapSubmission(submissionRow) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error in POST /api/intake:', error);
    return res.status(500).json({ success: false, error: 'Failed to process intake submission.' });
  }
}));

export default router;
