ALTER TABLE keeper_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS keeper_jobs_due_idx
  ON keeper_jobs (next_attempt_at)
  WHERE status <> 'confirmed';
