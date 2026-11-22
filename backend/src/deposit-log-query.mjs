import { ethers } from 'ethers';

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const RATE_LIMIT_PATTERN = /\b(rate.?limit|too many requests|http\s*429|status\s*429|quota)\b/i;
const QUERY_LIMIT_PATTERN = /(?:\b(?:query|log|response|result|block\s*range|topic(?:s)?)\b.{0,48}\b(?:limit|too many|more than|exceed|maximum|large|wide)\b)|(?:\b(?:limit|too many|more than|exceed|maximum|large|wide)\b.{0,48}\b(?:query|log|response|result|block\s*range|topic(?:s)?)\b)/i;
const RPC_LIMIT_CODES = new Set([-32005]);

function errorDetails(error, seen = new Set()) {
  if (!error || (typeof error !== 'object' && typeof error !== 'string') || seen.has(error)) return [];
  if (typeof error === 'string') return [error];
  seen.add(error);
  const values = [error.message, error.shortMessage, error.reason, error.code]
    .filter((value) => value !== undefined && value !== null)
    .map(String);
  for (const key of ['error', 'info', 'cause', 'data', 'response']) {
    if (error[key]) values.push(...errorDetails(error[key], seen));
  }
  return values;
}

export function isSplittableLogQueryError(error) {
  const details = errorDetails(error);
  const message = details.join(' ');
  if (RATE_LIMIT_PATTERN.test(message)) return false;
  const rpcCodes = details.map((value) => Number(value)).filter(Number.isInteger);
  return rpcCodes.some((code) => RPC_LIMIT_CODES.has(code)) || QUERY_LIMIT_PATTERN.test(message);
}

export function chunkDepositVaults(vaults, batchSize) {
  if (!Array.isArray(vaults)) throw new Error('DEPOSIT_VAULTS_MUST_BE_AN_ARRAY');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('INVALID_DEPOSIT_LOG_RECIPIENT_BATCH_SIZE');
  const batches = [];
  for (let index = 0; index < vaults.length; index += batchSize) batches.push(vaults.slice(index, index + batchSize));
  return batches;
}

/**
 * Retry eth_getLogs only for range/topic/result-size limits. Endpoint failures,
 * disabled methods, authentication errors, and rate limits fail immediately;
 * recursively splitting those errors can otherwise fan one outage into
 * thousands of RPC calls.
 */
export async function fetchDepositLogs(provider, usdtAddress, fromBlock, toBlock, vaults, { maxAttempts = 128 } = {}) {
  if (!Array.isArray(vaults) || vaults.length === 0) return [];
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('INVALID_LOG_QUERY_ATTEMPT_LIMIT');
  const state = { attempts: 0 };

  async function query(from, to, recipients) {
    if (state.attempts >= maxAttempts) throw new Error('LOG_QUERY_SPLIT_BUDGET_EXCEEDED');
    state.attempts++;
    try {
      return await provider.getLogs({
        address: usdtAddress,
        fromBlock: from,
        toBlock: to,
        topics: [TRANSFER_TOPIC, null, recipients.map((vault) => ethers.zeroPadValue(vault, 32))]
      });
    } catch (error) {
      if (!isSplittableLogQueryError(error)) throw error;
      if (from < to) {
        const mid = Math.floor((from + to) / 2);
        const left = await query(from, mid, recipients);
        const right = await query(mid + 1, to, recipients);
        return [...left, ...right];
      }
      if (recipients.length > 1) {
        const mid = Math.ceil(recipients.length / 2);
        const left = await query(from, to, recipients.slice(0, mid));
        const right = await query(from, to, recipients.slice(mid));
        return [...left, ...right];
      }
      throw error;
    }
  }

  return query(fromBlock, toBlock, vaults);
}
