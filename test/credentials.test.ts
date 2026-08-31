import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  generateCredentialEntries,
  readCredentialVault,
  writeCredentialVault,
} from "../src/core/credentials.js";

const credential = {
  name: "Example",
  privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001" as const,
  publicKey: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as const,
};

test("credential vault encrypts and authenticates its payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "pons-vault-"));
  const path = join(directory, "credentials.vault.json");
  writeCredentialVault([credential], path, "correct horse battery staple");
  assert.deepEqual(readCredentialVault(path, "correct horse battery staple"), [credential]);
  assert.throws(() => readCredentialVault(path, "this password is wrong"), /Could not decrypt/);
});

test("wallet generation preserves existing names and fills unused Wallet numbers", () => {
  const thirdKey = "0x0000000000000000000000000000000000000000000000000000000000000003" as const;
  const existing = [
    credential,
    { name: "Wallet 1", privateKey: thirdKey, publicKey: privateKeyToAccount(thirdKey).address },
    {
      name: "Wallet 3",
      privateKey: "0x0000000000000000000000000000000000000000000000000000000000000004" as const,
      publicKey: privateKeyToAccount(
        "0x0000000000000000000000000000000000000000000000000000000000000004",
      ).address,
    },
  ];
  let next = 5;
  const generated = generateCredentialEntries(existing, 2, () => {
    const key = `0x${next.toString(16).padStart(64, "0")}` as `0x${string}`;
    next += 1;
    return key;
  });
  assert.deepEqual(generated.map((entry) => entry.name), ["Wallet 2", "Wallet 4"]);
  assert.equal(existing.length, 3);
});
