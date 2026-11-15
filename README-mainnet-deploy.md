# BAI BSC mainnet deployment

This runbook covers the on-chain contracts and the initial PancakeSwap V2 pool. It does not provision the API/database host, DNS, TLS, or a production keeper host.

## Required before running the deploy command

- Node.js 22 and npm.
- A dedicated BSC mainnet deployer key stored in a file outside this repository. The deployer must own the Chainlink VRF v2.5 subscription and be the LP beneficiary. The script reads that file and never prints the key.
- A funded VRF v2.5 subscription configured for native BNB payments.
- BSC-USD on BNB Smart Chain, the PancakeSwap V2 router, and the Chainlink BNB mainnet VRF coordinator configured below.
- BNB for deployment, approvals, pair creation, adding liquidity, LP locking, and future VRF requests.
- Initial BSC-USD liquidity and a minimum accepted pool value selected by the project owner.
- A production keeper with a persistent scheduler and monitoring. The oracle needs hourly observations across its configured 24-hour TWAP window before paid purchases can open.
- A public HTTPS API origin for the event indexer and player card-history endpoint. Set `PUBLIC_API_BASE_URL` before contract deployment; the deploy script writes it into the public dApp configuration after a successful deployment.

## Local build and read-only preflight

Run from this directory:

```sh
npm ci
npm run compile
```

Copy `.env.mainnet.example` to `.env.mainnet` and fill in the RPC, treasury, VRF subscription, initial liquidity, pool-floor, and public API origin fields. The script loads `.env.mainnet` automatically. Keep the deployer key in a separate file outside this repository and set `DEPLOYER_PRIVATE_KEY_FILE` to its absolute path. The script also accepts `DEPLOYER_PRIVATE_KEY` inside the ignored `.env.mainnet` file, but the separate key file is preferred.

```sh
cp .env.mainnet.example .env.mainnet
```

Optional values are `QUOTE_TOKEN_ADDRESS`, `PANCAKE_V2_ROUTER`, `VRF_COORDINATOR`, `VRF_KEY_HASH`, `VRF_REQUEST_CONFIRMATIONS`, and `LP_BENEFICIARY`. The defaults select Binance-Peg BSC-USD, PancakeSwap V2, Chainlink VRF 2.5 native BNB payment, 3 confirmations, and the 500 gwei key hash. `LP_BENEFICIARY` defaults to the deployer.

First run the read-only check:

```sh
npm run deploy:mainnet:check
```

It verifies chain ID, external contract code, quote-token decimals, deployer balance, and that the VRF subscription exists, has a non-zero native BNB balance, and is owned by the deployer. It prints the complete deployment parameters and sends no transaction.

## Deployment sequence

Only after reviewing that printed plan, run:

```sh
npm run deploy:mainnet
```

The script asks for the exact phrase `DEPLOY BSC MAINNET` before sending transactions. It deploys the game and free-drop contracts, deploys BAI with fixed allocations, creates or finds the BAI/BSC-USD pair, wires the contracts, registers both Chainlink consumers, adds the configured initial liquidity, and locks the LP receipts for 365 days. It records transaction hashes and addresses in `deployments/bsc-mainnet-v1.json` as each contract deploys.

If a transaction fails after deployment begins, stop and inspect that record and the chain before retrying. The script intentionally refuses to overwrite a deployment record.

## After contract deployment

1. Verify and publish each address and source on BscScan.
2. Start the production API, database migrations, chain indexer, and keeper from `backend/compose.yaml`; configure mainnet RPC, contract addresses, the public site's exact origin in `PUBLIC_SITE_ORIGINS`, and the keeper signer with a restricted operations wallet. The frontend reads NFT history from the indexer API because the public BNB Chain RPC does not provide the log-query service required to scan card ownership.
3. Keep the game closed while the oracle gathers its hourly observations. Have the keeper call the oracle's `update()` at least once per configured observation interval. Open sales only after `marketReady()` is true and the pool meets its floor.
4. Run a small paid purchase, daily draw, free-drop registration/settlement, synthesis, card listing/purchase, dividend claim, and liquidity-processing cycle before public promotion.

The game contract currently mints boxes through `buyBoxes` or `buyBoxesWithBNB`. A plain BSC-USD transfer to the game address does not create a box. The web purchase flow calls the contract function; for BSC-USD, the single purchase button requests an exact-amount approval when needed, then submits the purchase transaction. That first purchase can require two wallet confirmations; later purchases need one while the allowance remains sufficient. BNB purchases use one transaction.
