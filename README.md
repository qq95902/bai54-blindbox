# BAI Blind Box

GitHub Pages frontend for the BAI blind-box project. `index.html` is the entry page, `blindbox-player-demo.html` is an alternate entry, and `whitepaper.html` contains the bilingual gameplay guide.

## BNB Smart Chain Testnet

The current frontend connects through the injected EIP-1193 provider in the Binance Wallet Web3 DApp browser and targets BNB Smart Chain Testnet (chain ID 97). It reads USDT, BAI, BNB, the current round counters, and owned box NFTs. USDT approval and purchases in USDT or tBNB are sent to the deployed testnet game contract and require wallet confirmation.

Contract addresses are defined near the top of the inline script in both entry HTML files. The current testnet deployment manifest is maintained in the separate `bai54-contracts` repository. Never place private keys or seed phrases in this repository.

Daily VRF settlement, prize claims, token rewards, synthesis, and NFT marketplace actions are not connected in this frontend yet. The interface presents unrevealed boxes as pending until the on-chain settlement has populated their result.

BAI is an independent project and is not affiliated with, sponsored by, or endorsed by Binance.
