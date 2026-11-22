import { ethers } from 'ethers';
import { loadConfig } from './config.mjs';
import { acquireAdvisoryLock, createPool, heartbeat, migrate } from './db.mjs';
import { eventAbis } from './abis.mjs';
import { verifyChainAndContracts } from './chain.mjs';
import { findCommonCheckpoint } from './indexer-reorg.mjs';
import { chunkDepositVaults, fetchDepositLogs } from './deposit-log-query.mjs';
import { errorCode, instanceId, instrumentRpc, log } from './logger.mjs';

const config = loadConfig('indexer');
const pool = createPool(config.databaseUrl);
const endpoints = config.rpcUrls.map((url, index) => instrumentRpc(new ethers.JsonRpcProvider(url), `rpc-${index + 1}`));
const contracts = [
  ['game', config.contracts.game],
  ['freeDrop', config.contracts.freeDrop],
  ['liquidityManager', config.contracts.liquidityManager],
  ...(config.contracts.purchaseProcessor ? [['purchaseProcessor', config.contracts.purchaseProcessor]] : [])
].map(([name, address]) => ({
  name, address: address.toLowerCase(), deploymentBlock: config.deploymentBlocks[name],
  iface: new ethers.Interface(eventAbis[name])
}));
const confirmations = config.confirmations;
const maxRange = config.blockRange;
let stopping = false;
let activeCycle = Promise.resolve();

async function getHealthyProvider() {
  let lastError;
  for (const provider of endpoints) {
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== config.chainId) throw new Error('RPC_CHAIN_ID_MISMATCH');
      await provider.getBlockNumber();
      return provider;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('RPC_UNAVAILABLE');
}

function normalizedArgs(parsed) {
  const output = {};
  parsed.fragment.inputs.forEach((input, index) => {
    const value = parsed.args[index];
    output[input.name || String(index)] = typeof value === 'bigint' ? value.toString()
      : (typeof value === 'string' && ethers.isAddress(value) ? value.toLowerCase() : value);
  });
  return output;
}

