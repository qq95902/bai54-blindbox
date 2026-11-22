# BAI backend

The backend is split into three processes:

- `api.mjs`: readiness, chain status, and authenticated Prometheus metrics.
- `indexer.mjs`: confirmed BSC contract events, PostgreSQL scan checkpoints, and reorg rewind to the newest canonical checkpoint.
- `keeper.mjs`: daily draw, free-drop settlement, synthesis completion, liquidity processing, and oracle observations.

All three processes use the same PostgreSQL database. PostgreSQL advisory locks elect one active indexer and one active keeper; other instances remain alive as standbys and take over when the active connection closes. Keeper writes are recorded with transaction hashes and bounded exponential retry delays. Before retrying a job with a recorded hash, the keeper reconciles its chain receipt. Pending or unknown outcomes are held instead of blindly broadcasting a duplicate. A `BROADCAST_OUTCOME_UNKNOWN` job with no hash requires operator reconciliation before retrying. Direct-USDT deposits are processed with bounded concurrency (`PURCHASE_DEPOSIT_CONCURRENCY`, default 25, maximum 50) and a nonce-managed Keeper signer so one slow receipt does not serialize every independent player's purchase.

API request IDs are propagated through asynchronous handlers into database and RPC logs. Each SQL operation also gets a distinct `queryId`; each RPC call gets a distinct `rpcCallId`. Logs include route/method/status, duration, SQL fingerprint, table/operation, pool pressure, and safe error codes; request bodies, SQL parameters, and signing data are not logged.

## Configuration

1. Copy `.env.example` to `.env` and set the production RPC URLs, PostgreSQL URL, chain ID, deployed contract addresses, and each contract's deployment block. The oracle is part of the liquidity manager, so it does not need a separate address.
   If the API sits behind a reverse proxy or load balancer, set `TRUSTED_PROXY_IPS` to the exact private IPs that connect to the API and configure the proxy to append the connecting client's address to `X-Forwarded-For`. The API ignores forwarded headers from any other peer.
2. Set `KEEPER_PRIVATE_KEY_FILE=/run/secrets/keeper_private_key`. Put the dedicated keeper key in `secrets/keeper_private_key`, readable only by the keeper container's Node user (UID 1000), and excluded from source control. Do not use a deployment or treasury key.
3. Set the VRF subscription ID and fund it with native BNB. The deployed game and free-drop consumers request randomness with Chainlink VRF v2.5 `nativePayment: true`; funding that subscription only with LINK will not cover those requests.
4. Use a PostgreSQL service with TLS, automated backups, point-in-time recovery, and private networking. `DATABASE_SSL=disable` is for local development only.
5. Configure two RPC URLs from independent providers and an external HTTPS load balancer in front of the API. Do not expose port 8080 or PostgreSQL directly to the public internet.

Run `npm run sandbox:simulate` from `backend/` to replay Keeper transaction reconciliation, host-clock skew, direct-USDT deposit settlement/refund boundaries, sender-mismatch spam that could otherwise starve later orders, 3,000-deposit bounded-concurrency fault injection, purchase-status and buyer-bound deposit-address API behavior, shallow/deep indexer reorg recovery, and bounded `eth_getLogs` failure/splitting behavior without connecting to a live chain. Mismatched transfer senders are recorded as terminal ignored jobs, so they do not remain at the front of the Keeper's bounded scan. Any authorized unregistered-transfer return is paid only to the buyer bound to that deterministic vault; the Keeper cannot choose a refund recipient. Before a vault is persisted for indexing, `POST /v1/deposit-challenge` issues a five-minute, one-use message bound to the allowed site origin, chain, buyer, and referrer. The buyer signs it with `personal_sign`; `POST /v1/deposit-address` verifies and atomically consumes it before persisting the buyer/referrer-specific CREATE2 vault. This proof is requested only for address creation: wallet connection and public browsing require no signature, and the message neither costs gas nor grants token allowance. Migration `008_wallet_signing_challenges.sql` stores challenges and replay state.

The root contract load tests use an isolated dependency lockfile in `sandbox/`; deployment tooling does not need to install Ganache. The first `npm run sandbox:simulate` or `npm run sandbox:load-3000` installs only those local-sandbox dependencies with lifecycle scripts disabled.

