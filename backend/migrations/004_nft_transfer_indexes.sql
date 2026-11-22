CREATE INDEX IF NOT EXISTS chain_events_nft_transfer_from_idx
  ON chain_events (chain_id, contract_address, lower(args->>'from'), block_number DESC)
  WHERE event_name = 'Transfer';
CREATE INDEX IF NOT EXISTS chain_events_nft_transfer_to_idx
  ON chain_events (chain_id, contract_address, lower(args->>'to'), block_number DESC)
  WHERE event_name = 'Transfer';
CREATE INDEX IF NOT EXISTS chain_events_nft_transfer_token_idx
  ON chain_events (chain_id, contract_address, (args->>'tokenId'), block_number DESC, transaction_index DESC, log_index DESC)
  WHERE event_name = 'Transfer';
