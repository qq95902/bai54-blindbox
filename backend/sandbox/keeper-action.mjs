import assert from 'node:assert/strict';
import { runKeeperAction } from '../src/keeper-action.mjs';

let assertions = 0;
function check(ok, message) { assert.ok(ok, message); assertions++; }

class JobPool {
  job = null;
  failConfirmedOnce = false;
  async query(sql, params = []) {
    if (/SELECT status, attempts/i.test(sql)) return { rows: this.job ? [{ ...this.job, retry_due: this.job.retry_due ?? true }] : [] };
    if (/INSERT INTO keeper_jobs/i.test(sql)) {
      if (!this.job) this.job = { status: 'running', attempts: 1, next_attempt_at: new Date(0), transaction_hash: null, error_code: null };
      else Object.assign(this.job, { status: 'running', attempts: this.job.attempts + 1, next_attempt_at: new Date(0), error_code: null });
      return { rows: [], rowCount: 1 };
    }
    if (/SET transaction_hash=/i.test(sql)) { this.job.transaction_hash = params[1]; return { rows: [], rowCount: 1 }; }
    if (/SET status='confirmed'/i.test(sql)) {
      if (this.failConfirmedOnce) { this.failConfirmedOnce = false; throw Object.assign(new Error('simulated DB write failure'), { code: 'ECONNRESET' }); }
      Object.assign(this.job, { status: 'confirmed', error_code: null }); return { rows: [], rowCount: 1 };
    }
    if (/SET status='failed'/i.test(sql)) { Object.assign(this.job, { status: 'failed', error_code: params[1] }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  }
}

function makeProvider({ receipt = null, transaction = null, head = 100 } = {}) {
  return {
    receipt, transaction, head,
    async getTransactionReceipt() { if (this.failReceipt) throw Object.assign(new Error('simulated RPC timeout'), { code: 'ETIMEDOUT' }); return this.receipt; },
    async getTransaction() { return this.transaction; },
    async getBlockNumber() { return this.head; }
  };
}

for (let round = 1; round <= 20; round++) {
  // Previously broadcast transaction mined successfully: reconcile and do not resend.
  {
    const pool = new JobPool();
    pool.job = { status: 'failed', attempts: 1, next_attempt_at: new Date(0), transaction_hash: `0xsuccess${round}`, error_code: 'TIMEOUT' };
    const provider = makeProvider({ receipt: { status: 1, blockNumber: 90 }, head: 100 });
    let sends = 0;
    const result = await runKeeperAction({ pool, provider, jobKey: 'job', label: 'settle', send: async () => { sends++; } });
    check(result && pool.job.status === 'confirmed' && sends === 0, `round ${round}: successful prior tx reconciles without duplicate send`);
  }

  // Still pending or not found at RPC: preserve the hash and never duplicate.
  for (const [state, provider] of [
    ['pending', makeProvider({ transaction: { hash: '0xpending' } })],
    ['unknown', makeProvider()]
  ]) {
    const pool = new JobPool();
    pool.job = { status: 'failed', attempts: 1, next_attempt_at: new Date(0), transaction_hash: `0x${state}${round}`, error_code: 'TIMEOUT' };
    let sends = 0;
    const result = await runKeeperAction({ pool, provider, jobKey: 'job', label: 'settle', send: async () => { sends++; } });
    check(!result && sends === 0 && pool.job.status === 'failed', `round ${round}: ${state} prior tx is not resent`);
  }

  // A mined revert is conclusive and can be retried after its backoff.
  {
    const pool = new JobPool();
    pool.job = { status: 'failed', attempts: 1, next_attempt_at: new Date(0), transaction_hash: `0xrevert${round}`, error_code: 'TIMEOUT' };
    const provider = makeProvider({ receipt: { status: 0, blockNumber: 99 }, head: 100 });
    let sends = 0;
    const result = await runKeeperAction({ pool, provider, jobKey: 'job', label: 'settle', send: async () => { sends++; return { hash: '0xretry', wait: async () => ({ status: 1, blockNumber: 101 }) }; } });
    check(result && sends === 1 && pool.job.status === 'confirmed', `round ${round}: mined revert allows one safe retry`);
  }

  // Crash after broadcasting but before persisting the hash: block automatic resend.
  {
    const pool = new JobPool();
    pool.job = { status: 'running', attempts: 1, next_attempt_at: new Date(0), transaction_hash: null, error_code: null };
    let sends = 0;
    const result = await runKeeperAction({ pool, provider: makeProvider(), jobKey: 'job', label: 'settle', send: async () => { sends++; } });
    check(!result && sends === 0 && pool.job.error_code === 'BROADCAST_OUTCOME_UNKNOWN', `round ${round}: running job without hash is held for reconciliation`);
  }

  // A shallow receipt is not treated as final; it is promoted when the requested depth arrives.
  {
    const pool = new JobPool();
    pool.job = { status: 'failed', attempts: 1, next_attempt_at: new Date(0), transaction_hash: `0xshallow${round}`, error_code: 'TIMEOUT' };
    const provider = makeProvider({ receipt: { status: 1, blockNumber: 100 }, head: 100 });
    let sends = 0;
    let result = await runKeeperAction({ pool, provider, jobKey: 'job', label: 'settle', confirmations: 3, send: async () => { sends++; } });
    check(!result && pool.job.error_code === 'WAITING_CONFIRMATIONS' && sends === 0, `round ${round}: shallow receipt waits for confirmation depth`);
    provider.head = 102;
    result = await runKeeperAction({ pool, provider, jobKey: 'job', label: 'settle', confirmations: 3, send: async () => { sends++; } });
    check(result && pool.job.status === 'confirmed' && sends === 0, `round ${round}: receipt confirms at configured depth`);
  }

  // A temporary RPC failure while reconciling never triggers a duplicate send.
  {
    const pool = new JobPool();
    pool.job = { status: 'failed', attempts: 1, next_attempt_at: new Date(0), transaction_hash: `0xrpcfail${round}`, error_code: 'TIMEOUT' };
    const provider = makeProvider();
    provider.failReceipt = true;
    let sends = 0;
    const result = await runKeeperAction({ pool, provider, jobKey: 'job', label: 'settle', send: async () => { sends++; }, errorCode: (error) => error.code });
    check(!result && sends === 0 && pool.job.error_code === 'ETIMEDOUT', `round ${round}: RPC outage defers reconciliation without resubmission`);
  }

  // If the chain confirms but the DB confirmation write fails, restart reconciles the saved hash.
  {
    const pool = new JobPool();
    pool.failConfirmedOnce = true;
    const provider = makeProvider({ receipt: { status: 1, blockNumber: 95 }, head: 100 });
    let sends = 0;
    const result = await runKeeperAction({
      pool, provider, jobKey: 'job', label: 'settle', send: async () => {
        sends++;
        return { hash: `0xdbwrite${round}`, wait: async () => ({ status: 1, blockNumber: 95 }) };
      }, errorCode: (error) => error.code
    });
    check(!result && pool.job.status === 'failed' && pool.job.transaction_hash === `0xdbwrite${round}`, `round ${round}: failed DB confirmation retains tx hash`);
    const recovered = await runKeeperAction({ pool, provider, jobKey: 'job', label: 'settle', send: async () => { sends++; } });
    check(recovered && pool.job.status === 'confirmed' && sends === 1, `round ${round}: restart reconciles mined tx without resending`);
  }
}

// Network timeout before an RPC returns a transaction hash is also ambiguous.
{
  const pool = new JobPool();
  let sends = 0;
  await runKeeperAction({ pool, provider: makeProvider(), jobKey: 'new-job', label: 'settle', send: async () => { sends++; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, errorCode: (error) => error.code });
  check(pool.job.error_code === 'BROADCAST_OUTCOME_UNKNOWN', 'broadcast timeout without hash is marked ambiguous');
  await runKeeperAction({ pool, provider: makeProvider(), jobKey: 'new-job', label: 'settle', send: async () => { sends++; } });
  check(sends === 1, 'ambiguous no-hash transaction is not automatically rebroadcast');
}

// The PostgreSQL clock decides whether a backoff has elapsed; keeper host clock is irrelevant.
{
  const pool = new JobPool();
  pool.job = { status: 'failed', attempts: 1, next_attempt_at: new Date(0), transaction_hash: null, error_code: 'RPC_ERROR', retry_due: false };
  let sends = 0;
  let result = await runKeeperAction({ pool, provider: makeProvider(), jobKey: 'db-clock', label: 'settle', send: async () => { sends++; } });
  check(!result && sends === 0, 'database says retry is not due, so skewed keeper clock cannot submit early');
  pool.job.retry_due = true;
  result = await runKeeperAction({ pool, provider: makeProvider(), jobKey: 'db-clock', label: 'settle', send: async () => { sends++; return { hash: '0xdbclock', wait: async () => ({ status: 1, blockNumber: 101 }) }; } });
  check(result && sends === 1 && pool.job.status === 'confirmed', 'database due flag allows the retry without reading keeper host time');
}

console.log(JSON.stringify({
  simulation: 'Keeper transaction receipt reconciliation and duplicate-broadcast fault injection',
  rounds: 20,
  scenariosPerRound: 10,
  assertions,
  passed: assertions,
  failed: 0
}, null, 2));
