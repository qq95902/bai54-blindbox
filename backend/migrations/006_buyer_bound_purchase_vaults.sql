CREATE TABLE IF NOT EXISTS purchase_vaults (
  chain_id bigint NOT NULL,
  processor_address text NOT NULL,
  buyer_address text NOT NULL,
  referrer_address text NOT NULL,
  vault_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, processor_address, buyer_address, referrer_address),
  UNIQUE (chain_id, processor_address, vault_address)
);
CREATE INDEX IF NOT EXISTS purchase_vaults_vault_idx
  ON purchase_vaults (chain_id, processor_address, vault_address);
