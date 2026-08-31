import type { Address } from "viem";
import type { CampaignExecution } from "./types.js";
import { redactError } from "./values.js";

export interface ScheduledJob<T> {
  id: string;
  wallet: Address;
  lane?: string;
  execute: (attempt: number) => Promise<T>;
}

export interface ScheduledOutcome<T> {
  id: string;
  wallet: Address;
  status: "fulfilled" | "rejected";
  attempts: number;
  value: T | null;
  error: string | null;
}

export interface SchedulerEvents {
  onBatchStart?: (batchIndex: number, jobIds: string[]) => void;
  onRetry?: (jobId: string, attempt: number, error: string) => void;
}

export interface SchedulerClock {
  sleep(ms: number): Promise<void>;
}

const defaultClock: SchedulerClock = {
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export class ExecutionScheduler {
  private readonly walletTails = new Map<string, Promise<void>>();

  constructor(
    private readonly settings: CampaignExecution,
    private readonly clock: SchedulerClock = defaultClock,
  ) {}

  async run<T>(jobs: ScheduledJob<T>[], events: SchedulerEvents = {}): Promise<ScheduledOutcome<T>[]> {
    const outcomes: ScheduledOutcome<T>[] = [];
    const background: Promise<void>[] = [];
    const batches = batchesOf(jobs, this.settings.batchSize);

    for (const [batchIndex, batch] of batches.entries()) {
      events.onBatchStart?.(batchIndex, batch.map((job) => job.id));
      const running = batch.map((job) => this.inExecutionLane(
        job.lane ?? job.wallet,
        () => this.runOne(job, events),
      ));

      if (this.settings.confirmEachBatch) {
        outcomes.push(...await Promise.all(running));
      } else {
        const placeholders = running.map(async (result): Promise<void> => {
          outcomes.push(await result);
        });
        background.push(...placeholders);
      }

      if (batchIndex < batches.length - 1 && this.settings.batchDelayMs > 0) {
        await this.clock.sleep(this.settings.batchDelayMs);
      }
    }

    if (background.length > 0) await Promise.all(background);

    return outcomes.sort((a, b) => jobs.findIndex((job) => job.id === a.id) - jobs.findIndex((job) => job.id === b.id));
  }

  private async runOne<T>(
    job: ScheduledJob<T>,
    events: SchedulerEvents,
  ): Promise<ScheduledOutcome<T>> {
    let lastError = "unknown execution failure";
    let lastAttempt = 0;
    const totalAttempts = this.settings.maxRetries + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      lastAttempt = attempt;
      try {
        return {
          id: job.id,
          wallet: job.wallet,
          status: "fulfilled",
          attempts: attempt,
          value: await job.execute(attempt),
          error: null,
        };
      } catch (error) {
        lastError = redactError(error);
        if (attempt >= totalAttempts || !isRetryable(error)) break;
        events.onRetry?.(job.id, attempt, lastError);
        if (this.settings.retryDelayMs > 0) await this.clock.sleep(this.settings.retryDelayMs);
      }
    }

    return {
      id: job.id,
      wallet: job.wallet,
      status: "rejected",
      attempts: lastAttempt,
      value: null,
      error: lastError,
    };
  }

  private async inExecutionLane<T>(lane: string, fn: () => Promise<T>): Promise<T> {
    const key = lane.toLowerCase();
    const prior = this.walletTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate);
    this.walletTails.set(key, tail);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.walletTails.get(key) === tail) this.walletTails.delete(key);
    }
  }
}

export function batchesOf<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error("batch size must be a positive integer");
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function isRetryable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const permanent = [
    "slippageexceeded",
    "insufficient funds",
    "execution reverted",
    "curveuated",
    "curvegraduated",
    "pairtokennotapproved",
    "launcheconomicsmismatch",
    "snipetaxnotacceptable",
    "pricelimit:",
    "user rejected",
  ];
  if (permanent.some((needle) => message.includes(needle))) return false;
  return [
    "timeout",
    "timed out",
    "rate limit",
    "429",
    "connection",
    "socket",
    "temporarily unavailable",
    "nonce too low",
    "replacement transaction underpriced",
  ].some((needle) => message.includes(needle));
}
