import { findCommonCheckpoint } from '../src/indexer-reorg.mjs';

let assertions = 0;
function check(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  assertions++;
}

function providerWithCanonical(canonical) {
  return { async getBlock(number) { return canonical.has(number) ? { hash: canonical.get(number) } : null; } };
}

// A shallow reorg lands on the prior scan checkpoint.
check(await findCommonCheckpoint(providerWithCanonical(new Map([[100, '0xaaa'], [80, '0xbbb']])), [
  { blockNumber: 120, blockHash: '0xold' }, { blockNumber: 100, blockHash: '0xaaa' },
  { blockNumber: 80, blockHash: '0xbbb' }
], 50), 100, 'shallow reorg selects newest canonical checkpoint');

// A reorg deeper than the former fixed 24-block rewind must walk back to block 40.
check(await findCommonCheckpoint(providerWithCanonical(new Map([[40, '0xcommon'], [20, '0xolder']])), [
  { blockNumber: 1000, blockHash: '0xorphan-1000' }, { blockNumber: 500, blockHash: '0xorphan-500' },
  { blockNumber: 100, blockHash: '0xorphan-100' }, { blockNumber: 40, blockHash: '0xcommon' },
  { blockNumber: 20, blockHash: '0xolder' }
], 10), 40, 'deep reorg finds shared ancestor rather than fixed rewind');

// Legacy cursor-only databases have no historical checkpoints. The safe action is a full rescan.
check(await findCommonCheckpoint(providerWithCanonical(new Map()), [
  { blockNumber: 1000, blockHash: '0xold-cursor' }
], 250), 249, 'missing checkpoint history rewinds to deployment boundary');

// Provider gaps and checkpoints preceding deployment must not be treated as proof.
check(await findCommonCheckpoint(providerWithCanonical(new Map([[10, '0xold']])), [
  { blockNumber: 10, blockHash: '0xold' }
], 50), 49, 'pre-deployment block cannot become common checkpoint');

console.log(JSON.stringify({ simulation: 'indexer shallow/deep reorg recovery', assertions, passed: assertions, failed: 0 }, null, 2));
