import type { Address } from "viem";
import type { RuntimeWallet } from "./wallets.js";
import { parseAssetAmount } from "./values.js";
import {
  applyBuy,
  quoteBuy,
  type BuyQuote,
  type CurveState,
} from "../protocol/v2CurveMath.js";

export interface PlannedEntry {
  id: string;
  walletName: string;
  wallet: Address;
  order: number;
  part: number;
  parts: number;
  requestedQuoteIn: bigint;
  quoteIn: bigint;
  quote: BuyQuote;
  slippageBps: number;
  action: "buy" | "skip" | "retry";
  reason: string;
}

export interface CurvePlan {
  entries: PlannedEntry[];
  totalRequested: bigint;
  totalPlannedSpend: bigint;
  totalExpectedTokens: bigint;
  finalState: CurveState;
}

export function planCurveEntries(
  wallets: RuntimeWallet[],
  initialState: CurveState,
  quoteDecimals: number,
): CurvePlan {
  let state = initialState;
  const entries: PlannedEntry[] = [];
  let totalRequested = 0n;
  let totalPlannedSpend = 0n;
  let totalExpectedTokens = 0n;

  for (const wallet of wallets) {
    const requested = parseAssetAmount(
      wallet.strategy.entry.amount,
      quoteDecimals,
      `${wallet.strategy.name}.entry.amount`,
    );
    totalRequested += requested;
    const parts = wallet.strategy.entry.splitOrders;
    let remaining = requested;

    for (let part = 1; part <= parts; part += 1) {
      const requestedPart = part === parts ? remaining : requested / BigInt(parts);
      remaining -= requestedPart;
      const planned = planOne(wallet, state, requestedPart, part, parts);
      entries.push(planned);
      if (planned.action !== "buy" || planned.quoteIn <= 0n) continue;
      state = applyBuy(state, planned.quoteIn);
      totalPlannedSpend += planned.quote.spent;
      totalExpectedTokens += planned.quote.tokensOut;
    }
  }

  return { entries, totalRequested, totalPlannedSpend, totalExpectedTokens, finalState: state };
}

function planOne(
  wallet: RuntimeWallet,
  state: CurveState,
  requested: bigint,
  part: number,
  parts: number,
): PlannedEntry {
  let quoteIn = requested;
  let quote = quoteBuy(state, quoteIn);
  const maxImpact = wallet.strategy.entry.maxPriceImpactBps;
  let action: PlannedEntry["action"] = "buy";
  let reason = "within configured price impact";

  if (quote.priceImpactBps > maxImpact) {
    if (wallet.strategy.entry.onPriceLimit === "skip") {
      action = "skip";
      reason = `expected impact ${quote.priceImpactBps} bps exceeds ${maxImpact} bps`;
      quoteIn = 0n;
      quote = quoteBuy(state, 0n);
    } else if (wallet.strategy.entry.onPriceLimit === "retry") {
      action = "retry";
      reason = `price limit exceeded; wait for a fresh state`;
    } else {
      quoteIn = resizeForImpact(state, requested, maxImpact);
      quote = quoteBuy(state, quoteIn);
      if (quoteIn <= 0n || quote.tokensOut <= 0n) {
        action = "skip";
        reason = "no positive order fits the configured price impact";
      } else {
        reason = `resized from ${requested} to ${quoteIn} quote units`;
      }
    }
  }

  const autoSlippage = Math.max(100, Math.min(2_500, 100 + Math.ceil(quote.priceImpactBps / 4)));
  return {
    id: `${wallet.campaign.order}-${part}-${wallet.address.toLowerCase()}`,
    walletName: wallet.campaign.name,
    wallet: wallet.address,
    order: wallet.campaign.order,
    part,
    parts,
    requestedQuoteIn: requested,
    quoteIn,
    quote,
    slippageBps: wallet.strategy.entry.slippageBps ?? autoSlippage,
    action,
    reason,
  };
}

export function resizeForImpact(state: CurveState, requested: bigint, maxImpactBps: number): bigint {
  let low = 0n;
  let high = requested;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (quoteBuy(state, middle).priceImpactBps <= maxImpactBps) low = middle;
    else high = middle - 1n;
  }
  return low;
}
