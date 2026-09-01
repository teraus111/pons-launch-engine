import {
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { CampaignExecution } from "./core/types.js";
import type { StateStore } from "./core/store.js";
import type { RuntimeWallet } from "./core/wallets.js";
import { redactError } from "./core/values.js";
import type { DetectedV1Launch } from "./protocol/detector.js";
import {
  erc20Abi,
  PONS_V1,
  ponsV1TokenAbi,
  uniswapV3PoolAbi,
  uniswapV3QuoterAbi,
  uniswapV3RouterAbi,
} from "./protocol/contracts.js";
import { publicClient, robinhoodChain } from "./runtime/chain.js";
import { runtimeConfig } from "./runtime/config.js";
import { log } from "./runtime/logger.js";
import { setCredentials } from "./core/entryEngine.js";

export interface V1BuyResult {
  txHash: Hex;
  receipt: TransactionReceipt;
  tokensOut: bigint;
  spent: bigint;
}

export interface V1SellResult {
  txHash: Hex;
  receipt: TransactionReceipt;
  quoteOut: bigint;
}

export type V1Outcome =
  | { status: "filled"; wallet: RuntimeWallet; result: V1BuyResult }
  | { status: "dry-run"; wallet: RuntimeWallet; expectedTokens: bigint }
  | { status: "failed"; wallet: RuntimeWallet; reason: string };

export interface V1Market {
  pool: Address;
  poolFee: number;
  isToken0: boolean;
}

export async function quoteV1ExactInput(args: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  poolFee: number;
}): Promise<bigint> {
  if (args.amountIn <= 0n) return 0n;
  const simulation = await publicClient.simulateContract({
    address: PONS_V1.quoterV2,
    abi: uniswapV3QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn,
      fee: args.poolFee,
      sqrtPriceLimitX96: 0n,
    }],
  });
  return simulation.result[0];
}

export async function snipeV1All(args: {
  launch: DetectedV1Launch;
  wallets: RuntimeWallet[];
  execution: CampaignExecution;
  store: StateStore;
}): Promise<{ outcomes: V1Outcome[]; market: V1Market }> {
  const { launch, wallets, execution, store } = args;
  if (launch.pairToken.toLowerCase() !== PONS_V1.weth.toLowerCase()) {
    const reason = `unsupported v1 pair token ${launch.pairToken}; expected WETH`;
    return {
      market: { pool: launch.pool, poolFee: 10_000, isToken0: false },
      outcomes: wallets.map((wallet) => ({ status: "failed", wallet, reason })),
    };
  }

  const poolFee = Number(await publicClient.readContract({
    address: launch.token,
    abi: ponsV1TokenAbi,
    functionName: "poolFee",
  }));
  const market: V1Market = {
    pool: launch.pool,
    poolFee,
    isToken0: launch.token.toLowerCase() < launch.pairToken.toLowerCase(),
  };

  log.info({
    token: launch.token,
    launchBlock: launch.blockNumber.toString(),
    restrictionsEndBlock: launch.restrictionsEndBlock.toString(),
    wallets: wallets.length,
  }, "Pons v1 detected; targeting restricted blocks N+1 and N+2");

  let head = await waitForBlockAfter(launch.blockNumber);
  let pending = [...wallets];
  const final = new Map<number, V1Outcome>();

  for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt += 1) {
    const restricted = head <= launch.restrictionsEndBlock;
    const outcomes = await attemptV1Buys({
      launch,
      wallets: pending,
      market,
      restricted,
      attempt,
      execution,
      store,
    });
    pending = [];
    for (const outcome of outcomes) {
      if (outcome.status === "failed") pending.push(outcome.wallet);
      else final.set(outcome.wallet.index, outcome);
    }

    if (runtimeConfig.DRY_RUN || pending.length === 0) break;
    if (!restricted || head >= launch.restrictionsEndBlock) break;
    head = await waitForBlockAfter(head);
  }

  if (!runtimeConfig.DRY_RUN && pending.length > 0) {
    head = await publicClient.getBlockNumber();
    if (head <= launch.restrictionsEndBlock) await waitForBlockAfter(launch.restrictionsEndBlock);
    const outcomes = await attemptV1Buys({
      launch,
      wallets: pending,
      market,
      restricted: false,
      attempt: 3,
      execution,
      store,
    });
    for (const outcome of outcomes) final.set(outcome.wallet.index, outcome);
    pending = [];
  }

  for (const wallet of pending) {
    final.set(wallet.index, { status: "failed", wallet, reason: "restricted attempts exhausted" });
  }
  return {
    market,
    outcomes: wallets.map((wallet) => final.get(wallet.index) ?? {
      status: "failed" as const,
      wallet,
      reason: "no v1 outcome recorded",
    }),
  };
}

