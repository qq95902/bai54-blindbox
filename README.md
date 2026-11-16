# Bai Blind Box

The player site, bilingual rules, and Solidity source for Bai Blind Box. The current test deployment is BSC Testnet v8 (Chain ID 97). Addresses are recorded in [`deployments/bsc-testnet-v8.json`](deployments/bsc-testnet-v8.json) and loaded by [`bai-config.js`](bai-config.js).

## Current testnet contracts

| Contract | Address |
| --- | --- |
| BAI token | `0xCCB40688e08D4b33734D03e7E68d04AF9FaE55Ff` |
| Blind box game | `0x72CB481781d8c8DcAC71e21FD87D6F3F3a044572` |
| Card metadata renderer | `0x84A966c74B4b7DF9f4371Ff8eC5b57A3DBfcDEb1` |
| Free BAI rewards | `0x737040c039dceeDf23251e5ea2646Bf89cF8Ef1a` |
| Liquidity manager / price oracle | `0xF95010B31Ec5F611589777910f2CD51b32722355` |
| BAI/USDT pair | `0xD1dA5eF9EE9B7E66085f970042995E3d7fB19A6e` |

The game price is 10 USDT per box. A qualifying direct inviter earns 3 USDT for each box purchased by their referred wallet. The inviter must have previously purchased a box; each buyer can bind one inviter, and the binding cannot be changed. There is one referral level. Free claims, card trades, and synthesis do not earn commission. The 3 USDT commission is deducted from the 7.8 USDT liquidity allocation for that referred box; the 2.2 USDT prize allocation is unchanged. Without a referral, the full 7.8 USDT goes to liquidity.

Free claims award BAI only. Each wallet can register once per Beijing day; the campaign is capped at 3,000 entries per day and 200,000 total. The reserve covers 195,000 standard rewards of 1–3 BAI and 5,000 special rewards of 4–6 BAI. Chainlink VRF assigns rewards after the claim day closes. Unclaimed rewards remain pending until the wallet has purchased a paid box. The v8 VRF subscription has the game and free-reward contract registered as consumers.

The testnet liquidity manager uses a 15-second TWAP, 5-second observation interval, and 2 USDT pool floor. Its initial LP shares are locked. These are testnet settings; mainnet uses a separate deployment configuration.

## Build and deploy

NFT metadata is generated on-chain by `BAICardMetadataRenderer`: sealed boxes expose a pending state, and revealed cards expose their asset, rarity, style, result, Beijing day, and embedded SVG image. Four card skins are represented as distinct metadata traits.

Install dependencies with `npm ci`, compile with `npm run compile`, and run the local sandbox with `npm run sandbox:simulate`. The testnet deployment script reads `.env.testnet`, `.env`, or the existing adjacent contract workspace `.env`; keep private keys out of Git. Run `npm run deploy:testnet:check` before `npm run deploy:testnet`. The v8 script writes a separate v8 deployment record and verifies the chain ID, deployer, balances, VRF subscription, and contract wiring. Card faces use recognizable vector marks for their represented assets; the marks are included directly in the card art and on-chain NFT metadata.

See [`README-mainnet-deploy.md`](README-mainnet-deploy.md) for the separate mainnet deployment checklist. Never put private keys or seed phrases in this repository.
