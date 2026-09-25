export const URGENCY_LEVELS = ['high', 'medium', 'low'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const DEPARTMENTS = [
  'Refer to Emergency Room',
  'General Urgent Care',
  'Orthopedic & Injury',
  'Respiratory & ENT',
  'Pediatric Care',
  'Minor Illness',
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const REVIEW_STATUSES = ['pending', 'reviewed', 'overridden'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** modelName recorded in classification_history when the fail-safe result replaced the AI. */
export const FALLBACK_MODEL_NAME = 'unavailable-fallback';

export interface ClassificationResult {
  urgencyLevel: UrgencyLevel;
  suggestedDepartment: Department;
  confidenceScore: number; // 0-1
  modelName: string;
  promptVersion: string;
}

export interface IntakeSubmission {
  id: string;
  patientName: string;
  contactPhone: string | null;
  submittedAt: string;
  urgencyLevel: UrgencyLevel;
  suggestedDepartment: Department;
  confidenceScore: number;
  needsHumanReview: boolean;
  finalUrgencyLevel: UrgencyLevel;
  finalDepartment: Department;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OverrideLogEntry {
  id: string;
  intakeId: string;
  previousUrgencyLevel: UrgencyLevel;
  previousDepartment: string;
  newUrgencyLevel: UrgencyLevel;
  newDepartment: Department;
  reason: string;
  overriddenBy: string;
  overriddenAt: string;
}

export interface ClassificationHistoryEntry {
  id: string;
  intakeId: string;
  urgencyLevel: UrgencyLevel;
  suggestedDepartment: Department;
  confidenceScore: number;
  modelName: string;
  promptVersion: string;
  classifiedAt: string;
}

export interface IntakeDetail {
  submission: IntakeSubmission;
  classificationHistory: ClassificationHistoryEntry[];
  overrideLogs: OverrideLogEntry[];
}

export interface CreateIntakeRequest {
  patientName: string;
  contactPhone?: string;
  symptomText: string;
}

// Who performed an override/confirm is taken from the authenticated session on the
// server, never from the request body, so the audit trail can't be forged.
export interface OverrideRequest {
  newUrgencyLevel: UrgencyLevel;
  newDepartment: Department;
  reason: string;
}

export interface StaffUser {
  username: string;
}
