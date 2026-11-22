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
- A public HTTPS API origin for the event indexer and player card-history endpoint. Choose `PUBLIC_API_BASE_URL` before contract deployment; the deploy script writes it into the public dApp configuration after it creates the contract addresses. The API itself is configured and started after deployment, because its startup checks require those addresses to have deployed code.
- A WalletConnect Cloud public `WALLETCONNECT_PROJECT_ID` for standard Binance Web3 Wallet desktop QR sessions. Add the deployed HTTPS origin to that project's allowlist. This does not authenticate or support Binance Agentic Wallet; Binance warns against scanning third-party site QR codes with Agentic Wallet.

## Local build and read-only preflight

Run from this directory:

```sh
npm ci
npm run compile
```

Copy `.env.mainnet.example` to `.env.mainnet` and fill in the RPC, treasury, VRF subscription and native-BNB operating floor, initial liquidity, pool-floor, public API origin, and WalletConnect project ID fields. The script loads `.env.mainnet` automatically. Keep the deployer key in a separate file outside this repository and set `DEPLOYER_PRIVATE_KEY_FILE` to its absolute path. The script also accepts `DEPLOYER_PRIVATE_KEY` inside the ignored `.env.mainnet` file, but the separate key file is preferred.

```sh
cp .env.mainnet.example .env.mainnet
```

Optional values are `QUOTE_TOKEN_ADDRESS`, `PANCAKE_V2_ROUTER`, `VRF_COORDINATOR`, `VRF_KEY_HASH`, `VRF_REQUEST_CONFIRMATIONS`, and `LP_BENEFICIARY`. The defaults select Binance-Peg BSC-USD, PancakeSwap V2, Chainlink VRF 2.5 native BNB payment, 3 confirmations, and the 500 gwei key hash. `LP_BENEFICIARY` defaults to the deployer.

First run the read-only check:

```sh
npm run deploy:mainnet:check
```

It verifies chain ID, external contract code, quote-token decimals, deployer balance, and that the VRF subscription exists, meets the configured `VRF_MIN_NATIVE_BALANCE_BNB` operating floor, and is owned by the deployer. This floor is an operator preflight threshold, not a guarantee that all future requests are funded. The contracts cap synthesis randomness requests at 50 per Beijing day because they share native-BNB VRF funds with daily draws. The preflight prints the complete deployment parameters and sends no transaction.

## Deployment sequence

Only after reviewing that printed plan, run:

```sh
npm run deploy:mainnet
```

The script asks for the exact phrase `DEPLOY BSC MAINNET` before sending transactions. It deploys the metadata renderer, game, buyer-bound USDT purchase processor, free-drop contract, BAI token, and liquidity manager; wires the contracts; creates or finds the BAI/BSC-USD pair; registers both Chainlink consumers; adds the configured initial liquidity; and locks the LP receipts for 365 days. It records transaction hashes and addresses in `deployments/bsc-mainnet-v2.json` as each contract deploys.

Daily draw requests are permissionless once a round closes. If Chainlink VRF has not fulfilled a request after 24 hours, only the deployer or the configured purchase Keeper may request a replacement, preventing public callers from repeatedly charging the project's VRF subscription.

If a transaction fails after deployment begins, stop and inspect that record and the chain before retrying. The script intentionally refuses to overwrite a deployment record.

## After contract deployment

1. Verify and publish each address and source on BscScan.
2. Configure and start the production API and database migrations from `backend/compose.yaml` using the addresses recorded by the deployment. Check `GET /readyz` returns `ready` on chain 56 before publishing the generated frontend config. Then start the chain indexer and keeper with the exact public-site origin in `PUBLIC_SITE_ORIGINS` and a restricted keeper signer. USDT vault requests require a short-lived, one-use wallet message signature bound to that origin, chain, buyer, and referrer; connecting the wallet and browsing remain signature-free, and this message signature spends no gas and grants no token allowance. The indexer needs an RPC provider that supports `eth_getLogs` for both NFT history and direct-USDT deposit detection; several BNB Chain public mainnet endpoints disable log queries. Verify this capability and its quota before enabling paid purchases.
3. Keep paid purchases unavailable while the oracle gathers its hourly observations and until the API, indexer, and keeper report healthy. Have the keeper call the oracle's `update()` at least once per configured observation interval. Sales can become available automatically when `marketReady()` is true and the pool meets its floor; the operator must not begin oracle updates before backend readiness is confirmed.
4. Run a small paid purchase, daily draw, free-drop registration/settlement, synthesis, card listing/purchase, dividend claim, and liquidity-processing cycle before public promotion.

The game contract mints boxes through the dedicated purchase processor. BNB purchases use one wallet transaction. For direct BSC-USD transfers, the API returns a deterministic deposit vault bound to the buyer and selected inviter, records that address for indexing, and the site asks the wallet to send the tokens there. No approval or vault-creation transaction is needed. The contract checks the buyer/referrer binding when the Keeper registers the confirmed transfer, so a Keeper cannot redirect a buyer's funded vault to another account. A direct transfer to the game address never creates a box. This flow depends on the public API, indexer, and Keeper; the UI must show the payment hash and settlement state and tell the buyer how to recover if services are unavailable.
