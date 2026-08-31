import { decodeEventLog, type Address, type Hex, type Log } from "viem";
import type { Campaign, ProtocolVersion } from "../core/types.js";
import { publicClient } from "../runtime/chain.js";
import { runtimeConfig } from "../runtime/config.js";
import { log } from "../runtime/logger.js";
import {
  PONS_V1,
  PONS_V2,
  ponsV1FactoryAbi,
  ponsV2FactoryAbi,
} from "./contracts.js";

export interface DetectedV2Launch {
  protocol: "v2";
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
  seenAt: number;
}

export interface DetectedV1Launch {
  protocol: "v1";
  factory: Address;
  token: Address;
  deployer: Address;
  dexFactory: Address;
  pairToken: Address;
  pool: Address;
  dexId: bigint;
  launchConfigId: bigint;
  positionId: bigint;
  restrictionsEndBlock: bigint;
  initialBuyAmount: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
  seenAt: number;
}

export type DetectedLaunch = DetectedV1Launch | DetectedV2Launch;

export function watchCampaignLaunches(
  campaign: Campaign,
  onLaunch: (launch: DetectedLaunch) => void,
): () => void {
  const unwatchers: (() => void)[] = [];
  const seen = new Set<string>();
  const accept = (logEntry: Log): boolean => {
    if (!logEntry.transactionHash || logEntry.blockNumber === null) return false;
    const key = `${logEntry.transactionHash}:${logEntry.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const polling = runtimeConfig.RPC_WS_URL
    ? {}
    : { poll: true as const, pollingInterval: runtimeConfig.POLL_INTERVAL_MS };

  if (campaign.protocols.includes("v2")) {
    unwatchers.push(publicClient.watchContractEvent({
      address: PONS_V2.factory,
      abi: ponsV2FactoryAbi,
      eventName: "TokenLaunched",
      onLogs: (logs) => {
        for (const entry of logs) {
          if (!accept(entry) || !entry.transactionHash || entry.blockNumber === null) continue;
          const args = entry.args;
          if (!args.token || !args.curve || !args.deployer || !args.pairToken ||
              args.launchConfigId === undefined || args.graduationThreshold === undefined) continue;
          onLaunch({
            protocol: "v2",
            token: args.token,
            curve: args.curve,
            deployer: args.deployer,
            pairToken: args.pairToken,
            launchConfigId: args.launchConfigId,
            graduationThreshold: args.graduationThreshold,
            blockNumber: entry.blockNumber,
            transactionHash: entry.transactionHash,
            seenAt: Date.now(),
          });
        }
      },
      onError: (error) => log.error({ error }, "v2 launch subscription error"),
      ...polling,
    }));
  }

  if (campaign.protocols.includes("v1")) {
    for (const factory of [PONS_V1.activeFactory, PONS_V1.legacyFactory] as const) {
      unwatchers.push(publicClient.watchContractEvent({
        address: factory,
        abi: ponsV1FactoryAbi,
        eventName: "TokenLaunched",
        onLogs: (logs) => {
          for (const entry of logs) {
            if (!accept(entry) || !entry.transactionHash || entry.blockNumber === null) continue;
            const args = entry.args;
            if (!args.token || !args.deployer || !args.dexFactory || !args.pairToken || !args.pool ||
                args.dexId === undefined || args.launchConfigId === undefined ||
                args.positionId === undefined || args.restrictionsEndBlock === undefined ||
                args.initialBuyAmount === undefined) continue;
            onLaunch({
              protocol: "v1",
              factory,
              token: args.token,
              deployer: args.deployer,
              dexFactory: args.dexFactory,
              pairToken: args.pairToken,
              pool: args.pool,
              dexId: args.dexId,
              launchConfigId: args.launchConfigId,
              positionId: args.positionId,
              restrictionsEndBlock: args.restrictionsEndBlock,
              initialBuyAmount: args.initialBuyAmount,
              blockNumber: entry.blockNumber,
              transactionHash: entry.transactionHash,
              seenAt: Date.now(),
            });
          }
        },
        onError: (error) => log.error({ error, factory }, "v1 launch subscription error"),
        ...polling,
      }));
    }
  }

  log.info(
    {
      campaign: campaign.name,
      protocols: campaign.protocols,
      target: campaign.target,
      transport: runtimeConfig.RPC_WS_URL ? "websocket" : "http polling",
    },
    "campaign launch monitor started",
  );
  return () => unwatchers.forEach((unwatch) => unwatch());
}

export function protocolEnabled(protocols: ProtocolVersion[], protocol: ProtocolVersion): boolean {
  return protocols.includes(protocol);
}
