import { ethers } from 'ethers';
import { loadConfig } from './config.mjs';
import { acquireAdvisoryLock, createPool, heartbeat, migrate } from './db.mjs';
import { gameAbi, freeDropAbi, managerAbi, oracleAbi, purchaseProcessorAbi } from './abis.mjs';
import { verifyChainAndContracts } from './chain.mjs';
import { errorCode, instanceId, instrumentRpc, log } from './logger.mjs';
import { runKeeperAction } from './keeper-action.mjs';
import { processRegisteredDeposit } from './purchase-deposit.mjs';
import { mapSettledLimit } from './map-settled-limit.mjs';
import { authorizeMismatchRefund, depositSenderMatches, unprocessedDepositTransfersSql } from './deposit-sender-gate.mjs';
import { isChainDeadlineReached, SYNTHESIS_TIMEOUT_SECONDS, VRF_RETRY_DELAY_SECONDS } from './keeper-time.mjs';

const config = loadConfig('keeper');
const pool = createPool(config.databaseUrl);
const endpoints = config.rpcUrls.map((url, index) => instrumentRpc(new ethers.JsonRpcProvider(url), `rpc-${index + 1}`));
const provider = new ethers.FallbackProvider(
  endpoints.map((rpc, index) => ({ provider: rpc, priority: index + 1, weight: 1, stallTimeout: 1500 })), 1
);
const keeperWallet = new ethers.Wallet(config.keeperPrivateKey, provider);
const signer = new ethers.NonceManager(keeperWallet);
const game = new ethers.Contract(config.contracts.game, gameAbi, signer);
const freeDrop = new ethers.Contract(config.contracts.freeDrop, freeDropAbi, signer);
const manager = new ethers.Contract(config.contracts.liquidityManager, managerAbi, signer);
const oracle = new ethers.Contract(config.contracts.liquidityManager, oracleAbi, signer);
const purchaseProcessor = config.contracts.purchaseProcessor
  ? new ethers.Contract(config.contracts.purchaseProcessor, purchaseProcessorAbi, signer)
  : null;
const BATCH_LIMIT = 50;
let stopping = false;
let activeCycle = Promise.resolve();
let lastOracleAttempt = 0;
let lastFreeDropBlockedNotice = 0;
let lastVrfBalanceNotice = 0;

const action = (jobKey, label, send) => runKeeperAction({
  pool,
  provider,
  jobKey,
  label,
  send,
  confirmations: config.keeperConfirmations,
  log,
  errorCode
});

async function paidRoundJobs(chainTimestamp) {
  const { rows } = await pool.query(
    `SELECT DISTINCT args->>'dayId' AS day_id FROM chain_events
     WHERE chain_id=$1 AND contract_address=$2 AND event_name='BoxesPurchased'
     ORDER BY day_id`, [config.chainId, config.contracts.game.toLowerCase()]
  );
  for (const row of rows) {
    const day = row.day_id;
    let round = await game.rounds(day);
    if (round.boxCount === 0n || round.finalized) continue;
    // requestDraw is guaranteed to revert before the on-chain Beijing-day cutoff.
    // Use the chain clock so host clock skew cannot trigger repeated failed jobs.
    if (chainTimestamp < Number(round.salesClose)) continue;

    const fulfilled = await game.roundRandomnessFulfilled(day);
    const retryElapsed = round.drawRequestedAt !== 0n &&
      isChainDeadlineReached(chainTimestamp, round.drawRequestedAt, VRF_RETRY_DELAY_SECONDS);
    if ((!round.drawRequested || (retryElapsed && !fulfilled)) && !round.randomnessLoaded) {
      const sent = await action(`paid:${day}:request:${round.drawRequestedAt.toString()}`, 'request_daily_draw', () => game.requestDraw(day));
      if (sent) continue;
    }

    if (!round.randomnessLoaded && await game.roundRandomnessFulfilled(day)) {
      const sent = await action(`paid:${day}:load`, 'load_daily_randomness', () => game.loadRandomness(day));
      if (sent) continue;
      round = await game.rounds(day);
    }

    if (round.randomnessLoaded && round.settledCount < round.boxCount) {
      const count = Math.min(BATCH_LIMIT, Number(round.boxCount - round.settledCount));
      const from = Number(round.settledCount);
      const sent = await action(`paid:${day}:settle:${from}`, 'settle_paid_boxes', () => game.settleBatch(day, from, count));
      if (sent) continue;
      round = await game.rounds(day);
    }

    if (!round.finalized && round.boxCount > 0n && round.settledCount === round.boxCount) {
      const sent = await action(`paid:${day}:finalize`, 'finalize_daily_draw', () => game.finalizeDraw(day));
      if (sent) continue;
      round = await game.rounds(day);
    }

    if (round.finalized && round.liquidityBudget >= 2n) {
      const pending = await manager.pendingBudget(day);
      const funded = await manager.roundFunded(day);
      if ((!funded || pending > 0n) && (!funded || pending >= 2n)) {
        await action(`paid:${day}:lp:${pending.toString()}`, 'process_liquidity_chunk', () => manager.processLiquidity(day));
      }
    }
  }
}

