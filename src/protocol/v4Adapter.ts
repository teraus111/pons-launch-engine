import type { Address, Hex, PublicClient, TransactionReceipt } from "viem";
import type { StateStore } from "../core/store.js";
import type { RuntimeWallet } from "../core/wallets.js";
import type { V2LifecycleState } from "./v2Lifecycle.js";

export interface V4SellResult {
  txHash: Hex;
  receipt: TransactionReceipt;
  quoteOut: bigint;
}

export interface V4SwapAdapter {
  readonly name: string;
  readonly available: boolean;
  quoteSell(args: {
    client: PublicClient;
    lifecycle: V2LifecycleState;
    token: Address;
    tokensIn: bigint;
  }): Promise<bigint>;
  sell(args: {
    client: PublicClient;
    store: StateStore;
    wallet: RuntimeWallet;
    lifecycle: V2LifecycleState;
    token: Address;
    tokensIn: bigint;
    slippageBps: number;
  }): Promise<V4SellResult | null>;
}

export class UnavailableV4Adapter implements V4SwapAdapter {
  readonly name = "unconfigured";
  readonly available = false;

  async quoteSell(): Promise<bigint> {
    throw new Error(
      "Pons launch is trading on Uniswap v4, but no verified Robinhood Chain v4 router adapter is configured",
    );
  }

  async sell(): Promise<V4SellResult | null> {
    throw new Error(
      "Cannot sell graduated Pons v2 position until a verified v4 router adapter is configured",
    );
  }
}
