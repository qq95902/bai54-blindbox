DROP INDEX IF EXISTS wallet_signing_challenges_expiry_idx;
CREATE INDEX wallet_signing_challenges_expiry_idx
  ON wallet_signing_challenges (expires_at);
