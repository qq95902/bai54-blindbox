CREATE TABLE IF NOT EXISTS wallet_signing_challenges (
  challenge_id text PRIMARY KEY,
  chain_id bigint NOT NULL,
  buyer_address text NOT NULL,
  referrer_address text NOT NULL,
  origin text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (challenge_id ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS wallet_signing_challenges_expiry_idx
  ON wallet_signing_challenges (expires_at)
  WHERE used_at IS NULL;
