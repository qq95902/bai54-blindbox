/**
 * Find the newest saved scan checkpoint that is still on the provider's
 * canonical chain. Checkpoints must be ordered newest first.
 */
export async function findCommonCheckpoint(provider, checkpoints, deploymentBlock) {
  const floor = Math.max(0, Number(deploymentBlock) - 1);
  for (const checkpoint of checkpoints) {
    const blockNumber = Number(checkpoint.blockNumber ?? checkpoint.block_number);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < floor) continue;
    const block = await provider.getBlock(blockNumber);
    if (block?.hash && checkpoint.blockHash &&
        block.hash.toLowerCase() === checkpoint.blockHash.toLowerCase()) {
      return blockNumber;
    }
  }
  // No matching checkpoint means we cannot prove any part of the indexed
  // history is canonical. Rebuild from the deployment boundary, not a guessed
  // fixed-depth rewind.
  return floor;
}
