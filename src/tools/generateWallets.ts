/**
 * Appends freshly generated wallets to the configured credentials file.
 * Existing records are validated and preserved; private keys are never logged.
 *
 *   npm run generate-wallets -- 5
 */
import "dotenv/config";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCredentialEntries, readCredentials } from "../core/credentials.js";

function main(): void {
  const rawCount = process.argv[2];
  const count = Number(rawCount);
  if (!rawCount || !Number.isSafeInteger(count) || count <= 0) {
    throw new Error("Usage: npm run generate-wallets -- <positive integer>");
  }

  const path = resolve(process.env.CREDENTIALS_FILE || "credentials.json");
  const existing = existsSync(path) ? readCredentials(path) : [];
  const appended = generateCredentialEntries(existing, count);

  writeFileSync(path, `${JSON.stringify([...existing, ...appended], null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement POSIX modes; the file remains gitignored.
  }

  console.log(`Appended ${appended.length} wallet(s) to ${path}.`);
  console.log(`Total configured wallets: ${existing.length + appended.length}`);
  for (const entry of appended) {
    console.log(`${entry.name.padEnd(20)} ${entry.publicKey}`);
  }
  console.log("Private keys were written only to the credentials file.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
