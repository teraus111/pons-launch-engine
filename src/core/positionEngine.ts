import type { Address, PublicClient } from "viem";
import type { PositionRecord, StrategyProfile } from "./types.js";
import type { StateStore } from "./store.js";
import type { RuntimeWallet } from "./wallets.js";
import { requireStrategy } from "./strategies.js";
import { bigintRatio } from "./values.js";
import { log } from "../runtime/logger.js";
import { executeCurveSell } from "../protocol/v2Curve.js";
import { ponsV2CurveAbi } from "../protocol/contracts.js";
import { quoteSell, readCurveState } from "../protocol/v2CurveMath.js";
import { pushStalledGraduation, readV2Lifecycle } from "../protocol/v2Lifecycle.js";
import type { V4SwapAdapter } from "../protocol/v4Adapter.js";
import { UniswapV4Adapter } from "../protocol/uniswapV4.js";
import {
  executeV1Sell,
  quoteV1ExactInput,
  type V1Market,
} from "../v1.js";
import { PONS_V1, ponsV1TokenAbi, UNISWAP_V4 } from "../protocol/contracts.js";

export class DurablePositionEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly client: PublicClient,
    private readonly store: StateStore,
    private readonly wallets: RuntimeWallet[],
    private readonly strategies: Map<string, StrategyProfile>,
    private readonly v4: V4SwapAdapter = new UniswapV4Adapter(),
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const position of this.store.listOpenPositions()) {
        try {
          await this.evaluate(position);
        } catch (error) {
          log.error(
            { error, token: position.token, wallet: position.walletName },
            "position evaluation failed",
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  async liquidateAll(reason: string): Promise<void> {
    for (const position of this.store.listOpenPositions()) {
      const strategy = requireStrategy(this.strategies, position.strategyId);
      await this.exit(position, strategy, position.tokens, `emergency:${reason}`, "emergency");
    }
  }

  private async evaluate(position: PositionRecord): Promise<void> {
    const strategy = requireStrategy(this.strategies, position.strategyId);
    let value: bigint;

    if (position.protocol === "v1") {
      const poolFee = Number(await this.client.readContract({
        address: position.token,
        abi: ponsV1TokenAbi,
        functionName: "poolFee",
      }));
      value = await quoteV1ExactInput({
        tokenIn: position.token,
        tokenOut: PONS_V1.weth,
        amountIn: position.tokens,
        poolFee,
      });
    } else {
      const lifecycle = await readV2Lifecycle(this.client, position.token);
      if (lifecycle.stage === "rescued") {
        log.error({ token: position.token }, "position launch entered the Pons rescue state");
        return;
      }
      if (lifecycle.stage === "swept") {
        const wallet = this.walletFor(position.wallet);
        await pushStalledGraduation({ client: this.client, store: this.store, wallet, token: position.token });
        return;
      }
      if (lifecycle.stage === "pool") {
        if (position.venue !== "v2-v4") {
          position.venue = "v2-v4";
          position.venueAddress = UNISWAP_V4.poolManager;
          position.updatedAt = Date.now();
          this.store.upsertPosition(position);
          this.store.updateLaunchStage(position.token, "pool", "v2-v4", UNISWAP_V4.poolManager);
        }
        if (!this.v4.available) {
          log.warn(
            { token: position.token, wallet: position.walletName, poolId: lifecycle.poolId },
            "position graduated; retained in durable state until a v4 router adapter is configured",
          );
          return;
        }
        value = await this.v4.quoteSell({
          client: this.client,
          lifecycle,
          token: position.token,
          tokensIn: position.tokens,
        });
      } else {
        const ready = await this.client.readContract({
          address: lifecycle.curve,
          abi: ponsV2CurveAbi,
          functionName: "readyToGraduate",
        });
        if (ready) {
          log.info({ token: position.token }, "curve sell side closed; awaiting pool graduation");
          return;
        }
        const state = await readCurveState(this.client, lifecycle.curve, position.wallet);
        value = quoteSell(state, position.tokens);
      }
    }

    await this.applyRules(position, strategy, value);
  }

  private async applyRules(
    position: PositionRecord,
    strategy: StrategyProfile,
    value: bigint,
  ): Promise<void> {
    const multiple = bigintRatio(value, position.costBasis);
    const highest = Math.max(position.highestMultiple, multiple);
    if (highest !== position.highestMultiple) {
      position.highestMultiple = highest;
      position.updatedAt = Date.now();
      this.store.upsertPosition(position);
    }

    if (strategy.exit.stopLossMultiple !== null && multiple <= strategy.exit.stopLossMultiple) {
      await this.exit(position, strategy, position.tokens, `stop-loss:${multiple.toFixed(3)}x`, "stop-loss");
      return;
    }

    if (
      strategy.exit.breakEvenAfterMultiple !== null &&
      highest >= strategy.exit.breakEvenAfterMultiple &&
      multiple <= 1
    ) {
      await this.exit(position, strategy, position.tokens, `break-even:${multiple.toFixed(3)}x`, "break-even");
      return;
    }

    if (strategy.exit.trailingStopBps !== null && highest > 1) {
      const floor = highest * (1 - strategy.exit.trailingStopBps / 10_000);
      if (multiple <= floor) {
        await this.exit(position, strategy, position.tokens, `trailing-stop:${multiple.toFixed(3)}x`, "trailing-stop");
        return;
      }
    }

    if (
      strategy.exit.maxHoldSeconds !== null &&
      Date.now() - position.openedAt >= strategy.exit.maxHoldSeconds * 1_000
    ) {
      await this.exit(position, strategy, position.tokens, "maximum-hold-time", "max-hold");
      return;
    }

    for (const rule of strategy.exit.takeProfit) {
      if (multiple < rule.atMultiple || this.store.isRuleTriggered(position.wallet, position.token, rule.id)) {
        continue;
      }
      const amount = (position.tokens * BigInt(rule.sellBps)) / 10_000n;
      await this.exit(position, strategy, amount > 0n ? amount : 1n, `take-profit:${rule.id}`, rule.id);
      return;
    }
  }

  private async exit(
    position: PositionRecord,
    strategy: StrategyProfile,
    tokensIn: bigint,
    reason: string,
    ruleId: string,
  ): Promise<void> {
    const key = `${position.wallet.toLowerCase()}:${position.token.toLowerCase()}`;
    if (this.inFlight.has(key) || tokensIn <= 0n) return;
    this.inFlight.add(key);
    try {
      const wallet = this.walletFor(position.wallet);
      const slippageBps = strategy.entry.slippageBps ?? 300;
      let result: { txHash: `0x${string}`; quoteOut: bigint } | null = null;

      if (position.protocol === "v1") {
        const poolFee = Number(await this.client.readContract({
          address: position.token,
          abi: ponsV1TokenAbi,
          functionName: "poolFee",
        }));
        const market: V1Market = {
          pool: position.venueAddress,
          poolFee,
          isToken0: position.token.toLowerCase() < position.pairToken.toLowerCase(),
        };
        const expected = await quoteV1ExactInput({
          tokenIn: position.token,
          tokenOut: PONS_V1.weth,
          amountIn: tokensIn,
          poolFee: market.poolFee,
        });
        const sold = await executeV1Sell({
          wallet,
          store: this.store,
          token: position.token,
          market,
          tokensIn,
          minQuoteOut: (expected * (10_000n - BigInt(slippageBps))) / 10_000n,
        });
        result = sold ? { txHash: sold.txHash, quoteOut: sold.quoteOut } : null;
      } else {
        const lifecycle = await readV2Lifecycle(this.client, position.token);
        if (lifecycle.stage === "pool") {
          if (!this.v4.available) throw new Error("Graduated position cannot exit without a v4 adapter");
          const sold = await this.v4.sell({
            client: this.client,
            store: this.store,
            wallet,
            lifecycle,
            token: position.token,
            tokensIn,
            slippageBps,
          });
          result = sold ? { txHash: sold.txHash, quoteOut: sold.quoteOut } : null;
        } else if (lifecycle.stage === "curve") {
          const sold = await executeCurveSell({
            client: this.client,
            store: this.store,
            wallet,
            token: position.token,
            curve: lifecycle.curve,
            tokensIn,
            slippageBps,
          });
          result = sold ? { txHash: sold.txHash, quoteOut: sold.quoteOut } : null;
        } else {
          throw new Error(`Position is temporarily unavailable in Pons phase ${lifecycle.stage}`);
        }
      }

      if (!result) return;
      const amount = tokensIn > position.tokens ? position.tokens : tokensIn;
      const basisSold = (position.costBasis * amount) / position.tokens;
      const remaining = position.tokens - amount;
      const updated: PositionRecord = {
        ...position,
        tokens: remaining,
        costBasis: position.costBasis - basisSold,
        realizedQuote: position.realizedQuote + result.quoteOut,
        status: remaining === 0n ? "closed" : "open",
        closedAt: remaining === 0n ? Date.now() : null,
        updatedAt: Date.now(),
      };
      this.store.transaction(() => {
        this.store.upsertPosition(updated);
        this.store.markRuleTriggered(position.wallet, position.token, ruleId, result!.txHash);
      });
      log.info(
        { token: position.token, wallet: position.walletName, reason, quoteOut: result.quoteOut.toString() },
        remaining === 0n ? "position closed" : "position partially sold",
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  private walletFor(address: Address): RuntimeWallet {
    const wallet = this.wallets.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase());
    if (!wallet) throw new Error(`No loaded credential for position wallet ${address}`);
    return wallet;
  }
}
