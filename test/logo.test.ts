import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLocalLogo, resolveLaunchLogo } from "../src/core/logo.js";
import type { AtomicLaunchConfig } from "../src/core/types.js";

function token(logo: string | null, logoFile: string | null): AtomicLaunchConfig["token"] {
  return {
    name: "Example",
    symbol: "EXMPL",
    logo,
    logoFile,
    description: "",
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
  };
}

function localPng(): string {
  const directory = mkdtempSync(join(tmpdir(), "pons-logo-"));
  const path = join(directory, "token.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return path;
}

test("local launch logos are validated without uploading in dry-run mode", async () => {
  const path = localPng();
  const file = readLocalLogo(path);
  assert.equal(file.mimeType, "image/png");
  const logo = await resolveLaunchLogo(token(null, path), {
    dryRun: true,
    pinataJwt: "",
    fetchImpl: async () => { throw new Error("fetch must not run"); },
  });
  assert.match(logo, /^ipfs:\/\/dry-run-[0-9a-f]{64}$/);
});

test("local launch logos upload to Pinata public IPFS", async () => {
  const path = localPng();
  const cid = `bafy${"a".repeat(40)}`;
  let authorization = "";
  let network = "";
  const logo = await resolveLaunchLogo(token(null, path), {
    dryRun: false,
    pinataJwt: "example-jwt",
    fetchImpl: (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      network = String((init?.body as FormData).get("network"));
      return new Response(JSON.stringify({ data: { cid } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  assert.equal(authorization, "Bearer example-jwt");
  assert.equal(network, "public");
  assert.equal(logo, `ipfs://${cid}`);
});

test("an existing IPFS logo does not require Pinata", async () => {
  assert.equal(
    await resolveLaunchLogo(token("ipfs://already-uploaded", null), {
      dryRun: false,
      pinataJwt: "",
    }),
    "ipfs://already-uploaded",
  );
});
