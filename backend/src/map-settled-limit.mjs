/** Run independent jobs with bounded concurrency while preserving each result. */
export async function mapSettledLimit(items, concurrency, action) {
  if (!Array.isArray(items) || !Number.isSafeInteger(concurrency) || concurrency < 1 || typeof action !== 'function') {
    throw new TypeError('MAP_SETTLED_LIMIT_ARGUMENTS_INVALID');
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await action(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}
