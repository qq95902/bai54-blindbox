# Bai Blind Box

The player site, bilingual rules, and Solidity source for Bai Blind Box. The current public test deployment is BSC Testnet v6 (Chain ID 97). Addresses are recorded in [`deployments/bsc-testnet-v6.json`](deployments/bsc-testnet-v6.json) and loaded by [`bai-config.js`](bai-config.js).

## Current testnet contracts

| Contract | Address |
| --- | --- |
| BAI token | `0xB8DC44F523716B7e5b8516d3065dCe8Be4352634` |
| Blind box game | `0x30d0017c25361c666DbA957821618D25757599Fd` |
| Free BAI rewards | `0xe97E2A78868d13E24028a88493C17Bbd855ed8C5` |
| Liquidity manager / price oracle | `0x0fcbB0971D9Da6dB018cD4eD9daBD7896a85906E` |
| BAI/USDT pair | `0x9DCAA853dbef71a902c82117A7d5bf1923273a3D` |

The game price is 10 USDT per box. A qualifying direct inviter earns 3 USDT for each box purchased by their referred wallet. The inviter must have previously purchased a box; each buyer can bind one inviter, and the binding cannot be changed. There is one referral level. Free claims, card trades, and synthesis do not earn commission. The 3 USDT commission is deducted from the 7.8 USDT liquidity allocation for that referred box; the 2.2 USDT prize allocation is unchanged. Without a referral, the full 7.8 USDT goes to liquidity.

Free claims award BAI only. Each wallet can register once per Beijing day; the campaign is capped at 3,000 entries per day and 200,000 total. The reserve covers 195,000 standard rewards of 1–3 BAI and 5,000 special rewards of 4–6 BAI. Chainlink VRF assigns rewards after the claim day closes. Unclaimed rewards remain pending until the wallet has purchased a paid box. The v6 VRF subscription has the game and free-reward contract registered as consumers.

The testnet liquidity manager uses a 15-second TWAP, 5-second observation interval, and 2 USDT pool floor. Its initial LP shares are locked. These are testnet settings; mainnet uses a separate deployment configuration.

## Build and deploy

NFT metadata is generated on-chain by `BAICardMetadataRenderer`: sealed boxes expose a pending state, and revealed cards expose their asset, rarity, style, result, Beijing day, and embedded SVG image. Four card skins are represented as distinct metadata traits. The public v6 game contract predates this renderer; the v7 deployment script deploys the renderer and links it into the game contract.

Install dependencies with `npm ci`, compile with `npm run compile`, and run the local sandbox with `npm run sandbox:simulate`. The testnet deployment script reads `.env.testnet`, `.env`, or the existing adjacent contract workspace `.env`; keep private keys out of Git. Run `npm run deploy:testnet:check` before `npm run deploy:testnet`. The v7 script writes a separate v7 deployment record and verifies the chain ID, deployer, balances, VRF subscription, and contract wiring.

See [`README-mainnet-deploy.md`](README-mainnet-deploy.md) for the separate mainnet deployment checklist. Never put private keys or seed phrases in this repository.
