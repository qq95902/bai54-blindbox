export const unprocessedDepositTransfersSql = `SELECT transaction_hash, log_index, args FROM chain_events e
     WHERE chain_id=$1 AND contract_address=$2 AND event_name='Transfer'
       AND lower(args->>'to')=ANY($3::text[])
       AND args ? 'depositId'
       AND NOT EXISTS (
         SELECT 1 FROM keeper_jobs j
         WHERE j.job_key='purchase:register:' || (e.args->>'depositId')
           AND j.status IN ('confirmed','ignored')
       )
       AND NOT EXISTS (
         SELECT 1 FROM chain_events returned
         WHERE returned.chain_id=e.chain_id AND returned.contract_address=$4
           AND returned.event_name IN ('UnregisteredTransferRefundAuthorized','UnregisteredTransferReturned')
           AND returned.args->>'depositId'=e.args->>'depositId'
       )
     ORDER BY block_number,log_index LIMIT 100`;

export function depositSenderMatches(args, binding) {
  return Boolean(binding && args?.from && args?.to &&
    args.from.toLowerCase() === binding.buyer.toLowerCase() &&
    args.to.toLowerCase() === binding.vault.toLowerCase());
}

export async function markDepositSenderMismatch(pool, depositId) {
  await pool.query(
    `INSERT INTO keeper_jobs(job_key,action,status,attempts,next_attempt_at,started_at,completed_at,error_code)
     VALUES ($1,'ignore_mismatched_deposit_sender','ignored',1,now(),now(),now(),'DEPOSIT_SENDER_MISMATCH')
     ON CONFLICT (job_key) DO UPDATE SET
       status=CASE WHEN keeper_jobs.status='confirmed' THEN 'confirmed' ELSE 'ignored' END,
       action=CASE WHEN keeper_jobs.status='confirmed' THEN keeper_jobs.action ELSE 'ignore_mismatched_deposit_sender' END,
       attempts=CASE WHEN keeper_jobs.status='confirmed' THEN keeper_jobs.attempts ELSE keeper_jobs.attempts+1 END,
       next_attempt_at=now(),
       completed_at=CASE WHEN keeper_jobs.status='confirmed' THEN keeper_jobs.completed_at ELSE now() END,
       error_code=CASE WHEN keeper_jobs.status='confirmed' THEN keeper_jobs.error_code ELSE 'DEPOSIT_SENDER_MISMATCH' END`,
    [`purchase:register:${depositId}`]
  );
}

/** Authorize a wrong-sender refund and only mark the transfer terminal after chain state confirms it. */
export async function authorizeMismatchRefund({
  pool, processor, action, depositId, buyer, referrer, sender, vault, amount
}) {
  await action(`purchase:authorize-refund:${depositId}`, 'authorize_unregistered_usdt_refund',
    () => processor.authorizeUnregisteredTransferRefund(
      depositId, buyer, referrer, sender, vault, amount
    ));

  // A Keeper action can return false while a transaction is pending, failed, or
  // already reconciled. Read the contract instead of guessing from that result.
  const refund = await processor.unregisteredRefunds(depositId);
  if (!refund.buyer || refund.buyer.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return false;
  }
  await markDepositSenderMismatch(pool, depositId);
  return true;
}