async function freeDropJobs(chainTimestamp) {
  const currentDay = await freeDrop.currentDayId();
  const { rows: days } = await pool.query(
    `SELECT args->>'dayId' AS day_id, count(*)::integer AS claims
     FROM chain_events WHERE chain_id=$1 AND contract_address=$2 AND event_name='FreeBoxClaimRegistered'
     GROUP BY args->>'dayId' ORDER BY (args->>'dayId')::numeric`,
    [config.chainId, config.contracts.freeDrop.toLowerCase()]
  );
  for (const item of days) {
    const day = item.day_id;
    if (BigInt(day) >= currentDay || Number(item.claims) === 0) continue;
    const fulfilled = await freeDrop.drawFulfilled(day);
    const requested = await freeDrop.drawRequested(day);
    const requestedAt = await freeDrop.drawRequestedAt(day);
    const retryElapsed = requestedAt !== 0n && isChainDeadlineReached(chainTimestamp, requestedAt, VRF_RETRY_DELAY_SECONDS);
    if (!fulfilled && (!requested || retryElapsed)) {
      const key = `free:${day}:request:${requestedAt.toString()}`;
      const sent = await action(key, 'request_free_drop_draw', () => freeDrop.requestDailyDraw(day));
      if (sent) continue;
    }
  }

  const total = await freeDrop.totalClaims();
  const settled = await freeDrop.totalSettled();
  if (settled >= total) return;
  const count = Math.min(BATCH_LIMIT, Number(total - settled));
  const { rows: queue } = await pool.query(
    `SELECT args->>'dayId' AS day_id FROM chain_events
     WHERE chain_id=$1 AND contract_address=$2 AND event_name='FreeBoxClaimRegistered'
       AND (args->>'queueIndex')::numeric >= $3
     ORDER BY (args->>'queueIndex')::numeric LIMIT $4`,
    [config.chainId, config.contracts.freeDrop.toLowerCase(), settled.toString(), count]
  );
  if (queue.length !== count) {
    log('warn', 'free_drop_indexer_behind', { indexed: queue.length, expected: count, settled: settled.toString() });
    return;
  }
  for (const day of new Set(queue.map((item) => item.day_id))) {
    if (!(await freeDrop.drawFulfilled(day))) {
      if (Date.now() - lastFreeDropBlockedNotice >= 5 * 60 * 1000) {
        lastFreeDropBlockedNotice = Date.now();
        log('warn', 'free_drop_settlement_waiting_for_vrf', {
          blockedDayId: day,
          settledIndex: settled.toString(),
          batchSize: count
        });
      }
      return;
    }
  }
  await action(`free:settle:${settled.toString()}`, 'settle_free_drop_batch', () => freeDrop.settleBatch(settled, count));
}

async function synthesisJobs(chainTimestamp) {
  const { rows } = await pool.query(
    `SELECT DISTINCT args->>'synthesisId' AS synthesis_id FROM chain_events
     WHERE chain_id=$1 AND contract_address=$2 AND event_name='SynthesisRequested'
     ORDER BY (args->>'synthesisId')::numeric`,
    [config.chainId, config.contracts.game.toLowerCase()]
  );
  for (const { synthesis_id: id } of rows) {
    const item = await game.syntheses(id);
    if (!item.owner || item.owner === ethers.ZeroAddress || item.completed || item.cancelled) continue;
    if (await game.forgeRandomnessFulfilled(id)) {
      await action(`synthesis:${id}:complete`, 'complete_synthesis', () => game.completeSynthesis(id));
    } else if (isChainDeadlineReached(chainTimestamp, item.requestedAt, SYNTHESIS_TIMEOUT_SECONDS)) {
      await action(`synthesis:${id}:cancel`, 'cancel_expired_synthesis', () => game.cancelExpiredSynthesis(id));
    }
  }
}

