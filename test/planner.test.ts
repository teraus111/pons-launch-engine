import assert from "node:assert/strict";
import test from "node:test";
import { planCurveEntries, resizeForImpact } from "../src/core/planner.js";
import type { RuntimeWallet } from "../src/core/wallets.js";
import type { CurveState } from "../src/protocol/v2CurveMath.js";

const state: CurveState = {
  quoteReserve: 1_000_000n,
  tokenReserve: 1_000_000_000n,
  sellableTokens: 800_000_000n,
  feeBps: 100n,
  creatorTaxBps: 0n,
  snipeTaxBps: 0n,
  readAtMs: 0,
};

function wallet(name: string, order: number, amount: string, maxImpact = 9_000): RuntimeWallet {
  return {
    address: `0x${String(order).padStart(40, "0")}`,
    campaign: { name, strategy: "s", enabled: true, exempt: true, order },
    strategy: {
      name: "s",
      entry: {
        amount,
        slippageBps: null,
        maxPriceImpactBps: maxImpact,
        maxSnipeTaxBps: 0,
        onPriceLimit: "resize",
        splitOrders: 1,
      },
      exit: {
        takeProfit: [],
        stopLossMultiple: null,
        trailingStopBps: null,
        breakEvenAfterMultiple: null,
        maxHoldSeconds: null,
      },
    },
  } as unknown as RuntimeWallet;
}

test("curve plan prices later sibling wallets behind earlier fills", () => {
  const plan = planCurveEntries([wallet("A", 1, "0.1"), wallet("B", 2, "0.1")], state, 6);
  assert.equal(plan.entries.length, 2);
  assert.ok(plan.entries[0]!.quote.tokensOut > plan.entries[1]!.quote.tokensOut);
  assert.equal(plan.totalPlannedSpend, 200_000n);
});

test("resizeForImpact finds the largest amount within the limit", () => {
  const resized = resizeForImpact(state, 900_000n, 1_000);
  assert.ok(resized > 0n && resized < 900_000n);
});
