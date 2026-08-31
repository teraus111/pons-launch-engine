import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionScheduler, type SchedulerClock } from "../src/core/scheduler.js";

const walletA = "0x1111111111111111111111111111111111111111" as const;
const walletB = "0x2222222222222222222222222222222222222222" as const;

test("ExecutionScheduler starts controlled batches and retries transient failures", async () => {
  const sleeps: number[] = [];
  const clock: SchedulerClock = { sleep: async (ms) => { sleeps.push(ms); } };
  const scheduler = new ExecutionScheduler({
    batchSize: 2,
    batchDelayMs: 50,
    confirmEachBatch: true,
    maxRetries: 1,
    retryDelayMs: 250,
  }, clock);
  let attempts = 0;
  const batches: string[][] = [];
  const outcomes = await scheduler.run([
    { id: "a", wallet: walletA, execute: async () => "a" },
    {
      id: "b",
      wallet: walletB,
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("RPC timeout");
        return "b";
      },
    },
    { id: "c", wallet: walletA, execute: async () => "c" },
  ], {
    onBatchStart: (_index, ids) => batches.push(ids),
  });

  assert.deepEqual(batches, [["a", "b"], ["c"]]);
  assert.deepEqual(sleeps, [250, 50]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled", "fulfilled"]);
  assert.equal(outcomes[1]?.attempts, 2);
});

test("ExecutionScheduler preserves same-wallet ordering without globally serializing", async () => {
  const scheduler = new ExecutionScheduler({
    batchSize: 3,
    batchDelayMs: 0,
    confirmEachBatch: false,
    maxRetries: 0,
    retryDelayMs: 0,
  });
  const events: string[] = [];
  await scheduler.run([
    { id: "a1", wallet: walletA, execute: async () => { events.push("a1"); return 1; } },
    { id: "a2", wallet: walletA, execute: async () => { events.push("a2"); return 2; } },
    { id: "b1", wallet: walletB, execute: async () => { events.push("b1"); return 3; } },
  ]);
  assert.ok(events.indexOf("a1") < events.indexOf("a2"));
  assert.equal(events.length, 3);
});

test("ExecutionScheduler does not retry permanent failures", async () => {
  const scheduler = new ExecutionScheduler({
    batchSize: 1,
    batchDelayMs: 0,
    confirmEachBatch: true,
    maxRetries: 3,
    retryDelayMs: 0,
  });
  let calls = 0;
  const [outcome] = await scheduler.run([{
    id: "permanent",
    wallet: walletA,
    execute: async () => {
      calls += 1;
      throw new Error("insufficient funds");
    },
  }]);
  assert.equal(calls, 1);
  assert.equal(outcome?.attempts, 1);
  assert.equal(outcome?.status, "rejected");
});

test("ExecutionScheduler serializes different wallets sharing a market lane", async () => {
  const scheduler = new ExecutionScheduler({
    batchSize: 2,
    batchDelayMs: 0,
    confirmEachBatch: false,
    maxRetries: 0,
    retryDelayMs: 0,
  });
  const events: string[] = [];
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const run = scheduler.run([
    {
      id: "first",
      wallet: walletA,
      lane: "curve:one",
      execute: async () => {
        events.push("first:start");
        markStarted();
        await firstGate;
        events.push("first:end");
      },
    },
    {
      id: "second",
      wallet: walletB,
      lane: "curve:one",
      execute: async () => { events.push("second:start"); },
    },
  ]);
  await started;
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await run;
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});
