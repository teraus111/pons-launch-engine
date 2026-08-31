import { createWalletClient, http, type Address, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { PublicClient } from "viem";
import type {
  Campaign,
  CampaignWallet,
  StoredWalletCredential,
  StrategyProfile,
} from "./types.js";
import { requireStrategy } from "./strategies.js";
import { parseAssetAmount } from "./values.js";
import { robinhoodChain } from "../runtime/chain.js";
import { runtimeConfig } from "../runtime/config.js";

export class NonceLane {
  private next: number | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly address: Address,
    private readonly publicClient: PublicClient,
  ) {}

  async prime(): Promise<void> {
    this.next = await this.publicClient.getTransactionCount({
      address: this.address,
      blockTag: "pending",
    });
  }

  async use<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.tail;
    this.tail = prior.then(() => gate);
    await prior;
    try {
      if (this.next === null) await this.prime();
      const nonce = this.next!;
      this.next = nonce + 1;
      return await fn(nonce);
    } catch (error) {
      this.next = null;
      throw error;
    } finally {
      release();
    }
  }

  async withNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    return this.use(fn);
  }

  reset(): void {
    this.next = null;
  }
}

export interface RuntimeWallet {
  index: number;
  name: string;
  campaign: CampaignWallet;
  strategy: StrategyProfile;
  account: PrivateKeyAccount;
  address: Address;
  client: WalletClient;
  nonces: NonceLane;
  label: string;
  buyAmount: bigint;
  sellAmountBps: number;
  slippageBps: number | null;
  takeProfitMult: number | null;
  stopLossMult: number | null;
  whitelisted: boolean;
}

export function buildCampaignWallets(
  campaign: Campaign,
  strategies: Map<string, StrategyProfile>,
  credentials: StoredWalletCredential[],
  publicClient: PublicClient,
): RuntimeWallet[] {
  const credentialsByName = new Map(credentials.map((credential) => [credential.name.toLowerCase(), credential]));

  return campaign.wallets
    .filter((entry) => entry.enabled)
    .map((entry, index) => {
      const credential = credentialsByName.get(entry.name.toLowerCase());
      if (!credential) throw new Error(`Campaign wallet "${entry.name}" is missing from credentials`);
      const account = privateKeyToAccount(credential.privateKey);
      const client = createWalletClient({
        account,
        chain: robinhoodChain,
        transport: http(runtimeConfig.RPC_HTTP_URL, { retryCount: 0 }),
      });
      return {
        index,
        name: entry.name,
        campaign: entry,
        strategy: requireStrategy(strategies, entry.strategy),
        account,
        address: account.address,
        client,
        nonces: new NonceLane(account.address, publicClient),
        label: `${entry.name}:${account.address.slice(0, 8)}`,
        buyAmount: parseAssetAmount(
          requireStrategy(strategies, entry.strategy).entry.amount,
          18,
          `${entry.strategy}.entry.amount`,
        ),
        sellAmountBps: 10_000,
        slippageBps: requireStrategy(strategies, entry.strategy).entry.slippageBps,
        takeProfitMult: null,
        stopLossMult: null,
        whitelisted: entry.exempt,
      };
    });
}

export function requireWallet(wallets: RuntimeWallet[], name: string): RuntimeWallet {
  const found = wallets.find((wallet) => wallet.campaign.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`Wallet "${name}" is not enabled in this campaign`);
  return found;
}

export function explicitV2Exemptions(
  wallets: RuntimeWallet[],
  creator: RuntimeWallet,
  initialRecipient: RuntimeWallet,
  creatorFeeRecipient: Address,
): { selected: Address[]; omitted: Address[] } {
  const automatic = new Set([
    creator.address.toLowerCase(),
    initialRecipient.address.toLowerCase(),
    creatorFeeRecipient.toLowerCase(),
  ]);
  const seen = new Set<string>();
  const addresses: Address[] = [];
  for (const wallet of wallets) {
    const key = wallet.address.toLowerCase();
    if (!wallet.campaign.exempt || automatic.has(key) || seen.has(key)) continue;
    seen.add(key);
    addresses.push(wallet.address);
  }
  return { selected: addresses.slice(0, 32), omitted: addresses.slice(32) };
}