async function processDeposit(depositId, chainTimestamp) {
  if (!purchaseProcessor || !config.usdtAddress) return;
  return processRegisteredDeposit({ processor: purchaseProcessor, game, action, depositId, chainTimestamp });
}

async function depositJobs(chainTimestamp) {
  if (!purchaseProcessor || !config.contracts.purchaseProcessor || !config.usdtAddress) return;
  const processorAddress = config.contracts.purchaseProcessor.toLowerCase();
  const { rows: vaultRows } = await pool.query(
    `SELECT buyer_address AS buyer, referrer_address AS referrer, vault_address AS vault
     FROM purchase_vaults WHERE chain_id=$1 AND processor_address=$2 ORDER BY vault_address`,
    [config.chainId, processorAddress]
  );
  const vaultBindings = new Map(vaultRows.filter((row) => ethers.isAddress(row.vault) && ethers.isAddress(row.buyer) && ethers.isAddress(row.referrer))
    .map((row) => [row.vault.toLowerCase(), row]));
  const vaults = [...vaultBindings.keys()];
  if (vaults.length === 0) return;

  const { rows: transfers } = await pool.query(
    unprocessedDepositTransfersSql,
    [config.chainId, config.usdtAddress.toLowerCase(), vaults, config.contracts.purchaseProcessor.toLowerCase()]
  );
  const registrationResults = await mapSettledLimit(transfers, config.purchaseDepositConcurrency, async (transfer) => {
    const args = transfer.args;
    if (!args?.depositId || !ethers.isAddress(args.from) || !ethers.isAddress(args.to)) return 'ignored';
    const binding = vaultBindings.get(args.to.toLowerCase());
    if (!depositSenderMatches(args, binding)) {
      const authorized = await authorizeMismatchRefund({
        pool, processor: purchaseProcessor, action, depositId: args.depositId,
        buyer: binding?.buyer || ethers.ZeroAddress,
        referrer: binding?.referrer || ethers.ZeroAddress,
        sender: args.from, vault: args.to, amount: BigInt(args.value)
      });
      log('error', 'keeper_deposit_sender_mismatch', {
        transactionHash: transfer.transaction_hash,
        vault: args.to.toLowerCase(),
        expectedBuyer: binding?.buyer?.toLowerCase() || null,
        actualSender: args.from.toLowerCase(),
        refundAuthorization: authorized ? 'confirmed' : 'pending'
      });
      return 'sender_mismatch';
    }
    const id = args.depositId;
    await action(`purchase:register:${id}`, 'register_confirmed_usdt_deposit', () =>
      purchaseProcessor.registerDeposit(id, binding.buyer, binding.referrer, args.to, BigInt(args.value)));
    return processDeposit(id, chainTimestamp);
  });
  registrationResults.forEach((result, index) => {
    if (result.status === 'rejected') log('error', 'keeper_deposit_job_failed', {
      phase: 'register_or_settle', transactionHash: transfers[index]?.transaction_hash,
      errorCode: errorCode(result.reason)
    });
  });

  // Retry deposits already registered on chain even when the market was paused,
  // the daily cap was reached, or an earlier Keeper transaction reverted.
  const { rows: pending } = await pool.query(
    `SELECT e.args->>'depositId' AS deposit_id FROM chain_events e
     WHERE e.chain_id=$1 AND e.contract_address=$2 AND e.event_name='DepositRegistered'
       AND NOT EXISTS (
         SELECT 1 FROM chain_events terminal
         WHERE terminal.chain_id=e.chain_id AND terminal.contract_address=e.contract_address
           AND terminal.event_name IN ('DepositSettled','DepositRefunded')
           AND terminal.args->>'depositId'=e.args->>'depositId'
       )
     ORDER BY e.block_number,e.log_index LIMIT 100`,
    [config.chainId, processorAddress]
  );
  const settlementResults = await mapSettledLimit(pending, config.purchaseDepositConcurrency,
    (row) => processDeposit(row.deposit_id, chainTimestamp));
  settlementResults.forEach((result, index) => {
    if (result.status === 'rejected') log('error', 'keeper_deposit_job_failed', {
      phase: 'retry_settlement', depositId: pending[index]?.deposit_id,
      errorCode: errorCode(result.reason)
    });
  });
}

