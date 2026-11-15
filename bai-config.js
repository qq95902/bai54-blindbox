// Public BSC testnet deployment addresses; no secrets.
window.BAI_CONFIG = Object.freeze({
  "chainId": 97,
  "chainName": "BNB Smart Chain Testnet",
  "nativeCurrency": {
    "name": "tBNB",
    "symbol": "tBNB",
    "decimals": 18
  },
  "rpcUrls": [
    "https://data-seed-prebsc-1-s1.binance.org:8545/"
  ],
  "blockExplorerUrls": [
    "https://testnet.bscscan.com"
  ],
  "readRpcUrl": "https://data-seed-prebsc-1-s1.binance.org:8545/",
  "apiBaseUrl": "",
  "contracts": {
    "game": "0x30d0017c25361c666DbA957821618D25757599Fd",
    "bai": "0xB8DC44F523716B7e5b8516d3065dCe8Be4352634",
    "freeDrop": "0xe97E2A78868d13E24028a88493C17Bbd855ed8C5",
    "usdt": "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    "router": "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3",
    "liquidityManager": "0x0fcbB0971D9Da6dB018cD4eD9daBD7896a85906E"
  }
});