async function attemptV1Buys(args: {
  launch: DetectedV1Launch;
  wallets: RuntimeWallet[];
  market: V1Market;
  restricted: boolean;
  attempt: number;
  execution: CampaignExecution;
  store: StateStore;
}): Promise<V1Outcome[]> {
  const { launch, wallets, market, restricted, attempt, execution, store } = args;
  const totalIn = wallets.reduce((sum, wallet) => sum + wallet.buyAmount, 0n);
  const [totalOut, ...quotes] = await Promise.all([
    quoteV1ExactInput({
      tokenIn: launch.pairToken,
      tokenOut: launch.token,
      amountIn: totalIn,
      poolFee: market.poolFee,
    }),
    ...wallets.flatMap((wallet) => [
      quoteV1ExactInput({
        tokenIn: launch.pairToken,
        tokenOut: launch.token,
        amountIn: wallet.buyAmount,
        poolFee: market.poolFee,
      }),
      quoteV1ExactInput({
        tokenIn: launch.pairToken,
        tokenOut: launch.token,
        amountIn: totalIn - wallet.buyAmount,
        poolFee: market.poolFee,
      }),
    ]),
  ]);

  let maxWalletLimit = 0n;
  let maxTxLimit = 0n;
  let balances = wallets.map(() => 0n);
  if (restricted) {
    const limits = await Promise.all([
      publicClient.readContract({ address: launch.token, abi: ponsV1TokenAbi, functionName: "maxWalletLimit" }),
      publicClient.readContract({ address: launch.token, abi: ponsV1TokenAbi, functionName: "maxTxLimit" }),
      Promise.all(wallets.map((wallet) => publicClient.readContract({
        address: launch.token,
        abi: ponsV1TokenAbi,
        functionName: "balanceOf",
        args: [wallet.address],
      }))),
    ]);
    maxWalletLimit = limits[0];
    maxTxLimit = limits[1];
    balances = limits[2];
  }

  return runControlledBatches(wallets, execution, async (wallet, index): Promise<V1Outcome> => {
    const expectedIfFirst = quotes[index * 2]!;
    const siblingsOut = quotes[index * 2 + 1]!;
    const expectedIfLast = totalOut > siblingsOut ? totalOut - siblingsOut : 0n;
    const slippageBps = resolveSlippage(wallet, expectedIfFirst, expectedIfLast);
    let targetTokens = (expectedIfLast * (10_000n - BigInt(slippageBps))) / 10_000n;

    if (restricted) {
      const balance = balances[index]!;
      const walletRoom = maxWalletLimit > balance ? maxWalletLimit - balance : 0n;
      const restrictionRoom = walletRoom < maxTxLimit ? walletRoom : maxTxLimit;
      const safeRoom = (restrictionRoom * 9_999n) / 10_000n;
      if (targetTokens > safeRoom) targetTokens = safeRoom;
    }

    if (expectedIfFirst <= 0n || expectedIfLast <= 0n || targetTokens <= 0n) {
      return { status: "failed", wallet, reason: "v1 quote or restricted wallet allowance is zero" };
    }

    log.info({
      attempt,
      restricted,
      wallet: wallet.label,
      expectedTokensIfFirst: expectedIfFirst.toString(),
      expectedTokensIfLast: expectedIfLast.toString(),
      targetTokens: targetTokens.toString(),
      slippageBps,
    }, "submitting Pons v1 wallet entry");

    try {
      const result = await executeV1Buy({
        wallet,
        store,
        token: launch.token,
        pool: launch.pool,
        poolFee: market.poolFee,
        isToken0: market.isToken0,
        quoteIn: wallet.buyAmount,
        targetTokens,
        restricted,
      });
      return result
        ? { status: "filled", wallet, result }
        : { status: "dry-run", wallet, expectedTokens: targetTokens };
    } catch (error) {
      log.error({ error, attempt, wallet: wallet.label }, "Pons v1 buy attempt failed");
      return { status: "failed", wallet, reason: redactError(error).slice(0, 200) };
    }
  });
}

