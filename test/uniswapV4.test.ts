import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters, getAddress } from "viem";

process.env.RPC_HTTP_URL ||= "https://rpc.mainnet.chain.robinhood.com";
process.env.RPC_WS_URL ||= "";

test("v4 swap input encodes swap, settle and take actions", async () => {
  const { encodeV4Input } = await import("../src/protocol/uniswapV4.js");
  const token = getAddress("0x1111111111111111111111111111111111111111");
  const pair = getAddress("0x2222222222222222222222222222222222222222");
  const hooks = getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044");
  const encoded = encodeV4Input(
    { currency0: token, currency1: pair, fee: 10_000, tickSpacing: 200, hooks },
    true,
    1_000n,
    900n,
    token,
    pair,
  );
  const [actions, parameters] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    encoded,
  );

  assert.equal(actions, "0x060c0f");
  assert.equal(parameters.length, 3);
  const [settleCurrency, settleAmount] = decodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    parameters[1]!,
  );
  const [takeCurrency, takeMinimum] = decodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    parameters[2]!,
  );
  assert.equal(settleCurrency, token);
  assert.equal(settleAmount, 1_000n);
  assert.equal(takeCurrency, pair);
  assert.equal(takeMinimum, 900n);
});

test("v4 pool reconstruction sorts currencies deterministically", async () => {
  const { reconstructPool } = await import("../src/protocol/v2Lifecycle.js");
  const high = getAddress("0xF000000000000000000000000000000000000001");
  const low = getAddress("0x1000000000000000000000000000000000000001");
  const forward = reconstructPool(high, low, 10_000, 200);
  const reverse = reconstructPool(low, high, 10_000, 200);

  assert.equal(forward.poolKey.currency0, low);
  assert.equal(forward.poolKey.currency1, high);
  assert.equal(forward.poolId, reverse.poolId);
});
