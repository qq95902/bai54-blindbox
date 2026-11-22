ALTER TABLE keeper_jobs DROP CONSTRAINT IF EXISTS keeper_jobs_status_check;
ALTER TABLE keeper_jobs ADD CONSTRAINT keeper_jobs_status_check
  CHECK (status IN ('running', 'confirmed', 'failed', 'ignored'));

COMMENT ON COLUMN keeper_jobs.status IS
  'running/failed are retryable; confirmed and ignored are terminal. Ignored records include invalid deposit senders.';
