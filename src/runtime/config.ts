import "dotenv/config";
import { getAddress, type Address } from "viem";
import { z } from "zod";

const optionalAddress = z
  .string()
  .trim()
  .default("")
  .refine(
    (value) => value === "" || /^0x[0-9a-fA-F]{40}$/.test(value),
    "expected an EVM address",
  );

const schema = z.object({
  RPC_HTTP_URL: z.url(),
  RPC_WS_URL: z.string().trim().default("").refine(
    (value) => value === "" || /^wss?:\/\//.test(value),
    "expected ws:// or wss:// URL",
  ),
  CHAIN_ID: z.coerce.number().int().default(4663),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(150),
  CAMPAIGN_FILE: z.string().trim().min(1).default("campaign.json"),
  STRATEGIES_FILE: z.string().trim().min(1).default("strategies.json"),
  CREDENTIALS_FILE: z.string().trim().min(1).default("credentials.json"),
  PINATA_JWT: z.string().trim().default(""),
  STATE_DB_FILE: z.string().trim().min(1).default("state/pons.db"),
  DRY_RUN: z.stringbool().default(false),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  POSITION_TICK_MS: z.coerce.number().int().positive().default(2_000),
  ENTRY_MAX_WAIT_MS: z.coerce.number().int().positive().default(10_000),
  ENTRY_POLL_MS: z.coerce.number().int().positive().default(50),
  GAS_LIMIT_MULTIPLIER: z.coerce.number().positive().default(1.4),
  V4_ROUTER_ADDRESS: optionalAddress,
  V4_QUOTER_ADDRESS: optionalAddress,

  ALCHEMY_RPC: z.url().default(
    "https://robinhood-mainnet.g.alchemy-api.com/v2",
  ),

  EXCLUDED_FILES: z
    .string()
    .default("node_modules,.git,dist,build,.next,.cache,coverage")
    .transform((value) =>
      new Set(
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment: ${detail}`);
}

export const runtimeConfig = {
  ...parsed.data,
  V4_ROUTER_ADDRESS: parsed.data.V4_ROUTER_ADDRESS === ""
    ? null
    : getAddress(parsed.data.V4_ROUTER_ADDRESS) as Address,
  V4_QUOTER_ADDRESS: parsed.data.V4_QUOTER_ADDRESS === ""
    ? null
    : getAddress(parsed.data.V4_QUOTER_ADDRESS) as Address,
} as const;

export type RuntimeConfig = typeof runtimeConfig;
