import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { Campaign, StrategyProfile } from "./types.js";
import { parsePercentBps } from "./values.js";
import { requireStrategy } from "./strategies.js";

const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte EVM address")
  .transform((value) => getAddress(value));

const nullableAddressSchema = addressSchema.nullable().default(null);
const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex);

const launchTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    symbol: z.string().trim().min(1).max(32),
    logo: z.string().trim().min(1).optional(),
    logoFile: z.string().trim().min(1).optional(),
    description: z.string().trim().max(2_000).default(""),
    socials: z
      .object({
        twitter: z.string().trim().default(""),
        telegram: z.string().trim().default(""),
        discord: z.string().trim().default(""),
        website: z.string().trim().default(""),
        farcaster: z.string().trim().default(""),
      })
      .strict(),
  })
  .strict()
  .superRefine((token, context) => {
    if (Boolean(token.logo) === Boolean(token.logoFile)) {
      context.addIssue({
        code: "custom",
        message: "set exactly one of logo or logoFile",
      });
    }
  });

const launchSchema = z
  .object({
    creatorWallet: z.string().trim().min(1),
    initialBuyWallet: z.string().trim().min(1),
    launchConfigId: z.string().regex(/^\d+$/),
    pairToken: z.union([z.literal("native"), addressSchema]),
    creatorFeeRecipient: addressSchema,
    creatorTax: z.string().trim(),
    buybackEnabled: z.boolean().default(false),
    salt: z.union([z.literal("auto"), hex32Schema]).default("auto"),
    token: launchTokenSchema,
  })
  .strict();

const campaignSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: z.enum(["monitor", "launch-and-buy", "direct-token"]),
    protocols: z.array(z.enum(["v1", "v2"])).min(1),
    target: z
      .object({
        deployer: nullableAddressSchema,
        token: nullableAddressSchema,
      })
      .strict(),
    wallets: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            strategy: z.string().trim().min(1),
            enabled: z.boolean().default(true),
            exempt: z.boolean().default(false),
            order: z.number().int().min(1),
          })
          .strict(),
      )
      .min(1),
    execution: z
      .object({
        batchSize: z.number().int().min(1).max(50).default(4),
        batchDelayMs: z.number().int().min(0).max(60_000).default(50),
        confirmEachBatch: z.boolean().default(true),
        maxRetries: z.number().int().min(0).max(10).default(2),
        retryDelayMs: z.number().int().min(0).max(60_000).default(250),
      })
      .strict(),
    launch: launchSchema.nullable().optional(),
  })
  .strict();

export function loadCampaign(path = process.env["CAMPAIGN_FILE"]?.trim() || "campaign.json"): Campaign {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = campaignSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${path}: ${detail}`);
  }

  const stored = parsed.data;
  const names = new Set<string>();
  const orders = new Set<number>();
  for (const wallet of stored.wallets) {
    const key = wallet.name.toLowerCase();
    if (names.has(key)) throw new Error(`${path}: duplicate campaign wallet ${wallet.name}`);
    if (orders.has(wallet.order)) throw new Error(`${path}: duplicate wallet order ${wallet.order}`);
    names.add(key);
    orders.add(wallet.order);
  }

  if (stored.mode === "monitor" && stored.target.deployer === null) {
    throw new Error(`${path}: monitor mode requires target.deployer`);
  }
  if (stored.mode === "direct-token" && stored.target.token === null) {
    throw new Error(`${path}: direct-token mode requires target.token`);
  }
  if (stored.mode === "direct-token" && (stored.protocols.length !== 1 || stored.protocols[0] !== "v2")) {
    throw new Error(`${path}: direct-token mode supports only protocol v2`);
  }
  if (stored.mode === "launch-and-buy" && !stored.launch) {
    throw new Error(`${path}: launch-and-buy mode requires launch settings`);
  }
  if (stored.mode === "launch-and-buy" && (stored.protocols.length !== 1 || stored.protocols[0] !== "v2")) {
    throw new Error(`${path}: launch-and-buy supports only protocol v2`);
  }

  const launch = stored.launch
    ? {
        creatorWallet: stored.launch.creatorWallet,
        initialBuyWallet: stored.launch.initialBuyWallet,
        launchConfigId: BigInt(stored.launch.launchConfigId),
        pairToken: stored.launch.pairToken,
        creatorFeeRecipient: stored.launch.creatorFeeRecipient,
        creatorTaxBps: parsePercentBps(stored.launch.creatorTax, "launch.creatorTax"),
        buybackEnabled: stored.launch.buybackEnabled,
        salt: stored.launch.salt,
        token: {
          ...stored.launch.token,
          logo: stored.launch.token.logo ?? null,
          logoFile: stored.launch.token.logoFile
            ? resolve(dirname(resolve(path)), stored.launch.token.logoFile)
            : null,
        },
      }
    : null;

  if (launch?.creatorFeeRecipient.toLowerCase() === zeroAddress) {
    throw new Error(`${path}: launch.creatorFeeRecipient must be explicit for launch-and-buy`);
  }
  if (launch && !names.has(launch.creatorWallet.toLowerCase())) {
    throw new Error(`${path}: launch.creatorWallet is not in campaign.wallets`);
  }
  if (launch && !names.has(launch.initialBuyWallet.toLowerCase())) {
    throw new Error(`${path}: launch.initialBuyWallet is not in campaign.wallets`);
  }

  return {
    name: stored.name,
    mode: stored.mode,
    protocols: [...new Set(stored.protocols)],
    target: stored.target,
    wallets: [...stored.wallets].sort((a, b) => a.order - b.order),
    execution: stored.execution,
    launch,
  };
}

export function validateCampaignStrategies(
  campaign: Campaign,
  strategies: Map<string, StrategyProfile>,
): void {
  for (const wallet of campaign.wallets) requireStrategy(strategies, wallet.strategy);
}

export function campaignPairToken(campaign: Campaign): Address | null {
  if (!campaign.launch) return null;
  return campaign.launch.pairToken === "native" ? zeroAddress : campaign.launch.pairToken;
}
