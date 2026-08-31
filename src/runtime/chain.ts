import {
  createPublicClient,
  fallback,
  http,
  webSocket,
  defineChain,
  type PublicClient,
} from "viem";
import { runtimeConfig } from "./config.js";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

export const robinhoodChain = defineChain({
  id: runtimeConfig.CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [runtimeConfig.RPC_HTTP_URL] },
    public: { http: [PUBLIC_RPC] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

const readTransports = runtimeConfig.RPC_WS_URL
  ? [
      webSocket(runtimeConfig.RPC_WS_URL, { retryCount: 3, keepAlive: { interval: 10_000 } }),
      http(runtimeConfig.RPC_HTTP_URL, { retryCount: 3, batch: true }),
      http(PUBLIC_RPC, { retryCount: 2, batch: true }),
    ]
  : [
      http(runtimeConfig.RPC_HTTP_URL, { retryCount: 3, batch: true }),
      http(PUBLIC_RPC, { retryCount: 2, batch: true }),
    ];

export const publicClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: fallback(readTransports),
  pollingInterval: runtimeConfig.POLL_INTERVAL_MS,
});
