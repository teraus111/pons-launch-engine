import type { Address, Hex } from "viem";

export type ProtocolVersion = "v1" | "v2";
export type LaunchVenue = "v1-v3" | "v2-curve" | "v2-v4";
export type LaunchStage = "restricted" | "curve" | "swept" | "pool" | "rescued";
export type CampaignMode = "monitor" | "launch-and-buy" | "direct-token";
export type TransactionAction = "launch" | "buy" | "sell" | "approve" | "graduate";
export type TransactionStatus = "submitted" | "confirmed" | "failed" | "replaced";
export type PriceLimitAction = "skip" | "resize" | "retry";

export interface StoredWalletCredential {
  name: string;
  privateKey: Hex;
  publicKey: Address;
}

export interface TakeProfitRule {
  id: string;
  atMultiple: number;
  sellBps: number;
}

export interface EntryStrategy {
  amount: string;
  slippageBps: number | null;
  maxPriceImpactBps: number;
  maxSnipeTaxBps: number;
  onPriceLimit: PriceLimitAction;
  splitOrders: number;
}

export interface ExitStrategy {
  takeProfit: TakeProfitRule[];
  stopLossMultiple: number | null;
  trailingStopBps: number | null;
  breakEvenAfterMultiple: number | null;
  maxHoldSeconds: number | null;
}

export interface StrategyProfile {
  name: string;
  entry: EntryStrategy;
  exit: ExitStrategy;
}

export interface CampaignWallet {
  name: string;
  strategy: string;
  enabled: boolean;
  exempt: boolean;
  order: number;
}

export interface CampaignExecution {
  batchSize: number;
  batchDelayMs: number;
  confirmEachBatch: boolean;
  maxRetries: number;
  retryDelayMs: number;
}

export interface TokenSocials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

export interface AtomicLaunchConfig {
  creatorWallet: string;
  initialBuyWallet: string;
  launchConfigId: bigint;
  pairToken: Address | "native";
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  salt: Hex | "auto";
  token: {
    name: string;
    symbol: string;
    logo: string | null;
    logoFile: string | null;
    description: string;
    socials: TokenSocials;
  };
}

export interface Campaign {
  name: string;
  mode: CampaignMode;
  protocols: ProtocolVersion[];
  target: {
    deployer: Address | null;
    token: Address | null;
  };
  wallets: CampaignWallet[];
  execution: CampaignExecution;
  launch: AtomicLaunchConfig | null;
}

export interface LaunchRecord {
  token: Address;
  protocol: ProtocolVersion;
  venue: LaunchVenue;
  venueAddress: Address;
  pairToken: Address;
  quoteDecimals: number;
  deployer: Address;
  launchBlock: bigint;
  stage: LaunchStage;
  rawJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface PositionRecord {
  wallet: Address;
  walletName: string;
  token: Address;
  protocol: ProtocolVersion;
  venue: LaunchVenue;
  venueAddress: Address;
  pairToken: Address;
  quoteDecimals: number;
  symbol: string;
  tokens: bigint;
  costBasis: bigint;
  realizedQuote: bigint;
  openedAt: number;
  entryTxHash: Hex;
  strategyId: string;
  status: "open" | "closed";
  highestMultiple: number;
  closedAt: number | null;
  updatedAt: number;
}

export interface TransactionRecord {
  hash: Hex;
  wallet: Address;
  token: Address | null;
  action: TransactionAction;
  nonce: number;
  status: TransactionStatus;
  amountIn: bigint;
  minOut: bigint;
  actualOut: bigint | null;
  error: string | null;
  submittedAt: number;
  confirmedAt: number | null;
  blockNumber: bigint | null;
}

export interface CampaignRunRecord {
  id: string;
  campaignName: string;
  mode: CampaignMode;
  status: "running" | "completed" | "failed" | "stopped";
  contextJson: string;
  startedAt: number;
  updatedAt: number;
}