async function knownDepositVaults() {
  if (!config.contracts.purchaseProcessor) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT vault_address AS vault FROM purchase_vaults
     WHERE chain_id=$1 AND processor_address=$2 ORDER BY vault_address`,
    [config.chainId, config.contracts.purchaseProcessor.toLowerCase()]
  );
  return rows.map(({ vault }) => vault).filter((vault) => ethers.isAddress(vault));
}

async function indexDepositTransfers(provider, safeHead) {
  if (!config.contracts.purchaseProcessor || !config.usdtAddress) return;
  const vaults = await knownDepositVaults();
  if (!vaults.length) return;
  const tracker = {
    name: 'depositTransfers',
    address: config.usdtAddress.toLowerCase(),
    deploymentBlock: config.deploymentBlocks.purchaseProcessor
  };
  let cursor = await cursorFor(tracker.address);
  await rewindIfNeeded(provider, tracker, cursor);
  cursor = await cursorFor(tracker.address);
  let fromBlock = cursor ? Number(cursor.block_number) + 1 : tracker.deploymentBlock;
  const iface = new ethers.Interface(eventAbis.usdt);
  while (!stopping && fromBlock <= safeHead) {
    const toBlock = Math.min(safeHead, fromBlock + maxRange - 1);
    const logs = [];
    for (const recipients of chunkDepositVaults(vaults, config.depositLogRecipientBatchSize)) {
      logs.push(...await fetchDepositLogs(provider, config.usdtAddress, fromBlock, toBlock, recipients));
    }
    const block = await provider.getBlock(toBlock);
    if (!block?.hash) throw new Error('RPC_BLOCK_UNAVAILABLE');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const raw of logs) {
        const parsed = iface.parseLog(raw);
        if (!parsed) continue;
        const args = normalizedArgs(parsed);
        const logIndex = raw.index ?? raw.logIndex;
        args.depositId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint256'], [raw.transactionHash, logIndex]
        ));
        await client.query(
          `INSERT INTO chain_events(chain_id, contract_address, block_number, block_hash, transaction_index,
             transaction_hash, log_index, event_name, args)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
             contract_address=EXCLUDED.contract_address, block_number=EXCLUDED.block_number,
             block_hash=EXCLUDED.block_hash, transaction_index=EXCLUDED.transaction_index,
             event_name=EXCLUDED.event_name, args=EXCLUDED.args`,
          [config.chainId, tracker.address, raw.blockNumber, raw.blockHash, raw.transactionIndex,
            raw.transactionHash.toLowerCase(), logIndex, parsed.name, JSON.stringify(args)]
        );
      }
      await client.query(
        `INSERT INTO indexer_cursors(chain_id, contract_address, block_number, block_hash, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (chain_id, contract_address) DO UPDATE SET
           block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, updated_at=now()`,
        [config.chainId, tracker.address, toBlock, block.hash]
      );
      await client.query(
        `INSERT INTO indexer_block_checkpoints(chain_id, contract_address, block_number, block_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (chain_id, contract_address, block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash`,
        [config.chainId, tracker.address, toBlock, block.hash]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    fromBlock = toBlock + 1;
  }
}

async function cursorFor(address) {
  const result = await pool.query(
    'SELECT block_number, block_hash FROM indexer_cursors WHERE chain_id = $1 AND contract_address = $2',
    [config.chainId, address]
  );
  return result.rows[0] || null;
}

async function rewindIfNeeded(provider, contract, cursor) {
  if (!cursor) return;
  const canonical = await provider.getBlock(Number(cursor.block_number));
  if (!canonical || canonical.hash?.toLowerCase() === cursor.block_hash.toLowerCase()) return;

  const { rows: checkpoints } = await pool.query(
    `SELECT block_number, block_hash FROM indexer_block_checkpoints
     WHERE chain_id=$1 AND contract_address=$2 AND block_number <= $3
     ORDER BY block_number DESC`,
    [config.chainId, contract.address, cursor.block_number]
  );
  const rewindTo = await findCommonCheckpoint(provider, checkpoints, contract.deploymentBlock);
  const rewindBlock = rewindTo >= 0 ? await provider.getBlock(rewindTo) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM chain_events WHERE chain_id = $1 AND contract_address = $2 AND block_number > $3',
      [config.chainId, contract.address, rewindTo]
    );
    await client.query(
      'DELETE FROM indexer_block_checkpoints WHERE chain_id=$1 AND contract_address=$2 AND block_number > $3',
      [config.chainId, contract.address, rewindTo]
    );
    if (rewindBlock) {
      await client.query(
        `INSERT INTO indexer_cursors(chain_id, contract_address, block_number, block_hash, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (chain_id, contract_address) DO UPDATE SET
           block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, updated_at = now()`,
        [config.chainId, contract.address, rewindTo, rewindBlock.hash]
      );
    } else {
      await client.query('DELETE FROM indexer_cursors WHERE chain_id = $1 AND contract_address = $2', [config.chainId, contract.address]);
    }
    if (rewindBlock) {
      await client.query(
        `INSERT INTO indexer_block_checkpoints(chain_id, contract_address, block_number, block_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (chain_id, contract_address, block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash`,
        [config.chainId, contract.address, rewindTo, rewindBlock.hash]
      );
    }
    await client.query('COMMIT');
    log('warn', 'chain_reorg_rewind', { contract: contract.name, rewindTo });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function indexContract(provider, contract, safeHead) {
  let cursor = await cursorFor(contract.address);
  await rewindIfNeeded(provider, contract, cursor);
  cursor = await cursorFor(contract.address);
  let fromBlock = cursor ? Number(cursor.block_number) + 1 : contract.deploymentBlock;
  if (fromBlock > safeHead) return;

  while (!stopping && fromBlock <= safeHead) {
    const toBlock = Math.min(safeHead, fromBlock + maxRange - 1);
    const logs = await provider.getLogs({
      address: contract.address,
      fromBlock,
      toBlock,
      topics: [contract.iface.fragments.filter((fragment) => fragment.type === 'event')
        .map((fragment) => contract.iface.getEvent(fragment.format()).topicHash)]
    });
    const block = await provider.getBlock(toBlock);
    if (!block?.hash) throw new Error('RPC_BLOCK_UNAVAILABLE');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const raw of logs) {
        let parsed;
        try { parsed = contract.iface.parseLog(raw); } catch { continue; }
        const args = normalizedArgs(parsed);
        await client.query(
          `INSERT INTO chain_events(chain_id, contract_address, block_number, block_hash, transaction_index,
             transaction_hash, log_index, event_name, args)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
             contract_address = EXCLUDED.contract_address,
             block_number = EXCLUDED.block_number,
             block_hash = EXCLUDED.block_hash,
             transaction_index = EXCLUDED.transaction_index,
             event_name = EXCLUDED.event_name,
             args = EXCLUDED.args`,
          [config.chainId, contract.address, raw.blockNumber, raw.blockHash, raw.transactionIndex,
          raw.transactionHash.toLowerCase(), raw.index ?? raw.logIndex, parsed.name, JSON.stringify(args)]
        );
      }
      await client.query(
        `INSERT INTO indexer_cursors(chain_id, contract_address, block_number, block_hash, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (chain_id, contract_address) DO UPDATE SET
           block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, updated_at = now()`,
        [config.chainId, contract.address, toBlock, block.hash]
      );
      await client.query(
        `INSERT INTO indexer_block_checkpoints(chain_id, contract_address, block_number, block_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (chain_id, contract_address, block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash`,
        [config.chainId, contract.address, toBlock, block.hash]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    fromBlock = toBlock + 1;
  }
}

async function tick(provider) {
  const latest = await provider.getBlockNumber();
  const safeHead = latest - confirmations;
  if (safeHead < Math.min(...contracts.map((contract) => contract.deploymentBlock))) return;
  for (const contract of contracts) await indexContract(provider, contract, safeHead);
  await indexDepositTransfers(provider, safeHead);
  await heartbeat(pool, 'indexer', instanceId, { chainId: config.chainId, safeHead });
  log('info', 'indexer_checkpoint', { chainId: config.chainId, safeHead, contracts: contracts.length });
}

await migrate(pool);
await verifyChainAndContracts(await getHealthyProvider(), config);
let lockClient;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', 'indexer_shutdown', { signal });
  await activeCycle.catch(() => {});
  try { await lockClient?.query('SELECT pg_advisory_unlock($1,$2)', [config.chainId, 1]); } catch {}
  lockClient?.release();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

while (!stopping && !lockClient) {
  lockClient = await acquireAdvisoryLock(pool, config.chainId, 1);
  if (!lockClient) {
    await heartbeat(pool, 'indexer-standby', instanceId, { chainId: config.chainId });
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
if (stopping) process.exit(0);
log('info', 'indexer_started', { chainId: config.chainId, deploymentBlocks: config.deploymentBlocks });
while (!stopping) {
  try {
    // The lock belongs to this dedicated connection, not to the pool in general.
    await lockClient.query('SELECT 1');
  } catch (error) {
    log('fatal', 'indexer_advisory_lock_lost', { errorCode: errorCode(error) });
    process.exit(1);
  }
  try {
    const provider = await getHealthyProvider();
    if (stopping) break;
    activeCycle = tick(provider);
    await activeCycle;
  } catch (error) { log('error', 'indexer_cycle_failed', { errorCode: errorCode(error) }); }
  await new Promise((resolve) => setTimeout(resolve, 12000));
}
