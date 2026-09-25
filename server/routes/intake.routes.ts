import { Router } from 'express';
import { pool } from '../db';
import { classifySymptoms } from '../lib/classifier';
import { asyncHandler } from '../lib/http';
import { logError } from '../lib/log';
import { mapSubmission } from '../lib/mappers';
import { intakeLimiter } from './auth.routes';
import { isReviewRequired, parseConfidenceThreshold } from '../../shared/logic';
import { FALLBACK_MODEL_NAME } from '../../shared/types';
import { validateIntake } from '../../shared/validation';

const router = Router();

// Throws at startup on an invalid value, so a typo can't silently disable mandatory review.
const CONFIDENCE_THRESHOLD = parseConfidenceThreshold(process.env.CONFIDENCE_THRESHOLD);

// POST /api/intake — front-desk symptom intake (authenticated staff only). Classifies
// the submission with AI, then persists ONLY the classification outcome. The raw
// symptomText from the request body is never written to the database or logged.
router.post('/intake', asyncHandler(async (req, res) => {
  const wait = intakeLimiter.consume(req.user!.id);
  if (wait > 0) {
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    return res.status(429).json({ success: false, error: 'Too many intake submissions. Please wait a moment.' });
  }

  const input = validateIntake(req.body ?? {});
  if (!input.ok) {
    return res.status(400).json({ success: false, error: input.error });
  }
  const { patientName, contactPhone, symptomText } = input.value;

  try {
    const classification = await classifySymptoms(symptomText);
    const needsHumanReview = isReviewRequired(classification.confidenceScore, CONFIDENCE_THRESHOLD);
    // True when the AI could not be used and the fail-safe result was substituted.
    const classificationUnavailable = classification.modelName === FALLBACK_MODEL_NAME;

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

      return res.status(201).json({
        success: true,
        submission: mapSubmission(submissionRow),
        classificationUnavailable,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    // logError, not the raw error: Postgres errors carry the failing row (patient name/phone).
    logError('Error in POST /api/intake', error);
    return res.status(500).json({ success: false, error: 'Failed to process intake submission.' });
  }
}));

export default router;
