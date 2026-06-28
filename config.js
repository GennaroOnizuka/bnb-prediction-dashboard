window.DASHBOARD_CONFIG = {
  appName: "BNB Prediction Bot",
  chainName: "BNB Smart Chain",
  chainId: 56,
  defaultWallet: "0x564bE2F70456bd53FE81D1a6071c24293bcBf8CA",
  dataUrl: "./data/local_snapshot.json",
  predictionContract: "0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA",
  rpcUrls: [
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc-dataseed1.ninicoin.io"
  ],
  blocksPerDay: 28800,
  defaultDays: 1,
  maxChunkBlocks: 900,
  rpcRetryMs: 900,
  baseBetBnb: 0.001,
  martingaleMultiplier: 2.5,
  martingaleMaxLosses: 5
};
