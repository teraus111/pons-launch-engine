import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import type { RuntimeWallet } from "../src/core/wallets.js";

process.env.RPC_HTTP_URL ||= "https://rpc.mainnet.chain.robinhood.com";
process.env.RPC_WS_URL ||= "";

test("native v2 launches take economics from the launch config", async () => {
  const { selectLaunchEconomics } = await import("../src/protocol/v2Launch.js");
  assert.deepEqual(
    selectLaunchEconomics(true, 2_000n, 8_000n, [0n, 0n, 0]),
    [2_000n, 8_000n, 18],
  );
});

test("custom-pair v2 launches take economics and decimals from the pair", async () => {
  const { selectLaunchEconomics } = await import("../src/protocol/v2Launch.js");
  assert.deepEqual(
    selectLaunchEconomics(false, 2_000n, 8_000n, [500_000n, 2_000_000n, 6]),
    [500_000n, 2_000_000n, 6],
  );
  assert.throws(() => selectLaunchEconomics(false, 1n, 1n, [0n, 0n, 6]), /invalid economics/);
});

test("atomic v2 exemption selection takes the first 32 non-automatic wallets", async () => {
  const { explicitV2Exemptions } = await import("../src/core/wallets.js");
  const wallets = Array.from({ length: 38 }, (_, index) => {
    const address = `0x${(index + 1).toString(16).padStart(40, "0")}` as Address;
    return {
      address,
      campaign: { exempt: true },
    } as unknown as RuntimeWallet;
  });
  const selection = explicitV2Exemptions(
    wallets,
    wallets[0]!,
    wallets[1]!,
    wallets[2]!.address,
  );
  assert.equal(selection.selected.length, 32);
  assert.equal(selection.omitted.length, 3);
  assert.equal(selection.selected[0], wallets[3]!.address);
  assert.equal(selection.omitted[0], wallets[35]!.address);
});
