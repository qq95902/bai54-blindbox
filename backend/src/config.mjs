import fs from 'node:fs';
import { isIP } from 'node:net';
import { ethers } from 'ethers';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment setting: ${name}`);
  return value;
};

const address = (name) => {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be a valid EVM address`);
  return ethers.getAddress(value);
};

export function loadConfig(role) {
  const urls = required('BSC_RPC_URLS').split(',').map((v) => v.trim()).filter(Boolean);
  if (urls.length < 2) throw new Error('BSC_RPC_URLS must contain two independent RPC endpoints');
  const chainId = Number(process.env.BSC_CHAIN_ID || 56);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('BSC_CHAIN_ID is invalid');

  const config = {
    role,
    port: Number(process.env.PORT || 8080),
    databaseUrl: required('DATABASE_URL'),
    chainId,
    rpcUrls: urls,
    contracts: {
      game: address('GAME_ADDRESS'),
      freeDrop: address('FREE_DROP_ADDRESS'),
      liquidityManager: address('LIQUIDITY_MANAGER_ADDRESS')
    },
    usdtAddress: process.env.USDT_ADDRESS?.trim() ? address('USDT_ADDRESS') : null,
    deploymentBlock: Number(process.env.DEPLOYMENT_BLOCK || 0),
    deploymentBlocks: {
      game: Number(process.env.GAME_DEPLOYMENT_BLOCK || process.env.DEPLOYMENT_BLOCK || 0),
      freeDrop: Number(process.env.FREE_DROP_DEPLOYMENT_BLOCK || process.env.DEPLOYMENT_BLOCK || 0),
      liquidityManager: Number(process.env.LIQUIDITY_MANAGER_DEPLOYMENT_BLOCK || process.env.DEPLOYMENT_BLOCK || 0)
    },
    confirmations: Number(process.env.INDEXER_CONFIRMATIONS || 12),
    blockRange: Number(process.env.INDEXER_BLOCK_RANGE || 1000),
    depositLogRecipientBatchSize: Number(process.env.DEPOSIT_LOG_RECIPIENT_BATCH_SIZE || 500),
    keeperIntervalMs: Number(process.env.KEEPER_INTERVAL_MS || 15000),
    keeperConfirmations: Number(process.env.KEEPER_CONFIRMATIONS || 3),
    purchaseDepositConcurrency: Number(process.env.PURCHASE_DEPOSIT_CONCURRENCY || 25),
    minKeeperBNB: Number(process.env.KEEPER_MIN_BNB_BALANCE || 0.05),
    minVrfNativeBalanceBNB: process.env.VRF_MIN_NATIVE_BALANCE_BNB || '0.5',
    metricsToken: process.env.METRICS_BEARER_TOKEN || ''
  };
  if (process.env.PURCHASE_PROCESSOR_ADDRESS?.trim()) {
    config.contracts.purchaseProcessor = address('PURCHASE_PROCESSOR_ADDRESS');
    config.deploymentBlocks.purchaseProcessor = Number(
      process.env.PURCHASE_PROCESSOR_DEPLOYMENT_BLOCK || process.env.DEPLOYMENT_BLOCK || 0
    );
    if (!config.usdtAddress) throw new Error('USDT_ADDRESS is required when PURCHASE_PROCESSOR_ADDRESS is configured');
  }
  config.trustedProxyIps = (process.env.TRUSTED_PROXY_IPS || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (config.trustedProxyIps.some((ip) => !isIP(ip.replace(/^::ffff:/i, '')))) {
    throw new Error('TRUSTED_PROXY_IPS must contain comma-separated proxy IP addresses');
  }

  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT is invalid');
  if (!Number.isSafeInteger(config.deploymentBlock) || config.deploymentBlock < 0) throw new Error('DEPLOYMENT_BLOCK is invalid');
  for (const [name, block] of Object.entries(config.deploymentBlocks)) {
    if (!Number.isSafeInteger(block) || block < 0) throw new Error(`${name.toUpperCase()}_DEPLOYMENT_BLOCK is invalid`);
  }
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 1) throw new Error('INDEXER_CONFIRMATIONS is invalid');
  if (!Number.isSafeInteger(config.blockRange) || config.blockRange < 1 || config.blockRange > 5000) throw new Error('INDEXER_BLOCK_RANGE must be 1..5000');
  if (!Number.isSafeInteger(config.depositLogRecipientBatchSize) || config.depositLogRecipientBatchSize < 1 || config.depositLogRecipientBatchSize > 1000) {
    throw new Error('DEPOSIT_LOG_RECIPIENT_BATCH_SIZE must be 1..1000');
  }
  if (!Number.isSafeInteger(config.purchaseDepositConcurrency) || config.purchaseDepositConcurrency < 1 || config.purchaseDepositConcurrency > 50) {
    throw new Error('PURCHASE_DEPOSIT_CONCURRENCY must be 1..50');
  }

  if (role === 'keeper') {
    const keyPath = required('KEEPER_PRIVATE_KEY_FILE');
    config.keeperPrivateKey = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.keeperPrivateKey)) throw new Error('Keeper key file is malformed');
    config.vrfSubscriptionId = required('VRF_SUBSCRIPTION_ID');
    if (!/^\d+$/.test(config.vrfSubscriptionId) || BigInt(config.vrfSubscriptionId) === 0n) {
      throw new Error('VRF_SUBSCRIPTION_ID must be a positive integer');
    }
    if (!/^\d+(\.\d{1,18})?$/.test(config.minVrfNativeBalanceBNB)) {
      throw new Error('VRF_MIN_NATIVE_BALANCE_BNB must be a positive decimal amount with at most 18 places');
    }
    config.minVrfNativeBalanceWei = ethers.parseEther(config.minVrfNativeBalanceBNB);
    if (config.minVrfNativeBalanceWei <= 0n) throw new Error('VRF_MIN_NATIVE_BALANCE_BNB must be greater than zero');
  }
  return config;
}
