export async function verifyChainAndContracts(provider, config) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) throw new Error('RPC_CHAIN_ID_MISMATCH');
  for (const [name, address] of Object.entries(config.contracts)) {
    const code = await provider.getCode(address);
    if (!code || code === '0x') throw new Error(`CONTRACT_CODE_MISSING_${name.toUpperCase()}`);
  }
  if (config.contracts.purchaseProcessor && config.usdtAddress) {
    const code = await provider.getCode(config.usdtAddress);
    if (!code || code === '0x') throw new Error('CONTRACT_CODE_MISSING_USDT_TOKEN');
  }
}
