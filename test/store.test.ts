import assert from "node:assert/strict";
import test from "node:test";
import { StateStore } from "../src/core/store.js";

const wallet = "0x1111111111111111111111111111111111111111" as const;
const token = "0x2222222222222222222222222222222222222222" as const;
const curve = "0x3333333333333333333333333333333333333333" as const;
const poolManager = "0x4444444444444444444444444444444444444444" as const;
const pair = "0x0000000000000000000000000000000000000000" as const;
const hash = `0x${"4".repeat(64)}` as const;

test("StateStore persists launch, transaction, position, and rule state", () => {
  const store = new StateStore(":memory:");
  const now = Date.now();
  store.upsertLaunch({
    token,
    protocol: "v2",
    venue: "v2-curve",
    venueAddress: curve,
    pairToken: pair,
    quoteDecimals: 18,
    deployer: wallet,
    launchBlock: 10n,
    stage: "curve",
    rawJson: "{}",
    createdAt: now,
    updatedAt: now,
  });
  store.recordTransaction({
    hash,
    wallet,
    token,
    action: "buy",
    nonce: 2,
    status: "submitted",
    amountIn: 100n,
    minOut: 90n,
    actualOut: null,
    error: null,
    submittedAt: now,
    confirmedAt: null,
    blockNumber: null,
  });
  store.upsertPosition({
    wallet,
    walletName: "Wallet 1",
    token,
    protocol: "v2",
    venue: "v2-curve",
    venueAddress: curve,
    pairToken: pair,
    quoteDecimals: 18,
    symbol: "TEST",
    tokens: 1_000n,
    costBasis: 100n,
    realizedQuote: 0n,
    openedAt: now,
    entryTxHash: hash,
    strategyId: "opening",
    status: "open",
    highestMultiple: 1,
    closedAt: null,
    updatedAt: now,
  });
  store.markRuleTriggered(wallet, token, "tp-1", hash);

  assert.equal(store.getLaunch(token)?.launchBlock, 10n);
  assert.equal(store.getPosition(wallet, token)?.tokens, 1_000n);
  assert.equal(store.listPendingTransactions().length, 1);
  assert.equal(store.isRuleTriggered(wallet, token, "tp-1"), true);
  assert.deepEqual(store.summary(), { launches: 1, openPositions: 1, pendingTransactions: 1 });

  store.updateTransaction(hash, "confirmed", { actualOut: 1_000n, blockNumber: 11n });
  assert.equal(store.listPendingTransactions().length, 0);
  store.updateLaunchStage(token, "pool", "v2-v4", poolManager);
  assert.equal(store.getLaunch(token)?.venue, "v2-v4");
  assert.equal(store.getLaunch(token)?.venueAddress, poolManager);
  store.close();
});
