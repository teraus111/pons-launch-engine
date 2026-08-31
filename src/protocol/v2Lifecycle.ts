import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { RuntimeWallet } from "../core/wallets.js";
import type { StateStore } from "../core/store.js";
import { robinhoodChain } from "../runtime/chain.js";
import { runtimeConfig } from "../runtime/config.js";
import { LaunchPhase, PONS_V2, ponsV2FactoryAbi } from "./contracts.js";

export interface V2LifecycleState {
  token: Address;
  curve: Address;
  pairToken: Address;
  deployer: Address;
  phase: number;
  stage: "curve" | "swept" | "pool" | "rescued";
  venue: "v2-curve" | "v2-v4";
  poolId: Hex | null;
  poolKey: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  } | null;
}

export async function readV2Lifecycle(client: PublicClient, token: Address): Promise<V2LifecycleState> {
  const record = await client.readContract({
    address: PONS_V2.factory,
    abi: ponsV2FactoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  });
  if (!record.exists) throw new Error(`${token} is not a token from the configured Pons v2 factory`);

  const stage = record.phase === LaunchPhase.Curve
    ? "curve"
    : record.phase === LaunchPhase.Swept
      ? "swept"
      : record.phase === LaunchPhase.Pool
        ? "pool"
        : "rescued";

  const pool = stage === "pool"
    ? reconstructPool(record.token, record.pairToken, record.poolFee, record.tickSpacing)
    : null;
  return {
    token: record.token,
    curve: record.curve,
    pairToken: record.pairToken,
    deployer: record.deployer,
    phase: record.phase,
    stage,
    venue: stage === "pool" ? "v2-v4" : "v2-curve",
    poolId: pool?.poolId ?? null,
    poolKey: pool?.poolKey ?? null,
  };
}

export async function pushStalledGraduation(args: {
  client: PublicClient;
  store: StateStore;
  wallet: RuntimeWallet;
  token: Address;
}): Promise<Hex | null> {
  const lifecycle = await readV2Lifecycle(args.client, args.token);
  if (lifecycle.stage !== "swept") return null;
  await args.client.simulateContract({
    account: args.wallet.account,
    address: PONS_V2.factory,
    abi: ponsV2FactoryAbi,
    functionName: "createGraduatedPool",
    args: [args.token],
  });
  if (runtimeConfig.DRY_RUN) return null;

  const hash = await args.wallet.nonces.use(async (nonce) => {
    const txHash = await args.wallet.client.writeContract({
      account: args.wallet.account,
      chain: robinhoodChain,
      address: PONS_V2.factory,
      abi: ponsV2FactoryAbi,
      functionName: "createGraduatedPool",
      args: [args.token],
      nonce,
    });
    args.store.recordTransaction({
      hash: txHash,
      wallet: args.wallet.address,
      token: args.token,
      action: "graduate",
      nonce,
      status: "submitted",
      amountIn: 0n,
      minOut: 0n,
      actualOut: null,
      error: null,
      submittedAt: Date.now(),
      confirmedAt: null,
      blockNumber: null,
    });
    return txHash;
  });
  const receipt = await args.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  args.store.updateTransaction(hash, receipt.status === "success" ? "confirmed" : "failed", {
    confirmedAt: Date.now(),
    blockNumber: receipt.blockNumber,
  });
  if (receipt.status !== "success") throw new Error(`Graduation transaction ${hash} reverted`);
  return hash;
}

export function reconstructPool(
  token: Address,
  pairToken: Address,
  poolFee: number,
  tickSpacing: number,
): {
  poolId: Hex;
  poolKey: V2LifecycleState["poolKey"] & {};
} {
  const [currency0, currency1] = pairToken.toLowerCase() < token.toLowerCase()
    ? [getAddress(pairToken), getAddress(token)]
    : [getAddress(token), getAddress(pairToken)];
  const poolKey = {
    currency0,
    currency1,
    fee: poolFee,
    tickSpacing,
    hooks: getAddress(PONS_V2.memeHook),
  };
  const poolId = keccak256(encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [currency0, currency1, poolFee, tickSpacing, PONS_V2.memeHook],
  ));
  return { poolId, poolKey };
}
