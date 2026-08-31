import {
  decodeEventLog,
  encodeAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { StateStore } from "../core/store.js";
import type { RuntimeWallet } from "../core/wallets.js";
import { redactError } from "../core/values.js";
import { robinhoodChain } from "../runtime/chain.js";
import { runtimeConfig } from "../runtime/config.js";
import {
  erc20Abi,
  permit2Abi,
  poolManagerAbi,
  universalRouterAbi,
  uniswapV4QuoterAbi,
  UNISWAP_V4,
} from "./contracts.js";
import type { V2LifecycleState } from "./v2Lifecycle.js";
import type { V4SellResult, V4SwapAdapter } from "./v4Adapter.js";

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const V4_SWAP_COMMAND = "0x10" as Hex;
const V4_ACTIONS = "0x060c0f" as Hex;

const exactInputSingleType = {
  type: "tuple",
  components: [
    {
      name: "poolKey",
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "minHopPriceX36", type: "uint256" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

export class UniswapV4Adapter implements V4SwapAdapter {
  readonly name = "uniswap-v4-universal-router";
  readonly available = true;

  async quoteSell(args: {
    client: PublicClient;
    lifecycle: V2LifecycleState;
    token: Address;
    tokensIn: bigint;
  }): Promise<bigint> {
    const poolKey = requirePoolKey(args.lifecycle);
    if (args.tokensIn > MAX_UINT128) throw new Error("v4 swap input exceeds uint128");
    const result = await args.client.simulateContract({
      address: configuredQuoter(),
      abi: uniswapV4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey,
        zeroForOne: args.token.toLowerCase() === poolKey.currency0.toLowerCase(),
        exactAmount: args.tokensIn,
        hookData: "0x",
      }],
    });
    return result.result[0];
  }

  async sell(args: {
    client: PublicClient;
    store: StateStore;
    wallet: RuntimeWallet;
    lifecycle: V2LifecycleState;
    token: Address;
    tokensIn: bigint;
    slippageBps: number;
  }): Promise<V4SellResult | null> {
    const poolKey = requirePoolKey(args.lifecycle);
    const expected = await this.quoteSell({
      client: args.client,
      lifecycle: args.lifecycle,
      token: args.token,
      tokensIn: args.tokensIn,
    });
    const minimum = (expected * (10_000n - BigInt(args.slippageBps))) / 10_000n;
    if (minimum > MAX_UINT128) throw new Error("v4 minimum output exceeds uint128");
    const approvalsReady = await ensurePermit2(args.client, args.store, args.wallet, args.token, args.tokensIn);
    if (!approvalsReady && runtimeConfig.DRY_RUN) return null;

    const zeroForOne = args.token.toLowerCase() === poolKey.currency0.toLowerCase();
    const outputCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    const input = encodeV4Input(poolKey, zeroForOne, args.tokensIn, minimum, args.token, outputCurrency);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 60);
    const call = {
      account: args.wallet.account,
      address: configuredRouter(),
      abi: universalRouterAbi,
      functionName: "execute" as const,
      args: [V4_SWAP_COMMAND, [input], deadline] as const,
      value: 0n,
    };
    await args.client.simulateContract(call);
    if (runtimeConfig.DRY_RUN) return null;

    const estimate = await args.client.estimateContractGas(call);
    const fees = await args.client.estimateFeesPerGas();
    const txHash = await args.wallet.nonces.use(async (nonce) => {
      const hash = await args.wallet.client.writeContract({
        account: args.wallet.account,
        chain: robinhoodChain,
        address: configuredRouter(),
        abi: universalRouterAbi,
        functionName: "execute",
        args: [V4_SWAP_COMMAND, [input], deadline],
        value: 0n,
        gas: bufferedGas(estimate),
        nonce,
        ...fees,
      });
      args.store.recordTransaction({
        hash,
        wallet: args.wallet.address,
        token: args.token,
        action: "sell",
        nonce,
        status: "submitted",
        amountIn: args.tokensIn,
        minOut: minimum,
        actualOut: null,
        error: null,
        submittedAt: Date.now(),
        confirmedAt: null,
        blockNumber: null,
      });
      return hash;
    });

    try {
      const receipt = await args.client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
      if (receipt.status !== "success") throw new Error("Uniswap v4 sell reverted on chain");
      const quoteOut = decodeSwapOutput(receipt, args.lifecycle, zeroForOne) ?? expected;
      args.store.updateTransaction(txHash, "confirmed", {
        actualOut: quoteOut,
        confirmedAt: Date.now(),
        blockNumber: receipt.blockNumber,
      });
      return { txHash, receipt, quoteOut };
    } catch (error) {
      args.store.updateTransaction(txHash, "failed", { error: redactError(error), confirmedAt: Date.now() });
      throw error;
    }
  }
}

export function encodeV4Input(
  poolKey: NonNullable<V2LifecycleState["poolKey"]>,
  zeroForOne: boolean,
  amountIn: bigint,
  minimumOut: bigint,
  inputCurrency: Address,
  outputCurrency: Address,
): Hex {
  const swap = encodeAbiParameters(
    [exactInputSingleType],
    [{
      poolKey,
      zeroForOne,
      amountIn,
      amountOutMinimum: minimumOut,
      minHopPriceX36: 0n,
      hookData: "0x",
    }],
  );
  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [inputCurrency, amountIn],
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [outputCurrency, minimumOut],
  );
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [V4_ACTIONS, [swap, settle, take]],
  );
}