async function executeV1Buy(args: {
  wallet: RuntimeWallet;
  store: StateStore;
  token: Address;
  pool: Address;
  poolFee: number;
  isToken0: boolean;
  quoteIn: bigint;
  targetTokens: bigint;
  restricted: boolean;
}): Promise<V1BuyResult | null> {
  const swap = args.restricted
    ? encodeFunctionData({
        abi: uniswapV3RouterAbi,
        functionName: "exactOutputSingle",
        args: [{
          tokenIn: PONS_V1.weth,
          tokenOut: args.token,
          fee: args.poolFee,
          recipient: args.wallet.address,
          amountOut: args.targetTokens,
          amountInMaximum: args.quoteIn,
          sqrtPriceLimitX96: 0n,
        }],
      })
    : encodeFunctionData({
        abi: uniswapV3RouterAbi,
        functionName: "exactInputSingle",
        args: [{
          tokenIn: PONS_V1.weth,
          tokenOut: args.token,
          fee: args.poolFee,
          recipient: args.wallet.address,
          amountIn: args.quoteIn,
          amountOutMinimum: args.targetTokens,
          sqrtPriceLimitX96: 0n,
        }],
      });
  const calls: readonly Hex[] = args.restricted
    ? [swap, encodeFunctionData({ abi: uniswapV3RouterAbi, functionName: "refundETH", args: [] })]
    : [swap];
  const call = {
    account: args.wallet.account,
    address: PONS_V1.swapRouter,
    abi: uniswapV3RouterAbi,
    functionName: "multicall" as const,
    args: [calls] as const,
    value: args.quoteIn,
  };
  await publicClient.simulateContract(call);
  if (runtimeConfig.DRY_RUN) return null;

  const gas = bufferedGas(await publicClient.estimateContractGas(call));
  const fees = await publicClient.estimateFeesPerGas();
  const txHash = await args.wallet.nonces.use(async (nonce) => {
    const hash = await args.wallet.client.writeContract({
      account: args.wallet.account,
      chain: robinhoodChain,
      address: PONS_V1.swapRouter,
      abi: uniswapV3RouterAbi,
      functionName: "multicall",
      args: [calls],
      value: args.quoteIn,
      gas,
      nonce,
      ...fees,
    });
    args.store.recordTransaction({
      hash,
      wallet: args.wallet.address,
      token: args.token,
      action: "buy",
      nonce,
      status: "submitted",
      amountIn: args.quoteIn,
      minOut: args.targetTokens,
      actualOut: null,
      error: null,
      submittedAt: Date.now(),
      confirmedAt: null,
      blockNumber: null,
    });
    return hash;
  });

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("Pons v1 buy reverted on chain");
    const fill = readV1Swap(receipt, args.pool, args.isToken0);
    if (!fill || fill.tokensOut <= 0n) throw new Error("Pons v1 Swap event missing from buy receipt");
    args.store.updateTransaction(txHash, "confirmed", {
      actualOut: fill.tokensOut,
      confirmedAt: Date.now(),
      blockNumber: receipt.blockNumber,
    });
    return { txHash, receipt, tokensOut: fill.tokensOut, spent: fill.quoteIn };
  } catch (error) {
    args.store.updateTransaction(txHash, "failed", { error: redactError(error), confirmedAt: Date.now() });
    throw error;
  }
}

export async function executeV1Sell(args: {
  wallet: RuntimeWallet;
  store: StateStore;
  token: Address;
  market: V1Market;
  tokensIn: bigint;
  minQuoteOut: bigint;
}): Promise<V1SellResult | null> {
  const approved = await ensureApproval(args);
  if (!approved && runtimeConfig.DRY_RUN) return null;
  const swap = encodeFunctionData({
    abi: uniswapV3RouterAbi,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: args.token,
      tokenOut: PONS_V1.weth,
      fee: args.market.poolFee,
      recipient: PONS_V1.swapRouter,
      amountIn: args.tokensIn,
      amountOutMinimum: args.minQuoteOut,
      sqrtPriceLimitX96: 0n,
    }],
  });
  const unwrap = encodeFunctionData({
    abi: uniswapV3RouterAbi,
    functionName: "unwrapWETH9",
    args: [args.minQuoteOut, args.wallet.address],
  });
  const calls = [swap, unwrap] as const;
  const call = {
    account: args.wallet.account,
    address: PONS_V1.swapRouter,
    abi: uniswapV3RouterAbi,
    functionName: "multicall" as const,
    args: [calls] as const,
  };
  await publicClient.simulateContract(call);
  if (runtimeConfig.DRY_RUN) return null;

  const gas = bufferedGas(await publicClient.estimateContractGas(call));
  const fees = await publicClient.estimateFeesPerGas();
  const txHash = await args.wallet.nonces.use(async (nonce) => {
    const hash = await args.wallet.client.writeContract({
      account: args.wallet.account,
      chain: robinhoodChain,
      address: PONS_V1.swapRouter,
      abi: uniswapV3RouterAbi,
      functionName: "multicall",
      args: [calls],
      gas,
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
      minOut: args.minQuoteOut,
      actualOut: null,
      error: null,
      submittedAt: Date.now(),
      confirmedAt: null,
      blockNumber: null,
    });
    return hash;
  });

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("Pons v1 sell reverted on chain");
    const fill = readV1Swap(receipt, args.market.pool, args.market.isToken0);
    if (!fill || fill.quoteOut <= 0n) throw new Error("Pons v1 Swap event missing from sell receipt");
    args.store.updateTransaction(txHash, "confirmed", {
      actualOut: fill.quoteOut,
      confirmedAt: Date.now(),
      blockNumber: receipt.blockNumber,
    });
    return { txHash, receipt, quoteOut: fill.quoteOut };
  } catch (error) {
    args.store.updateTransaction(txHash, "failed", { error: redactError(error), confirmedAt: Date.now() });
    throw error;
  }
}

