import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

const vaultSchema = z
  .object({
    version: z.literal(1),
    kdf: z.literal("scrypt"),
    cipher: z.literal("aes-256-gcm"),
    salt: z.string().min(1),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

type VaultEnvelope = z.infer<typeof vaultSchema>;

const AAD = Buffer.from("pons-launch-engine:credentials:v1", "utf8");

export function readCredentials(path: string): StoredWalletCredential[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateCredentials(value, path);
}

export function readCredentialVault(path: string, password: string): StoredWalletCredential[] {
  if (password.length < 12) throw new Error("PONS_VAULT_PASSWORD must contain at least 12 characters");

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const envelope = vaultSchema.safeParse(value);
  if (!envelope.success) throw new Error(`${path} is not a supported credential vault`);

  try {
    const salt = Buffer.from(envelope.data.salt, "base64");
    const iv = Buffer.from(envelope.data.iv, "base64");
    const tag = Buffer.from(envelope.data.tag, "base64");
    const ciphertext = Buffer.from(envelope.data.ciphertext, "base64");
    const key = scryptSync(password, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return validateCredentials(JSON.parse(plaintext) as unknown, path);
  } catch {
    throw new Error(`Could not decrypt ${path}; check PONS_VAULT_PASSWORD`);
  }
}

export function writeCredentialVault(
  credentials: StoredWalletCredential[],
  path: string,
  password: string,
): void {
  if (password.length < 12) throw new Error("Vault password must contain at least 12 characters");
  const validated = validateCredentials(credentials, "credentials");
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(validated), "utf8"),
    cipher.final(),
  ]);
  const envelope: VaultEnvelope = {
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement POSIX modes; the file remains gitignored.
  }
}

export function loadConfiguredCredentials(): StoredWalletCredential[] {
  const vaultPath = process.env["CREDENTIALS_VAULT_FILE"]?.trim();
  if (vaultPath) {
    if (!existsSync(vaultPath)) throw new Error(`Credential vault not found: ${vaultPath}`);
    const password = process.env["PONS_VAULT_PASSWORD"] ?? "";
    return readCredentialVault(vaultPath, password);
  }
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
