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
    "https://bsc-testnet-dataseed.bnbchain.org",
    "https://bsc-testnet-rpc.publicnode.com"
  ],
  "blockExplorerUrls": [
    "https://testnet.bscscan.com"
  ],
  "readRpcUrl": "https://bsc-testnet-dataseed.bnbchain.org",
  "apiBaseUrl": "",
  "walletConnectProjectId": "",
  "contracts": {
    "game": "0xDE0dddDAdC48C6FD17CD9B345b2B7016073FBaD4",
    "bai": "0x6cc7834Ecfc250aFDdb34eFd3b4FE84eF26Ea213",
    "freeDrop": "0x5E77365Fd6D417bdf8FcC062e9F30931F1212B08",
    "metadataRenderer": "0xB3ce5B1ab45e6366A5F178Cc9c7081a080a42C57",
    "usdt": "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    "router": "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3",
    "liquidityManager": "0xfF199F37cAc5ccB36EE15495681c5E6a1f20690d"
  }
});