async function ensureApproval(args: {
  wallet: RuntimeWallet;
  store: StateStore;
  token: Address;
  tokensIn: bigint;
}): Promise<boolean> {
  const allowance = await publicClient.readContract({
    address: args.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [args.wallet.address, PONS_V1.swapRouter],
  });
  if (allowance >= args.tokensIn) return true;
  if (runtimeConfig.DRY_RUN) return false;

  const hash = await args.wallet.nonces.use(async (nonce) => {
    const txHash = await args.wallet.client.writeContract({
      account: args.wallet.account,
      chain: robinhoodChain,
      address: args.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [PONS_V1.swapRouter, args.tokensIn],
      nonce,
    });
    args.store.recordTransaction({
      hash: txHash,
      wallet: args.wallet.address,
      token: args.token,
      action: "approve",
      nonce,
      status: "submitted",
      amountIn: args.tokensIn,
      minOut: 0n,
      actualOut: null,
      error: null,
      submittedAt: Date.now(),
      confirmedAt: null,
      blockNumber: null,
    });
    return txHash;
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  args.store.updateTransaction(hash, receipt.status === "success" ? "confirmed" : "failed", {
    confirmedAt: Date.now(),
    blockNumber: receipt.blockNumber,
  });
  if (receipt.status !== "success") throw new Error(`Pons v1 approval ${hash} reverted`);
  return true;
}

async function waitForBlockAfter(block: bigint): Promise<bigint> {
  let head = await publicClient.getBlockNumber();
  while (head <= block) {
    await new Promise<void>((resolve) => setTimeout(resolve, runtimeConfig.POLL_INTERVAL_MS));
    head = await publicClient.getBlockNumber();
  }
  return head;
}

async function runControlledBatches<T, R>(
  items: readonly T[],
  execution: CampaignExecution,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const resultPromises: Promise<R[]>[] = [];
  for (let start = 0; start < items.length; start += execution.batchSize) {
    const batch = items.slice(start, start + execution.batchSize);
    const running = Promise.all(batch.map((item, offset) => task(item, start + offset)));
    resultPromises.push(running);
    if (execution.confirmEachBatch) await running;
    if (start + execution.batchSize < items.length && execution.batchDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, execution.batchDelayMs));
    }
  }
  return (await Promise.all(resultPromises)).flat();
}

function resolveSlippage(wallet: RuntimeWallet, first: bigint, last: bigint): number {
  if (wallet.strategy.entry.slippageBps !== null) return wallet.strategy.entry.slippageBps;
  if (first <= 0n || last <= 0n) return 2_500;
  const movement = first > last ? Number(((first - last) * 10_000n) / first) : 0;
  return Math.max(100, Math.min(2_500, 100 + Math.ceil(movement / 4)));
}

function bufferedGas(estimate: bigint): bigint {
  return (estimate * BigInt(Math.ceil(runtimeConfig.GAS_LIMIT_MULTIPLIER * 1_000))) / 1_000n;
}

function readV1Swap(
  receipt: TransactionReceipt,
  pool: Address,
  isToken0: boolean,
): { tokensOut: bigint; quoteIn: bigint; quoteOut: bigint } | null {
  for (const entry of receipt.logs) {
    if (entry.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: uniswapV3PoolAbi,
        data: entry.data,
        topics: entry.topics,
        eventName: "Swap",
      });
      const { amount0, amount1 } = decoded.args;
      const tokenDelta = isToken0 ? amount0 : amount1;
      const quoteDelta = isToken0 ? amount1 : amount0;
      return {
        tokensOut: tokenDelta < 0n ? -tokenDelta : 0n,
        quoteIn: quoteDelta > 0n ? quoteDelta : 0n,
        quoteOut: quoteDelta < 0n ? -quoteDelta : 0n,
      };
    } catch {
      // Ignore non-Swap logs from the pool.
    }
  }
  return null;
}
