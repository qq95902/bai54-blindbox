CREATE TABLE IF NOT EXISTS service_heartbeats (
  service_name text NOT NULL,
  instance_id text NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (service_name, instance_id)
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address)
);

CREATE TABLE IF NOT EXISTS chain_events (
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_index integer NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  event_name text NOT NULL,
  args jsonb NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_contract_name_block_idx
  ON chain_events (chain_id, contract_address, event_name, block_number DESC);
CREATE INDEX IF NOT EXISTS chain_events_event_day_idx
  ON chain_events (event_name, ((args->>'dayId')));
CREATE INDEX IF NOT EXISTS chain_events_free_queue_idx
  ON chain_events (((args->>'queueIndex')::numeric))
  WHERE event_name = 'FreeBoxClaimRegistered';
CREATE INDEX IF NOT EXISTS chain_events_synthesis_idx
  ON chain_events (((args->>'synthesisId')::numeric))
  WHERE event_name = 'SynthesisRequested';

CREATE TABLE IF NOT EXISTS keeper_jobs (
  job_key text PRIMARY KEY,
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'confirmed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  transaction_hash text,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS keeper_jobs_status_started_idx ON keeper_jobs (status, started_at DESC);