async function ensurePermit2(
  client: PublicClient,
  store: StateStore,
  wallet: RuntimeWallet,
  token: Address,
  amount: bigint,
): Promise<boolean> {
  if (amount > MAX_UINT160) throw new Error("Permit2 amount exceeds uint160");
  const router = configuredRouter();
  const [erc20Allowance, permitAllowance] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet.address, UNISWAP_V4.permit2],
    }),
    client.readContract({
      address: UNISWAP_V4.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [wallet.address, token, router],
    }),
  ]);
  const now = Math.floor(Date.now() / 1_000);
  const permitReady = permitAllowance[0] >= amount && Number(permitAllowance[1]) > now + 120;
  if (erc20Allowance >= amount && permitReady) return true;
  if (runtimeConfig.DRY_RUN) return false;

  if (erc20Allowance < amount) {
    await sendApproval(client, store, wallet, token, UNISWAP_V4.permit2, amount);
  }
  if (!permitReady) {
    const expiration = now + 30 * 24 * 60 * 60;
    const hash = await wallet.nonces.use(async (nonce) => {
      const txHash = await wallet.client.writeContract({
        account: wallet.account,
        chain: robinhoodChain,
        address: UNISWAP_V4.permit2,
        abi: permit2Abi,
        functionName: "approve",
        args: [token, router, amount, expiration],
        nonce,
      });
      recordApproval(store, txHash, wallet, token, nonce, amount);
      return txHash;
    });
    await confirmApproval(client, store, hash);
  }
  return true;
}

async function sendApproval(
  client: PublicClient,
  store: StateStore,
  wallet: RuntimeWallet,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const hash = await wallet.nonces.use(async (nonce) => {
    const txHash = await wallet.client.writeContract({
      account: wallet.account,
      chain: robinhoodChain,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
      nonce,
    });
    recordApproval(store, txHash, wallet, token, nonce, amount);
    return txHash;
  });
  await confirmApproval(client, store, hash);
}

function recordApproval(
  store: StateStore,
  hash: Hex,
  wallet: RuntimeWallet,
  token: Address,
  nonce: number,
  amount: bigint,
): void {
  store.recordTransaction({
    hash,
    wallet: wallet.address,
    token,
    action: "approve",
    nonce,
    status: "submitted",
    amountIn: amount,
    minOut: 0n,
    actualOut: null,
    error: null,
    submittedAt: Date.now(),
    confirmedAt: null,
    blockNumber: null,
  });
}

async function confirmApproval(client: PublicClient, store: StateStore, hash: Hex): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  store.updateTransaction(hash, receipt.status === "success" ? "confirmed" : "failed", {
    confirmedAt: Date.now(),
    blockNumber: receipt.blockNumber,
  });
  if (receipt.status !== "success") throw new Error(`Approval ${hash} reverted`);
}

function decodeSwapOutput(
  receipt: TransactionReceipt,
  lifecycle: V2LifecycleState,
  zeroForOne: boolean,
): bigint | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== UNISWAP_V4.poolManager.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: poolManagerAbi,
        eventName: "Swap",
        topics: log.topics,
        data: log.data,
      });
      if (lifecycle.poolId && decoded.args.id.toLowerCase() !== lifecycle.poolId.toLowerCase()) continue;
      const output = zeroForOne ? decoded.args.amount1 : decoded.args.amount0;
      if (output > 0n) return output;
      if (output < 0n) return -output;
    } catch {
      // Ignore unrelated PoolManager logs.
    }
  }
  return null;
}

function requirePoolKey(lifecycle: V2LifecycleState): NonNullable<V2LifecycleState["poolKey"]> {
  if (!lifecycle.poolKey) throw new Error("Pons v2 launch has no graduated pool key");
  return lifecycle.poolKey;
}

function configuredRouter(): Address {
  return runtimeConfig.V4_ROUTER_ADDRESS ?? UNISWAP_V4.universalRouter;
}

function configuredQuoter(): Address {
  return runtimeConfig.V4_QUOTER_ADDRESS ?? UNISWAP_V4.quoter;
}

function bufferedGas(estimate: bigint): bigint {
  return (estimate * BigInt(Math.ceil(runtimeConfig.GAS_LIMIT_MULTIPLIER * 1_000))) / 1_000n;
}
