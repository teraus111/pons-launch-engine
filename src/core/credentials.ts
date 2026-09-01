import { readFileSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { StoredWalletCredential } from "./types.js";

const credentialSchema = z
  .object({
    name: z.string().trim().min(1),
    privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();

export function readCredentials(path: string): StoredWalletCredential[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateCredentials(value, path);
}

export function loadConfiguredCredentials(): StoredWalletCredential[] {
  const path = process.env["CREDENTIALS_FILE"]?.trim() || "credentials.json";
  return readCredentials(path);
}

export function generateCredentialEntries(
  existing: StoredWalletCredential[],
  count: number,
  keyFactory: () => Hex = generatePrivateKey,
): StoredWalletCredential[] {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error("Wallet count must be a positive integer");
  }
  const names = new Set(existing.map((entry) => entry.name.toLowerCase()));
  const keys = new Set(existing.map((entry) => entry.privateKey.toLowerCase()));
  const addresses = new Set(existing.map((entry) => entry.publicKey.toLowerCase()));
  const generated: StoredWalletCredential[] = [];
  let nextNumber = 1;

  while (generated.length < count) {
    while (names.has(`wallet ${nextNumber}`)) nextNumber += 1;
    const name = `Wallet ${nextNumber}`;
    nextNumber += 1;

    let privateKey: Hex;
    let publicKey: Address;
    let attempts = 0;
    do {
      privateKey = keyFactory();
      publicKey = privateKeyToAccount(privateKey).address;
      attempts += 1;
      if (attempts > 100) throw new Error("Could not generate a unique wallet");
    } while (keys.has(privateKey.toLowerCase()) || addresses.has(publicKey.toLowerCase()));

    names.add(name.toLowerCase());
    keys.add(privateKey.toLowerCase());
    addresses.add(publicKey.toLowerCase());
    generated.push({ name, privateKey, publicKey });
  }
  return generated;
}

function validateCredentials(value: unknown, label: string): StoredWalletCredential[] {
  const parsed = z.array(credentialSchema).min(1).safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${label}: ${detail}`);
  }

  const names = new Set<string>();
  const keys = new Set<string>();
  const addresses = new Set<string>();
  return parsed.data.map((item, index) => {
    const nameKey = item.name.toLowerCase();
    const privateKey = item.privateKey as Hex;
    const publicKey = getAddress(item.publicKey) as Address;
    const keyId = privateKey.toLowerCase();
    const addressId = publicKey.toLowerCase();

    if (names.has(nameKey)) throw new Error(`${label}[${index}]: duplicate wallet name`);
    if (keys.has(keyId)) throw new Error(`${label}[${index}]: duplicate private key`);
    if (addresses.has(addressId)) throw new Error(`${label}[${index}]: duplicate public address`);
    if (privateKeyToAccount(privateKey).address.toLowerCase() !== addressId) {
      throw new Error(`${label}[${index}]: publicKey does not match privateKey`);
    }

    names.add(nameKey);
    keys.add(keyId);
    addresses.add(addressId);
    return { name: item.name, privateKey, publicKey };
  });
}
