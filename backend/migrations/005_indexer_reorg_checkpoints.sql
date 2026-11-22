CREATE TABLE IF NOT EXISTS indexer_block_checkpoints (
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address, block_number)
);

CREATE INDEX IF NOT EXISTS indexer_block_checkpoints_lookup_idx
  ON indexer_block_checkpoints (chain_id, contract_address, block_number DESC);

-- Preserve the current cursor as a starting checkpoint for existing installs.
-- If it later becomes non-canonical and no earlier checkpoints exist, the
-- indexer safely rebuilds this contract's history from its deployment block.
INSERT INTO indexer_block_checkpoints (chain_id, contract_address, block_number, block_hash)
SELECT chain_id, contract_address, block_number, block_hash
FROM indexer_cursors
ON CONFLICT (chain_id, contract_address, block_number) DO NOTHING;