Run `npm run sandbox:load-3000` from `backend/` for a repeatable API load baseline: 3,000 virtual clients issue 6,000 requests to `/v1/cards` and `/v1/market` in waves of 50 clients (up to 100 in-flight requests). It uses a synthetic PostgreSQL pool capped at 10 connections with a fixed 5 ms query delay. This checks request handling, logging, and bounded pool behavior; use the provisioned PostgreSQL service and production-like traffic patterns before treating any latency or capacity number as an infrastructure benchmark. It does not load-test BSC RPC log indexing: the direct-deposit watcher queries registered USDT vault recipients in sequential groups of up to `DEPOSIT_LOG_RECIPIENT_BATCH_SIZE` (default 500) every indexing cycle. Measure that path with the selected production RPC at the expected number of registered vaults; do not infer its capacity from the API simulation.

The API's per-IP fixed-window limiter is local to each process and caps its tracked IP map at 5,000 entries. Put shared rate limits at the public reverse proxy/API gateway as well; multiple API replicas do not share the in-memory counters.

The indexer stores a block hash at every scanned range boundary. If a saved cursor becomes non-canonical, it searches backward for the newest matching checkpoint, removes events and checkpoints after that ancestor, then rescans. Existing databases are seeded from their current cursor; if that legacy checkpoint is orphaned before earlier checkpoints exist, the affected contract is rebuilt from its deployment block. Direct-USDT deposit indexing also requires an RPC endpoint with `eth_getLogs`; range/topic/result-size failures are split with a strict per-query attempt budget, while disabled methods, authentication errors, and rate limits fail immediately so an endpoint outage cannot multiply into a request storm. `DEPOSIT_LOG_RECIPIENT_BATCH_SIZE` controls recipient filters per RPC query (default 500, maximum 1,000); lower it if the selected provider limits topic alternatives. At the default, 3,000 vaults require six sequential log queries per 12-second indexing cycle, and 90,000 require 180. Measure the selected provider's real quota/latency at the expected vault count before claiming production capacity.

### BSC testnet v12 bring-up

For a testnet-only backend, copy `.env.testnet.example` to `.env`, then fill in every `REPLACE_WITH_V12_*` value from the deployed v12 manifest, plus a private PostgreSQL URL and metrics token. Do not use the older v10 manifest: it has no v12 purchase processor and cannot support direct-USDT purchases. The two public BNB Chain RPC URLs are for testnet bring-up only; use two separately provisioned providers for production.

Create `secrets/keeper_private_key` outside source control with a dedicated testnet Keeper wallet key that matches `purchaseKeeper` in the v12 manifest. Fund that wallet with tBNB for gas; this is separate from the Chainlink VRF subscription balance. The deployer and this configured Keeper may retry a draw request after the 24-hour VRF retry delay. Then start the services from this directory with `docker compose up -d --build`, check `docker compose ps`, and inspect `docker compose logs -f api indexer keeper`. Keep the stack running while the 15-second testnet TWAP warms up. Verify `/v1/status` reports a fresh Keeper heartbeat and `market.state` is `ready`, then run `npm run verify:testnet` from the repository root. A one-time Keeper run is insufficient: the testnet market pauses again after its observations become stale.

## Run

From this directory, prepare `.env` and the keeper secret file, then run:

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f api indexer keeper
```

Run the same compose stack on two application VMs. The database locks prevent duplicate indexer and keeper workers; both API instances can serve traffic behind the load balancer. Keep the VMs in separate availability zones and the PostgreSQL service outside the VM pair.

`GET /healthz` is a process liveness check. `GET /readyz` checks PostgreSQL and BSC RPC connectivity; it does not mean paid sales are open. `GET /v1/status` reports indexed cursors, recent service heartbeats, Keeper health (stale after two minutes), and the on-chain TWAP readiness/observation age that gates purchases. When the optional v12 purchase processor and USDT token are configured, `GET /v1/purchase-status?txHash=0x…` reports one transaction and `GET /v1/purchase-status?address=0x…` reports the latest direct-USDT order indexed for that wallet. Both report `confirming_or_indexing`, `pending_keeper_registration`, `pending_settlement`, `settled`, `refunded`, or `transaction_failed` as applicable. `/metrics` requires the configured bearer token. Alert when `keeper.state` is `stale`, `market.state` is `paused`, or market state is `unknown`.

## Contract alignment

The event and keeper ABIs in `src/abis.mjs` are maintained against the Solidity interfaces in `../contracts`. Update both together whenever a contract interface changes. Set `GAME_DEPLOYMENT_BLOCK`, `FREE_DROP_DEPLOYMENT_BLOCK`, and `LIQUIDITY_MANAGER_DEPLOYMENT_BLOCK` to the actual deployment block for each contract.

At startup each service checks the configured chain ID and verifies that all three contract addresses contain deployed bytecode. This code is a deployable backend foundation, not an indication that a production database, RPC account, cloud secrets, load balancer, or mainnet contracts have already been provisioned. The keeper is intentionally separate from the public API and never receives user signing keys.
