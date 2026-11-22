/** Execute a Keeper transaction once, reconciling any previously broadcast hash first.
 *
 * A timeout from tx.wait() does not prove that the chain rejected the transaction.
 * Retrying the contract call blindly can create a second transaction. This helper
 * records ambiguous outcomes and waits for a receipt instead of resubmitting.
 */
export async function runKeeperAction({
  pool, provider, jobKey, label, send, confirmations = 1,
  retrySeconds = 30, log = () => {}, errorCode = () => 'UNKNOWN_ERROR'
}) {
  const prior = await pool.query(
    'SELECT status, attempts, next_attempt_at, transaction_hash, error_code, (next_attempt_at <= now()) AS retry_due FROM keeper_jobs WHERE job_key = $1',
    [jobKey]
  );
  const job = prior.rows[0];
  if (job?.status === 'confirmed') return false;
  if (job?.error_code === 'BROADCAST_OUTCOME_UNKNOWN' && !job.transaction_hash) {
    await defer(jobKey, pool, retrySeconds, 'BROADCAST_OUTCOME_UNKNOWN');
    return false;
  }

  if (job?.transaction_hash) {
    try {
      const receipt = await provider.getTransactionReceipt(job.transaction_hash);
      if (receipt) {
        if (Number(receipt.status) === 1) {
          const head = await provider.getBlockNumber();
          const depth = head - Number(receipt.blockNumber) + 1;
          if (depth >= confirmations) {
            await pool.query(
              `UPDATE keeper_jobs SET status='confirmed',completed_at=now(),next_attempt_at=now(),error_code=NULL WHERE job_key=$1`,
              [jobKey]
            );
            log('info', 'keeper_transaction_confirmed', {
              jobKey, action: label, transactionHash: job.transaction_hash,
              blockNumber: receipt.blockNumber, reconciled: true
            });
            return true;
          }
          await defer(jobKey, pool, retrySeconds, 'WAITING_CONFIRMATIONS');
          return false;
        }
        // A mined revert is definitive, so a later retry can safely reevaluate state.
      } else {
        const pending = await provider.getTransaction(job.transaction_hash);
        await defer(jobKey, pool, retrySeconds,
          pending ? 'TRANSACTION_PENDING' : 'TRANSACTION_OUTCOME_UNKNOWN');
        return false;
      }
    } catch (error) {
      // RPC failures must never turn an uncertain transaction into a blind resend.
      await defer(jobKey, pool, retrySeconds, errorCode(error));
      return false;
    }
  } else if (job?.status === 'running') {
    // A process may have died after broadcasting but before persisting the hash.
    await defer(jobKey, pool, retrySeconds, 'BROADCAST_OUTCOME_UNKNOWN');
    return false;
  }

  if (job?.next_attempt_at && job.retry_due === false) return false;

  await pool.query(
    `INSERT INTO keeper_jobs(job_key,action,status,attempts,next_attempt_at,started_at,completed_at,error_code)
     VALUES ($1,$2,'running',1,now(),now(),NULL,NULL)
     ON CONFLICT (job_key) DO UPDATE SET status='running', attempts=keeper_jobs.attempts+1,
       next_attempt_at=now(), started_at=now(), completed_at=NULL, error_code=NULL`,
    [jobKey, label]
  );

  let tx;
  try {
    tx = await send();
    if (!tx?.hash) throw new Error('TRANSACTION_HASH_MISSING');
    await pool.query('UPDATE keeper_jobs SET transaction_hash=$2 WHERE job_key=$1', [jobKey, tx.hash]);
    log('info', 'keeper_transaction_submitted', { jobKey, action: label, transactionHash: tx.hash });
    const receipt = await tx.wait(confirmations);
    if (Number(receipt.status) !== 1) throw new Error('TRANSACTION_REVERTED');
    await pool.query(
      `UPDATE keeper_jobs SET status='confirmed',completed_at=now(),next_attempt_at=now(),error_code=NULL WHERE job_key=$1`,
      [jobKey]
    );
    log('info', 'keeper_transaction_confirmed', {
      jobKey, action: label, transactionHash: tx.hash, blockNumber: receipt.blockNumber
    });
    return true;
  } catch (error) {
    const rawCode = errorCode(error);
    const uncertainBroadcast = !tx?.hash && /TIMEOUT|NETWORK|SERVER|ECONN|ETIMEDOUT|UNKNOWN/i.test(rawCode);
    const code = uncertainBroadcast ? 'BROADCAST_OUTCOME_UNKNOWN' : rawCode;
    const attempts = Number(job?.attempts || 0) + 1;
    const backoff = Math.min(3600, 15 * (2 ** Math.min(attempts, 8)));
    await pool.query(
      `UPDATE keeper_jobs SET status='failed',error_code=$2,transaction_hash=COALESCE($3,transaction_hash),
         next_attempt_at=now() + ($4 * interval '1 second') WHERE job_key=$1`,
      [jobKey, code, tx?.hash || null, backoff]
    ).catch(() => {});
    log('error', 'keeper_action_failed', { jobKey, action: label, errorCode: code, transactionHash: tx?.hash });
    return false;
  }
}

async function defer(jobKey, pool, seconds, code) {
  // The database clock is authoritative in production.
  const delay = Math.max(1, Math.ceil(seconds));
  await pool.query(
    `UPDATE keeper_jobs SET status='failed',error_code=$2,
       next_attempt_at=now() + ($3 * interval '1 second') WHERE job_key=$1`,
    [jobKey, code, delay]
  );
}
