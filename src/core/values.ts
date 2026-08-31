import { parseUnits } from "viem";

const DECIMAL = /^\d+(?:\.\d+)?$/;
const PERCENT = /^(\d+(?:\.\d+)?)%$/;

export function parsePercentBps(value: string, field: string, allowHundred = true): number {
  const match = PERCENT.exec(value.trim());
  if (!match?.[1]) throw new Error(`${field} must be a percentage such as "3%"`);
  const bps = Math.round(Number(match[1]) * 100);
  const max = allowHundred ? 10_000 : 9_999;
  if (!Number.isFinite(bps) || bps < 0 || bps > max) {
    throw new Error(`${field} must be between 0% and ${allowHundred ? "100%" : "below 100%"}`);
  }
  return bps;
}

export function parseMultiple(value: string | number, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
    return value;
  }

  const normalized = value.trim().toLowerCase();
  const percent = PERCENT.exec(normalized);
  if (percent?.[1]) return Number(percent[1]) / 100;
  const multiplier = normalized.endsWith("x") ? normalized.slice(0, -1) : normalized;
  if (!DECIMAL.test(multiplier)) {
    throw new Error(`${field} must look like "250%", "2.5x", or 2.5`);
  }
  const parsed = Number(multiplier);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be positive`);
  return parsed;
}

export function parseAssetAmount(value: string, decimals: number, field: string): bigint {
  if (!DECIMAL.test(value.trim())) {
    throw new Error(`${field} must be a non-negative decimal value`);
  }
  const parsed = parseUnits(value.trim(), decimals);
  if (parsed <= 0n) throw new Error(`${field} must be greater than zero`);
  return parsed;
}

export function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const scaled = (numerator * 1_000_000n) / denominator;
  return Number(scaled) / 1_000_000;
}

export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/0x[0-9a-fA-F]{64}/g, "[REDACTED_HEX_32]").slice(0, 1_000);
}
