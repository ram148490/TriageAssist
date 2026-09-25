// Note: raw symptom intake text is NEVER persisted here. It is used in-memory,
// once, to produce a classification, then discarded. Only the classification
// outcome (urgency, department, confidence) is stored long-term.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS intake_submissions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_name          TEXT NOT NULL,
  contact_phone         TEXT,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Current AI-suggested classification (as returned by the most recent classification run).
  urgency_level         TEXT NOT NULL CHECK (urgency_level IN ('high', 'medium', 'low')),
  suggested_department  TEXT NOT NULL,
  confidence_score      NUMERIC(4,3) NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  needs_human_review    BOOLEAN NOT NULL,

  -- Effective/current triage decision shown in the queue. Starts equal to the
  -- AI suggestion; a staff override updates these two fields (and only these two).
  final_urgency_level   TEXT NOT NULL CHECK (final_urgency_level IN ('high', 'medium', 'low')),
  final_department      TEXT NOT NULL,

  -- Queue lifecycle state.
  review_status         TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed', 'overridden')),
  reviewed_by           TEXT,
  reviewed_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intake_review_status ON intake_submissions (review_status);
CREATE INDEX IF NOT EXISTS idx_intake_submitted_at ON intake_submissions (submitted_at);

-- Full audit trail of every AI classification run against a submission.
-- Stores only the classification outcome, never the symptom text that produced it.
CREATE TABLE IF NOT EXISTS classification_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id             UUID NOT NULL REFERENCES intake_submissions(id) ON DELETE CASCADE,
  urgency_level         TEXT NOT NULL CHECK (urgency_level IN ('high', 'medium', 'low')),
  suggested_department  TEXT NOT NULL,
  confidence_score      NUMERIC(4,3) NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  model_name            TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  classified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classification_intake ON classification_history (intake_id);

-- Every manual override, with a mandatory reason, for audit/compliance.
CREATE TABLE IF NOT EXISTS override_logs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id               UUID NOT NULL REFERENCES intake_submissions(id) ON DELETE CASCADE,
  previous_urgency_level  TEXT NOT NULL,
  previous_department     TEXT NOT NULL,
  new_urgency_level       TEXT NOT NULL CHECK (new_urgency_level IN ('high', 'medium', 'low')),
  new_department          TEXT NOT NULL,
  reason                  TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  overridden_by           TEXT NOT NULL,
  overridden_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_override_intake ON override_logs (intake_id);

-- Staff accounts. Passwords are stored only as scrypt hashes (see server/lib/auth.ts).
-- Create accounts with: npm run create-user -- <username>
CREATE TABLE IF NOT EXISTS staff_users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username              TEXT NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 32),
  password_hash         TEXT NOT NULL,
  disabled              BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
