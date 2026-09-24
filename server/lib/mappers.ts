import type { ClassificationHistoryEntry, IntakeSubmission, OverrideLogEntry } from '../../shared/types';

export function mapSubmission(row: any): IntakeSubmission {
  return {
    id: row.id,
    patientName: row.patient_name,
    contactPhone: row.contact_phone,
    submittedAt: row.submitted_at,
    urgencyLevel: row.urgency_level,
    suggestedDepartment: row.suggested_department,
    confidenceScore: Number(row.confidence_score),
    needsHumanReview: row.needs_human_review,
    finalUrgencyLevel: row.final_urgency_level,
    finalDepartment: row.final_department,
    reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapClassificationHistory(row: any): ClassificationHistoryEntry {
  return {
    id: row.id,
    intakeId: row.intake_id,
    urgencyLevel: row.urgency_level,
    suggestedDepartment: row.suggested_department,
    confidenceScore: Number(row.confidence_score),
    modelName: row.model_name,
    promptVersion: row.prompt_version,
    classifiedAt: row.classified_at,
  };
}

export function mapOverrideLog(row: any): OverrideLogEntry {
  return {
    id: row.id,
    intakeId: row.intake_id,
    previousUrgencyLevel: row.previous_urgency_level,
    previousDepartment: row.previous_department,
    newUrgencyLevel: row.new_urgency_level,
    newDepartment: row.new_department,
    reason: row.reason,
    overriddenBy: row.overridden_by,
    overriddenAt: row.overridden_at,
  };
}