async function tick() {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) throw new Error('RPC_CHAIN_ID_MISMATCH');
  const latestBlock = await provider.getBlock('latest');
  if (!latestBlock) throw new Error('LATEST_BLOCK_UNAVAILABLE');
  const blockNumber = latestBlock.number;
  const chainTimestamp = Number(latestBlock.timestamp);
  const balance = await provider.getBalance(keeperWallet.address);
  const balanceBNB = Number(ethers.formatEther(balance));
  if (balanceBNB < config.minKeeperBNB) log('error', 'keeper_balance_low', { balanceBNB, minimumBNB: config.minKeeperBNB });

  await depositJobs(chainTimestamp);

  if (Date.now() - lastVrfBalanceNotice >= 5 * 60 * 1000) {
    lastVrfBalanceNotice = Date.now();
    const coordinatorAddress = await game.s_vrfCoordinator();
    const coordinator = new ethers.Contract(coordinatorAddress, [
      'function getSubscription(uint256) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)'
    ], provider);
    const subscription = await coordinator.getSubscription(config.vrfSubscriptionId);
    if (subscription.nativeBalance < config.minVrfNativeBalanceWei) {
      log('error', 'vrf_subscription_native_balance_low', {
        balanceBNB: ethers.formatEther(subscription.nativeBalance),
        minimumBNB: config.minVrfNativeBalanceBNB,
        subscriptionId: config.vrfSubscriptionId
      });
    }
  }

  await paidRoundJobs(chainTimestamp);
  await freeDropJobs(chainTimestamp);
  await synthesisJobs(chainTimestamp);

  const oracleIntervalSeconds = Number((await oracle.observationInterval()).toString());
  const oracleInterval = oracleIntervalSeconds * 1000;
  if (lastOracleAttempt === 0 || performance.now() - lastOracleAttempt > oracleInterval) {
    lastOracleAttempt = performance.now();
    const observationSlot = Math.floor(chainTimestamp / oracleIntervalSeconds);
    await action(`oracle:update:${observationSlot}`, 'refresh_price_observation', () => oracle.update());
  }
  await heartbeat(pool, 'keeper', instanceId, { chainId: config.chainId, blockNumber, balanceBNB });
}

await migrate(pool);
await verifyChainAndContracts(provider, config);
const [gameSubscriptionId, freeDropSubscriptionId] = await Promise.all([
  game.vrfSubscriptionId(), freeDrop.vrfSubscriptionId()
]);
if (gameSubscriptionId !== BigInt(config.vrfSubscriptionId) || freeDropSubscriptionId !== BigInt(config.vrfSubscriptionId)) {
  throw new Error('VRF_SUBSCRIPTION_CONFIG_MISMATCH');
}
if (purchaseProcessor) {
  const [processorKeeper, processorGame, processorUsdt] = await Promise.all([
    purchaseProcessor.keeper(), purchaseProcessor.game(), purchaseProcessor.usdtToken()
  ]);
  if (processorKeeper.toLowerCase() !== keeperWallet.address.toLowerCase()) throw new Error('PURCHASE_PROCESSOR_KEEPER_KEY_MISMATCH');
  if (processorGame.toLowerCase() !== config.contracts.game.toLowerCase()) throw new Error('PURCHASE_PROCESSOR_GAME_MISMATCH');
  if (processorUsdt.toLowerCase() !== config.usdtAddress.toLowerCase()) throw new Error('PURCHASE_PROCESSOR_USDT_MISMATCH');
}
let lockClient;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', 'keeper_shutdown', { signal });
  await activeCycle.catch(() => {});
  try { await lockClient?.query('SELECT pg_advisory_unlock($1,$2)', [config.chainId, 2]); } catch {}
  lockClient?.release();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

while (!stopping && !lockClient) {
  lockClient = await acquireAdvisoryLock(pool, config.chainId, 2);
  if (!lockClient) {
    await heartbeat(pool, 'keeper-standby', instanceId, { chainId: config.chainId });
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
if (stopping) process.exit(0);
log('info', 'keeper_started', { chainId: config.chainId, keeperAddress: keeperWallet.address });
while (!stopping) {
  try {
    // Advisory locks are scoped to their PostgreSQL session. Verify this exact
    // session before doing work so a dropped connection cannot create two keepers.
    await lockClient.query('SELECT 1');
  } catch (error) {
    log('fatal', 'keeper_advisory_lock_lost', { errorCode: errorCode(error) });
    process.exit(1);
  }
  activeCycle = tick();
  try { await activeCycle; }
  catch (error) { log('error', 'keeper_cycle_failed', { errorCode: errorCode(error) }); }
  await new Promise((resolve) => setTimeout(resolve, config.keeperIntervalMs));
}
