import { readFileSync } from "node:fs";
import { z } from "zod";
import type { StrategyProfile } from "./types.js";
import { parseMultiple, parsePercentBps } from "./values.js";

const triggerSchema = z.union([z.string().trim().min(1), z.number().positive()]);
const nullableTriggerSchema = triggerSchema.nullable().default(null);

const storedStrategySchema = z
  .object({
    entry: z
      .object({
        amount: z.string().trim().regex(/^\d+(?:\.\d+)?$/),
        slippage: z.union([z.literal("auto"), z.string().trim()]).default("auto"),
        maxPriceImpact: z.string().trim().default("20%"),
        maxSnipeTax: z.string().trim().default("0%"),
        onPriceLimit: z.enum(["skip", "resize", "retry"]).default("resize"),
        splitOrders: z.number().int().min(1).max(20).default(1),
      })
      .strict(),
    exit: z
      .object({
        takeProfit: z
          .array(
            z
              .object({
                at: triggerSchema,
                sell: z.string().trim(),
              })
              .strict(),
          )
          .default([]),
        stopLoss: nullableTriggerSchema,
        trailingStop: z.string().trim().nullable().default(null),
        breakEvenAfter: nullableTriggerSchema,
        maxHoldSeconds: z.number().int().positive().nullable().default(null),
      })
      .strict(),
  })
  .strict();

const fileSchema = z.record(z.string().trim().min(1), storedStrategySchema);

export function loadStrategies(path = process.env["STRATEGIES_FILE"]?.trim() || "strategies.json"):
  Map<string, StrategyProfile> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${path}: ${detail}`);
  }

  const profiles = new Map<string, StrategyProfile>();
  const normalizedNames = new Set<string>();

  for (const [name, stored] of Object.entries(parsed.data)) {
    const normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      throw new Error(`${path}: duplicate strategy name ignoring case: ${name}`);
    }
    normalizedNames.add(normalizedName);

    const takeProfit = stored.exit.takeProfit.map((rule, index) => ({
      id: `tp-${index + 1}`,
      atMultiple: parseMultiple(rule.at, `${name}.exit.takeProfit[${index}].at`),
      sellBps: parsePercentBps(rule.sell, `${name}.exit.takeProfit[${index}].sell`),
    }));

    let prior = 1;
    let totalSellBps = 0;
    for (const [index, rule] of takeProfit.entries()) {
      if (rule.atMultiple <= 1) {
        throw new Error(`${name}.exit.takeProfit[${index}].at must be above 1x`);
      }
      if (rule.atMultiple <= prior) {
        throw new Error(`${name}.exit.takeProfit thresholds must be strictly increasing`);
      }
      if (rule.sellBps <= 0) {
        throw new Error(`${name}.exit.takeProfit[${index}].sell must be greater than 0%`);
      }
      prior = rule.atMultiple;
      totalSellBps += rule.sellBps;
    }
    if (totalSellBps > 10_000) {
      throw new Error(`${name}.exit.takeProfit sells total more than 100%`);
    }

    const stopLossMultiple = stored.exit.stopLoss === null
      ? null
      : parseMultiple(stored.exit.stopLoss, `${name}.exit.stopLoss`);
    if (stopLossMultiple !== null && stopLossMultiple >= 1) {
      throw new Error(`${name}.exit.stopLoss must be below 1x`);
    }

    const trailingStopBps = stored.exit.trailingStop === null
      ? null
      : parsePercentBps(stored.exit.trailingStop, `${name}.exit.trailingStop`, false);
    if (trailingStopBps !== null && trailingStopBps <= 0) {
      throw new Error(`${name}.exit.trailingStop must be greater than 0%`);
    }

    const breakEvenAfterMultiple = stored.exit.breakEvenAfter === null
      ? null
      : parseMultiple(stored.exit.breakEvenAfter, `${name}.exit.breakEvenAfter`);
    if (breakEvenAfterMultiple !== null && breakEvenAfterMultiple <= 1) {
      throw new Error(`${name}.exit.breakEvenAfter must be above 1x`);
    }

    const slippageBps = stored.entry.slippage === "auto"
      ? null
      : parsePercentBps(stored.entry.slippage, `${name}.entry.slippage`, false);
    const maxPriceImpactBps = parsePercentBps(
      stored.entry.maxPriceImpact,
      `${name}.entry.maxPriceImpact`,
      false,
    );
    const maxSnipeTaxBps = parsePercentBps(
      stored.entry.maxSnipeTax,
      `${name}.entry.maxSnipeTax`,
      false,
    );

    profiles.set(name, {
      name,
      entry: {
        amount: stored.entry.amount,
        slippageBps,
        maxPriceImpactBps,
        maxSnipeTaxBps,
        onPriceLimit: stored.entry.onPriceLimit,
        splitOrders: stored.entry.splitOrders,
      },
      exit: {
        takeProfit,
        stopLossMultiple,
        trailingStopBps,
        breakEvenAfterMultiple,
        maxHoldSeconds: stored.exit.maxHoldSeconds,
      },
    });
  }

  if (profiles.size === 0) throw new Error(`${path} must define at least one strategy`);
  return profiles;
}

export function requireStrategy(
  profiles: Map<string, StrategyProfile>,
  name: string,
): StrategyProfile {
  const direct = profiles.get(name);
  if (direct) return direct;
  const found = [...profiles.values()].find((profile) => profile.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`Unknown strategy "${name}"`);
  return found;
}
