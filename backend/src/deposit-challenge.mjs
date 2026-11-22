import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ethers } from 'ethers';

export const DEPOSIT_CHALLENGE_TTL_MS = 5 * 60_000;

function canonicalMessage(payload) {
  const issuedAt = new Date(payload.issuedAt).toISOString();
  const expiresAt = new Date(payload.issuedAt + DEPOSIT_CHALLENGE_TTL_MS).toISOString();
  return [
    'BAI Blind Box',
    'Action: Create a buyer-bound USDT deposit address',
    `Origin: ${payload.origin}`,
    `Buyer: ${ethers.getAddress(payload.buyer)}`,
    `Referrer: ${ethers.getAddress(payload.referrer)}`,
    `Chain ID: ${payload.chainId}`,
    `Nonce: ${payload.nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`
  ].join('\n');
}

export function issueDepositChallenge({ secret, chainId, buyer, referrer, origin, now = Date.now() }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('DEPOSIT_CHALLENGE_SECRET_INVALID');
  const payload = {
    version: 1,
    issuedAt: now,
    nonce: randomBytes(32).toString('hex'),
    chainId,
    buyer: ethers.getAddress(buyer),
    referrer: ethers.getAddress(referrer),
    origin
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(encoded).digest('hex');
  const challengeId = `${encoded}.${mac}`;
  return {
    challengeId,
    message: canonicalMessage(payload),
    expiresAt: new Date(now + DEPOSIT_CHALLENGE_TTL_MS).toISOString(),
    chainId
  };
}

export function verifyDepositChallenge({ secret, challengeId, chainId, buyer, referrer, origin, now = Date.now() }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || typeof challengeId !== 'string' || challengeId.length > 2048) return null;
  const separator = challengeId.lastIndexOf('.');
  if (separator < 1) return null;
  const encoded = challengeId.slice(0, separator);
  const suppliedMac = challengeId.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[0-9a-f]{64}$/i.test(suppliedMac)) return null;
  const expectedMac = createHmac('sha256', secret).update(encoded).digest();
  const actualMac = Buffer.from(suppliedMac, 'hex');
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { return null; }
  if (payload?.version !== 1 || !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.chainId) || payload.chainId !== chainId ||
      typeof payload.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(payload.nonce) ||
      typeof payload.origin !== 'string' || typeof payload.buyer !== 'string' || typeof payload.referrer !== 'string') return null;
  if (payload.issuedAt > now + 30_000 || payload.issuedAt + DEPOSIT_CHALLENGE_TTL_MS <= now) return null;
  let normalizedBuyer;
  let normalizedReferrer;
  try {
    normalizedBuyer = ethers.getAddress(payload.buyer);
    normalizedReferrer = ethers.getAddress(payload.referrer);
  } catch { return null; }
  if (normalizedBuyer.toLowerCase() !== buyer.toLowerCase() ||
      normalizedReferrer.toLowerCase() !== referrer.toLowerCase() || payload.origin !== origin) return null;
  let message;
  try { message = canonicalMessage(payload); }
  catch { return null; }
  return {
    payload,
    message,
    expiresAt: new Date(payload.issuedAt + DEPOSIT_CHALLENGE_TTL_MS).toISOString(),
    challengeKey: createHash('sha256').update(challengeId).digest('hex')
  };
}
