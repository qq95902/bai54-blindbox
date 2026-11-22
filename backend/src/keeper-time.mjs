const DAY_SECONDS = 24 * 60 * 60;

/** Compare deadlines using the timestamp read from a BSC block, never the VM clock. */
export function isChainDeadlineReached(chainTimestamp, requestedAt, delaySeconds) {
  const now = BigInt(chainTimestamp);
  const start = BigInt(requestedAt);
  const delay = BigInt(delaySeconds);
  if (now < 0n || start < 0n || delay < 0n) throw new RangeError('Chain timestamps and delays must be non-negative');
  return now >= start + delay;
}

export const VRF_RETRY_DELAY_SECONDS = DAY_SECONDS;
export const SYNTHESIS_TIMEOUT_SECONDS = 7 * DAY_SECONDS;
