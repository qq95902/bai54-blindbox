# BAI Blind Box

GitHub Pages frontend and public deployment references for BAI. `index.html` and `blindbox-player-demo.html` are the player interface; `whitepaper.html` is the bilingual gameplay guide.

## BNB Smart Chain Testnet · Chain ID 97

The current deployment addresses and allocation parameters are in [`deployments/bsc-testnet-v4.json`](deployments/bsc-testnet-v4.json). Solidity sources are in [`contracts/`](contracts/).

| Contract | Address |
| --- | --- |
| BAI token | `0xA41b85e5D05272fC98B73de4cdB7b3BF5d40F31f` |
| Blind box game | `0x3699e7eB729A6d02F04E5D0534309E7C6dd984F5` |
| Free reward claims | `0x3B53C67F637c81d6197b18E39CC9c3a1fEf9A921` |
| Liquidity manager | `0x4F6EC8167Fce243a6790e3525E98AAC672b43f3D` |
| BAI/USDT pair | `0x293D38ef6eA0dc0F7D60b0c0Ca67588A8ab570FA` |

The free reward contract accepts one claim per wallet per Beijing calendar day, up to 3,000 registrations daily and 200,000 overall. It requests Chainlink VRF after the claim day closes, then assigns 1–3 BAI or 4–6 BAI from the reserved inventory. This transaction registers an entry; it does not mint a box NFT or transfer an immediate reward. A permissionless VRF request and batch settlement must be submitted after the day closes. Rewards for wallets without a paid box stay pending until the wallet has purchased one and claims them.

The web app requires a Binance Wallet injected transaction provider on BNB Smart Chain Testnet. The local Binance Agentic Wallet QR bridge is a separate identity pairing flow and is available only when the bridge runs on the same computer; it does not itself sign blockchain transactions. Never place private keys or seed phrases in this repository.

Paid round settlement requires the liquidity manager's TWAP observations to remain fresh. On this testnet deployment, anyone can refresh observations through the manager contract; a keeper service is not configured. The free reward registration call does not depend on the paid round being open.

BAI is an independent project and is not affiliated with, sponsored by, or endorsed by Binance.
