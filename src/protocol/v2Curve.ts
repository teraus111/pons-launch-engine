import {
  decodeEventLog,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { RuntimeWallet } from "../core/wallets.js";
import type { StateStore } from "../core/store.js";
import { redactError } from "../core/values.js";
import { robinhoodChain } from "../runtime/chain.js";
import { runtimeConfig } from "../runtime/config.js";
import { erc20Abi, ponsV2CurveAbi, TOPIC_CURVE_BUY, TOPIC_CURVE_SELL } from "./contracts.js";
import {
  minTokensOut,
  quoteBuy,
  quoteSell,
  readCurveState,
  type BuyQuote,
} from "./v2CurveMath.js";

export interface CurveBuyResult {
  txHash: Hex;
  receipt: TransactionReceipt;
  tokensOut: bigint;
  spent: bigint;
  quote: BuyQuote;
}

export interface CurveSellResult {
  txHash: Hex;
  receipt: TransactionReceipt;
  quoteOut: bigint;
}

export async function executeCurveBuy(args: {
  client: PublicClient;
  store: StateStore;
  wallet: RuntimeWallet;
  token: Address;
  curve: Address;
  pairToken: Address;
  quoteIn: bigint;
  slippageBps: number;
  maxPriceImpactBps: number;
}): Promise<CurveBuyResult | null> {
  const state = await readCurveState(args.client, args.curve, args.wallet.address);
  const quote = quoteBuy(state, args.quoteIn);
  if (quote.priceImpactBps > args.maxPriceImpactBps) {
    throw new Error(
      `PriceLimit: live impact ${quote.priceImpactBps} bps exceeds ${args.maxPriceImpactBps} bps`,
    );
  }
  const minimum = minTokensOut(quote, args.slippageBps);
  const native = args.pairToken === zeroAddress;
  if (!native) {
    const approved = await ensureApproval(
      args.client,
      args.store,
      args.wallet,
      args.pairToken,
      args.curve,
      args.quoteIn,
    );
    if (!approved) return null;
  }

  const callArgs = [args.quoteIn, minimum, args.wallet.address] as const;
  const value = native ? args.quoteIn : 0n;
  await args.client.simulateContract({
    account: args.wallet.account,
    address: args.curve,
    abi: ponsV2CurveAbi,
    functionName: "buy",
    args: callArgs,
    value,
  });
  if (runtimeConfig.DRY_RUN) return null;

  const estimate = await args.client.estimateContractGas({
    account: args.wallet.account,
    address: args.curve,
    abi: ponsV2CurveAbi,
    functionName: "buy",
    args: callArgs,
    value,
  });
  const fees = await args.client.estimateFeesPerGas();
  const txHash = await args.wallet.nonces.use(async (nonce) => {
    const hash = await args.wallet.client.writeContract({
      account: args.wallet.account,
      chain: robinhoodChain,
      address: args.curve,
      abi: ponsV2CurveAbi,
      functionName: "buy",
      args: callArgs,
      value,
      gas: bufferedGas(estimate),
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
    if (receipt.status !== "success") throw new Error("curve buy reverted on chain");
    const fill = decodeBuy(receipt, args.curve, args.wallet.address);
    args.store.updateTransaction(txHash, "confirmed", {
      actualOut: fill.tokensOut,
      confirmedAt: Date.now(),
      blockNumber: receipt.blockNumber,
    });
    return { txHash, receipt, ...fill, quote };
  } catch (error) {
    args.store.updateTransaction(txHash, "failed", { error: redactError(error), confirmedAt: Date.now() });
    throw error;
  }
}

export async function executeCurveSell(args: {
  client: PublicClient;
  store: StateStore;
  wallet: RuntimeWallet;
  token: Address;
  curve: Address;
  tokensIn: bigint;
  slippageBps: number;
}): Promise<CurveSellResult | null> {
  const [ready, state] = await Promise.all([
    args.client.readContract({ address: args.curve, abi: ponsV2CurveAbi, functionName: "readyToGraduate" }),
    readCurveState(args.client, args.curve, args.wallet.address),
  ]);
  if (ready) throw new Error("CurveGraduated: curve sells are closed; route through v4");
  const expected = quoteSell(state, args.tokensIn);
  const minimum = (expected * (10_000n - BigInt(args.slippageBps))) / 10_000n;
  const approved = await ensureApproval(
    args.client,
    args.store,
    args.wallet,
    args.token,
    args.curve,
    args.tokensIn,
  );
  if (!approved) return null;
  const callArgs = [args.tokensIn, minimum, args.wallet.address] as const;
  await args.client.simulateContract({
    account: args.wallet.account,
    address: args.curve,
    abi: ponsV2CurveAbi,
    functionName: "sell",
    args: callArgs,
  });
  if (runtimeConfig.DRY_RUN) return null;

  const estimate = await args.client.estimateContractGas({
    account: args.wallet.account,
    address: args.curve,
    abi: ponsV2CurveAbi,
    functionName: "sell",
    args: callArgs,
  });
  const fees = await args.client.estimateFeesPerGas();
  const txHash = await args.wallet.nonces.use(async (nonce) => {
    const hash = await args.wallet.client.writeContract({
      account: args.wallet.account,
      chain: robinhoodChain,
      address: args.curve,
      abi: ponsV2CurveAbi,
      functionName: "sell",
      args: callArgs,
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
    if (receipt.status !== "success") throw new Error("curve sell reverted on chain");
    const quoteOut = decodeSell(receipt, args.curve);
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

async function ensureApproval(
  client: PublicClient,
  store: StateStore,
  wallet: RuntimeWallet,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<boolean> {
  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.address, spender],
  });
  if (allowance >= amount) return true;
  if (runtimeConfig.DRY_RUN) return false;
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
    store.recordTransaction({
      hash: txHash,
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
    return txHash;
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  store.updateTransaction(hash, receipt.status === "success" ? "confirmed" : "failed", {
    confirmedAt: Date.now(),
    blockNumber: receipt.blockNumber,
  });
  if (receipt.status !== "success") throw new Error(`Approval ${hash} reverted`);
  return true;
}

function decodeBuy(
  receipt: TransactionReceipt,
  curve: Address,
  recipient: Address,
): { tokensOut: bigint; spent: bigint } {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== curve.toLowerCase() || log.topics[0] !== TOPIC_CURVE_BUY) continue;
    const decoded = decodeEventLog({
      abi: ponsV2CurveAbi,
      eventName: "CurveBuy",
      topics: log.topics,
      data: log.data,
    });
    if (decoded.args.recipient.toLowerCase() !== recipient.toLowerCase()) continue;
    return { tokensOut: decoded.args.tokensOut, spent: decoded.args.quoteIn };
  }
  throw new Error("CurveBuy fill was missing from the receipt");
}

function decodeSell(receipt: TransactionReceipt, curve: Address): bigint {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== curve.toLowerCase() || log.topics[0] !== TOPIC_CURVE_SELL) continue;
    const decoded = decodeEventLog({
      abi: ponsV2CurveAbi,
      eventName: "CurveSell",
      topics: log.topics,
      data: log.data,
    });
    return decoded.args.quoteOut;
  }
  throw new Error("CurveSell fill was missing from the receipt");
}

function bufferedGas(estimate: bigint): bigint {
  return (estimate * BigInt(Math.ceil(runtimeConfig.GAS_LIMIT_MULTIPLIER * 1_000))) / 1_000n;
}
