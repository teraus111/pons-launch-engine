import type { Address, PublicClient } from "viem";
import { BPS, ponsV2CurveAbi } from "./contracts.js";

export interface CurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellableTokens: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  snipeTaxBps: bigint;
  readAtMs: number;
}

export interface BuyQuote {
  tokensOut: bigint;
  spent: bigint;
  refund: bigint;
  totalInputBps: bigint;
  clamped: boolean;
  priceImpactBps: number;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export function amountOut(input: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (input * reserveOut) / (reserveIn + input);
}

export function amountIn(output: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (output * reserveIn) / (reserveOut - output) + 1n;
}

export function effectiveSnipeBps(state: Pick<CurveState, "snipeTaxBps" | "feeBps" | "creatorTaxBps">): bigint {
  if (state.snipeTaxBps <= 0n) return 0n;
  const max = BPS - state.feeBps - state.creatorTaxBps - 100n;
  return state.snipeTaxBps > max ? max : state.snipeTaxBps;
}

export function quoteBuy(state: CurveState, quoteIn: bigint): BuyQuote {
  const snipeBps = effectiveSnipeBps(state);
  let spent = quoteIn;
  const totalInputBps = state.feeBps + state.creatorTaxBps + snipeBps;
  const effectiveIn = spent - (spent * state.feeBps) / BPS
    - (spent * state.creatorTaxBps) / BPS
    - (spent * snipeBps) / BPS;
  let tokensOut = amountOut(effectiveIn, state.quoteReserve, state.tokenReserve);
  let clamped = false;

  if (tokensOut > state.sellableTokens) {
    clamped = true;
    tokensOut = state.sellableTokens;
    const net = amountIn(tokensOut, state.quoteReserve, state.tokenReserve);
    const grossed = ceilDiv(net * BPS, BPS - totalInputBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
  }

  const noImpactTokens = state.quoteReserve === 0n
    ? tokensOut
    : ((spent - (spent * totalInputBps) / BPS) * state.tokenReserve) / state.quoteReserve;
  const priceImpactBps = noImpactTokens > tokensOut && noImpactTokens > 0n
    ? Number(((noImpactTokens - tokensOut) * BPS) / noImpactTokens)
    : 0;

  return {
    tokensOut,
    spent,
    refund: quoteIn - spent,
    totalInputBps,
    clamped,
    priceImpactBps,
  };
}

export function quoteSell(
  state: Pick<CurveState, "quoteReserve" | "tokenReserve" | "feeBps" | "creatorTaxBps">,
  tokensIn: bigint,
): bigint {
  const gross = amountOut(tokensIn, state.tokenReserve, state.quoteReserve);
  return gross - (gross * state.feeBps) / BPS - (gross * state.creatorTaxBps) / BPS;
}

export function applyBuy(state: CurveState, quoteIn: bigint): CurveState {
  const quote = quoteBuy(state, quoteIn);
  const effectiveIn = quote.spent - (quote.spent * quote.totalInputBps) / BPS;
  return {
    ...state,
    quoteReserve: state.quoteReserve + effectiveIn,
    tokenReserve: state.tokenReserve - quote.tokensOut,
    sellableTokens: state.sellableTokens - quote.tokensOut,
  };
}

export function minTokensOut(quote: BuyQuote, slippageBps: number): bigint {
  return (quote.tokensOut * (BPS - BigInt(slippageBps))) / BPS;
}

export async function readCurveState(
  client: PublicClient,
  curve: Address,
  recipient: Address,
): Promise<CurveState> {
  const contract = { address: curve, abi: ponsV2CurveAbi } as const;
  const [reserves, sellableTokens, feeBps, creatorTaxBps, snipeTaxBps] = await Promise.all([
    client.readContract({ ...contract, functionName: "getReserves" }),
    client.readContract({ ...contract, functionName: "sellableTokens" }),
    client.readContract({ ...contract, functionName: "feeBps" }),
    client.readContract({ ...contract, functionName: "creatorTaxBps" }),
    client.readContract({ ...contract, functionName: "currentSnipeTaxBps", args: [recipient] }),
  ]);
  return {
    quoteReserve: reserves[0],
    tokenReserve: reserves[1],
    sellableTokens,
    feeBps,
    creatorTaxBps,
    snipeTaxBps,
    readAtMs: Date.now(),
  };
}
