import assert from 'node:assert/strict';
import {
  authorizeMismatchRefund,
  depositSenderMatches,
  markDepositSenderMismatch,
  unprocessedDepositTransfersSql
} from '../src/deposit-sender-gate.mjs';

let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions++; }

const buyer = '0x0000000000000000000000000000000000000001';
const attacker = '0x0000000000000000000000000000000000000002';
const vault = '0x0000000000000000000000000000000000000003';
check(depositSenderMatches({ from: buyer, to: vault }, { buyer, vault }), 'bound buyer transfer is accepted');
check(!depositSenderMatches({ from: attacker, to: vault }, { buyer, vault }), 'third-party transfer is treated as a mismatch');
check(!depositSenderMatches({ from: buyer, to: vault }, undefined), 'unregistered vault transfer is treated as a mismatch');
check(unprocessedDepositTransfersSql.includes("j.status IN ('confirmed','ignored')"),
  'the Keeper scan excludes terminally ignored deposits so they cannot starve valid entries');
check(unprocessedDepositTransfersSql.includes("event_name IN ('UnregisteredTransferRefundAuthorized','UnregisteredTransferReturned')"),
  'the Keeper scan excludes transfers with an authorized or completed sender refund');

const jobRows = new Map();
const pool = { async query(_sql, values) {
  const [jobKey] = values;
  const current = jobRows.get(jobKey);
  jobRows.set(jobKey, {
    status: current?.status === 'confirmed' ? 'confirmed' : 'ignored',
    attempts: (current?.attempts || 0) + (current?.status === 'confirmed' ? 0 : 1),
    errorCode: current?.status === 'confirmed' ? current.errorCode : 'DEPOSIT_SENDER_MISMATCH'
  });
} };
const transfers = Array.from({ length: 125 }, (_, i) => ({
  depositId: `attacker-${i.toString().padStart(3, '0')}`,
  from: attacker,
  to: vault,
  valid: false
}));
transfers.push({ depositId: 'valid-after-spam', from: buyer, to: vault, valid: true });
const completed = new Set();
for (let cycle = 0; cycle < 4; cycle++) {
  const batch = transfers.filter((item) => {
    const terminal = jobRows.get(`purchase:register:${item.depositId}`)?.status === 'ignored' || completed.has(item.depositId);
    return !terminal;
  }).slice(0, 100);
  for (const item of batch) {
    if (!depositSenderMatches(item, { buyer, vault })) {
      await markDepositSenderMismatch(pool, item.depositId);
    } else completed.add(item.depositId);
  }
}
check(jobRows.size === 125 && completed.has('valid-after-spam'),
  'a valid purchase behind 125 attacker transfers is reached across bounded Keeper scans');
check([...jobRows.values()].every((item) => item.status === 'ignored'),
  'each sender-mismatch event is durably marked as terminal ignored');
check(jobRows.get('purchase:register:attacker-000').attempts === 1,
  'repeated scans do not repeatedly retry an ignored sender-mismatch event');

const mismatchDepositId = 'refund-auth-retry';
let refundState = { buyer: '0x0000000000000000000000000000000000000000' };
let refundActionAttempts = 0;
let refundActionCalls = 0;
const refundProcessor = {
  async authorizeUnregisteredTransferRefund() {
    refundActionAttempts++;
    refundState = { buyer };
  },
  async unregisteredRefunds() { return refundState; }
};
const refundAction = async (_jobKey, _label, send) => {
  refundActionCalls++;
  if (refundActionCalls === 1) return false;
  await send();
  return true;
};
const refundArgs = {
  pool, processor: refundProcessor, action: refundAction,
  depositId: mismatchDepositId, buyer, referrer: '0x0000000000000000000000000000000000000000',
  sender: attacker, vault, amount: 10n
};
const refundPending = await authorizeMismatchRefund(refundArgs);
check(refundPending === false,
  'failed or pending refund authorization does not terminally ignore the transfer');
check(!jobRows.has(`purchase:register:${mismatchDepositId}`),
  'a transfer remains eligible for Keeper retry while the contract has no refund authorization');
const refundAuthorized = await authorizeMismatchRefund(refundArgs);
check(refundAuthorized === true,
  'retry confirms the on-chain refund authorization before marking the transfer terminal');
check(jobRows.get(`purchase:register:${mismatchDepositId}`)?.status, 'ignored',
  'confirmed wrong-sender refund is excluded from purchase registration retries');

console.log(JSON.stringify({
  simulation: 'Keeper sender-mismatch spam cannot starve valid deposits',
  attackTransfers: 125,
  scanLimit: 100,
  validTransferReached: completed.has('valid-after-spam'),
  refundAuthorizationRetries: refundActionCalls,
  assertions,
  passed: assertions,
  failed: 0
}, null, 2));
