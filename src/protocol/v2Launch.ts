import { randomBytes } from "node:crypto";
import {
  decodeEventLog,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { Campaign } from "../core/types.js";
import type { RuntimeWallet } from "../core/wallets.js";
import { explicitV2Exemptions, requireWallet } from "../core/wallets.js";
import { parseAssetAmount, redactError } from "../core/values.js";
import { resolveLaunchLogo, validateLaunchLogo } from "../core/logo.js";
import type { StateStore } from "../core/store.js";
import { robinhoodChain } from "../runtime/chain.js";
import { runtimeConfig } from "../runtime/config.js";
import { log } from "../runtime/logger.js";
import {
  PONS_V2,
  erc20Abi,
  launchAndBuyAbi,
  ponsV2FactoryAbi,
  TOPIC_CURVE_BUY,
  TOPIC_V2_LAUNCHED,
} from "./contracts.js";
import { minTokensOut, quoteBuy, type BuyQuote, type CurveState } from "./v2CurveMath.js";

export interface PreparedAtomicLaunch {
  campaign: Campaign;
  creator: RuntimeWallet;
  recipient: RuntimeWallet;
  pairToken: Address;
  quoteDecimals: number;
  quoteIn: bigint;
  quote: BuyQuote;
  minTokensOut: bigint;
  launchFee: bigint;
  expectedEconomics: Hex;
  salt: Hex;
  exemptions: Address[];
  omittedExemptions: Address[];
  initialState: CurveState;
}

export interface AtomicLaunchResult {
  txHash: Hex;
  receipt: TransactionReceipt;
  token: Address;
  curve: Address;
  tokensOut: bigint;
  spent: bigint;
}

export async function prepareAtomicLaunch(
  client: PublicClient,
  campaign: Campaign,
  wallets: RuntimeWallet[],
): Promise<PreparedAtomicLaunch> {
  if (!campaign.launch) throw new Error("Campaign does not define an atomic launch");
  const launch = campaign.launch;
  validateLaunchLogo(launch.token);
  const creator = requireWallet(wallets, launch.creatorWallet);
  const recipient = requireWallet(wallets, launch.initialBuyWallet);
  const pairToken = launch.pairToken === "native" ? zeroAddress : launch.pairToken;

  const [config, economics, expectedEconomics, launchFee, allowed, maxCreatorTaxBps, pairApproved] =
    await Promise.all([
      client.readContract({
        address: PONS_V2.factory,
        abi: ponsV2FactoryAbi,
        functionName: "getLaunchConfig",
        args: [launch.launchConfigId],
      }),
      client.readContract({
        address: PONS_V2.factory,
        abi: ponsV2FactoryAbi,
        functionName: "pairTokenEconomics",
        args: [pairToken],
      }),
      client.readContract({
        address: PONS_V2.factory,
        abi: ponsV2FactoryAbi,
        functionName: "previewLaunchEconomics",
        args: [launch.launchConfigId, pairToken],
      }),
      client.readContract({ address: PONS_V2.factory, abi: ponsV2FactoryAbi, functionName: "launchFee" }),
      client.readContract({
        address: PONS_V2.factory,
        abi: ponsV2FactoryAbi,
        functionName: "canLaunch",
        args: [creator.address],
      }),
      client.readContract({
        address: PONS_V2.factory,
        abi: ponsV2FactoryAbi,
        functionName: "maxCreatorTaxBps",
      }),
      client.readContract({
        address: PONS_V2.factory,
        abi: ponsV2FactoryAbi,
        functionName: "approvedPairTokens",
        args: [pairToken],
      }),
    ]);

  if (!config.enabled) throw new Error(`Pons v2 launch config ${launch.launchConfigId} is disabled`);
  if (!allowed) throw new Error(`${creator.address} is not currently allowed to launch`);
  const native = pairToken === zeroAddress;
  if (!native && (!pairApproved || economics[0] <= 0n || economics[1] <= 0n)) {
    throw new Error(`${pairToken} is not an approved Pons v2 pairing asset`);
  }
  if (launch.creatorTaxBps > Number(maxCreatorTaxBps)) {
    throw new Error(`Creator tax ${launch.creatorTaxBps} bps exceeds protocol maximum ${maxCreatorTaxBps}`);
  }

  const [phantomQuote, graduationThreshold, quoteDecimals] = selectLaunchEconomics(
    native,
    config.phantomQuote,
    config.graduationThreshold,
    economics,
  );
  const reservedTokens = (config.supply * phantomQuote) / (phantomQuote + graduationThreshold);
  const initialState: CurveState = {
    quoteReserve: phantomQuote,
    tokenReserve: config.supply,
    sellableTokens: config.supply - reservedTokens,
    feeBps: config.curveFeeBps,
    creatorTaxBps: BigInt(launch.creatorTaxBps),
    snipeTaxBps: 0n,
    readAtMs: Date.now(),
  };
  const quoteIn = parseAssetAmount(
    recipient.strategy.entry.amount,
    Number(quoteDecimals),
    `${recipient.strategy.name}.entry.amount`,
  );
  const quote = quoteBuy(initialState, quoteIn);
  if (quote.priceImpactBps > recipient.strategy.entry.maxPriceImpactBps) {
    throw new Error(
      `Atomic opening buy impact ${quote.priceImpactBps} bps exceeds strategy limit ` +
      `${recipient.strategy.entry.maxPriceImpactBps} bps`,
    );
  }
  const slippageBps = recipient.strategy.entry.slippageBps ??
    Math.max(100, Math.min(2_500, 100 + Math.ceil(quote.priceImpactBps / 4)));
  const salt = launch.salt === "auto" ? toHex(randomBytes(32)) : launch.salt;
  const exemptionSelection = explicitV2Exemptions(
    wallets,
    creator,
    recipient,
    launch.creatorFeeRecipient,
  );

  return {
    campaign,
    creator,
    recipient,
    pairToken,
    quoteDecimals: Number(quoteDecimals),
    quoteIn,
    quote,
    minTokensOut: minTokensOut(quote, slippageBps),
    launchFee,
    expectedEconomics,
    salt,
    exemptions: exemptionSelection.selected,
    omittedExemptions: exemptionSelection.omitted,
    initialState,
  };
}

export function selectLaunchEconomics(
  native: boolean,
  configPhantomQuote: bigint,
  configGraduationThreshold: bigint,
  pairEconomics: readonly [bigint, bigint, number],
): readonly [bigint, bigint, number] {
  const selected = native
    ? [configPhantomQuote, configGraduationThreshold, 18] as const
    : pairEconomics;
  if (selected[0] <= 0n || selected[1] <= 0n) {
    throw new Error("Pons v2 launch configuration has invalid economics");
  }
  return selected;
}

export async function executeAtomicLaunch(
  client: PublicClient,
  store: StateStore,
  prepared: PreparedAtomicLaunch,
): Promise<AtomicLaunchResult | null> {
  const launch = prepared.campaign.launch!;
  if (launch.token.logoFile && !runtimeConfig.DRY_RUN) {
    log.info({ file: launch.token.logoFile }, "uploading launch logo to Pinata public IPFS");
  }
  const logo = await resolveLaunchLogo(launch.token, {
    dryRun: runtimeConfig.DRY_RUN,
    pinataJwt: runtimeConfig.PINATA_JWT,
  });
  if (launch.token.logoFile && !runtimeConfig.DRY_RUN) {
    log.info({ logo }, "launch logo uploaded to IPFS");
  }
  const params = {
    name: launch.token.name,
    symbol: launch.token.symbol,
    logo,
    description: launch.token.description,
    socials: launch.token.socials,
    creatorFeeRecipient: launch.creatorFeeRecipient,
    creatorTaxBps: launch.creatorTaxBps,
    buybackEnabled: launch.buybackEnabled,
    expectedEconomics: prepared.expectedEconomics,
    salt: prepared.salt,
  } as const;
  const args = [
    params,
    launch.launchConfigId,
    prepared.pairToken,
    prepared.quoteIn,
    prepared.minTokensOut,
    prepared.recipient.address,
    prepared.exemptions,
  ] as const;
  const native = prepared.pairToken === zeroAddress;
  const value = prepared.launchFee + (native ? prepared.quoteIn : 0n);

  if (!native) {
    const approved = await ensureApproval(
      client,
      store,
      prepared.creator,
      prepared.pairToken,
      PONS_V2.launchAndBuy,
      prepared.quoteIn,
    );
    if (!approved) return null;
  }

  await client.simulateContract({
    account: prepared.creator.account,
    address: PONS_V2.launchAndBuy,
    abi: launchAndBuyAbi,
    functionName: "launchAndBuy",
    args,
    value,
  });

  if (runtimeConfig.DRY_RUN) return null;

  const gasEstimate = await client.estimateContractGas({
    account: prepared.creator.account,
    address: PONS_V2.launchAndBuy,
    abi: launchAndBuyAbi,
    functionName: "launchAndBuy",
    args,
    value,
  });
  const gas = bufferedGas(gasEstimate);
  const fees = await client.estimateFeesPerGas();

  const sent = await prepared.creator.nonces.use(async (nonce) => {
    const hash = await prepared.creator.client.writeContract({
      account: prepared.creator.account,
      chain: robinhoodChain,
      address: PONS_V2.launchAndBuy,
      abi: launchAndBuyAbi,
      functionName: "launchAndBuy",
      args,
      value,
      gas,
      nonce,
      ...fees,
    });
    store.recordTransaction({
      hash,
      wallet: prepared.creator.address,
      token: null,
      action: "launch",
      nonce,
      status: "submitted",
      amountIn: value,
      minOut: prepared.minTokensOut,
      actualOut: null,
      error: null,
      submittedAt: Date.now(),
      confirmedAt: null,
      blockNumber: null,
    });
    return hash;
  });

  try {
    const receipt = await client.waitForTransactionReceipt({ hash: sent, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error("launch-and-buy reverted on chain");
    const fill = decodeAtomicFill(receipt, prepared.recipient.address);
    store.updateTransaction(sent, "confirmed", {
      actualOut: fill.tokensOut,
      confirmedAt: Date.now(),
      blockNumber: receipt.blockNumber,
    });
    return { txHash: sent, receipt, ...fill };
  } catch (error) {
    store.updateTransaction(sent, "failed", { error: redactError(error), confirmedAt: Date.now() });
    throw error;
  }
}

async function ensureApproval(
  client: PublicClient,
  store: StateStore,
  wallet: RuntimeWallet,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<boolean> {
  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.address, spender],
  });
  if (allowance >= amount) return true;
  if (runtimeConfig.DRY_RUN) return false;

  const hash = await wallet.nonces.use(async (nonce) => {
    const txHash = await wallet.client.writeContract({
      account: wallet.account,
      chain: robinhoodChain,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
      nonce,
    });
    store.recordTransaction({
      hash: txHash,
      wallet: wallet.address,
      token,
      action: "approve",
      nonce,
      status: "submitted",
      amountIn: amount,
      minOut: 0n,
      actualOut: null,
      error: null,
      submittedAt: Date.now(),
      confirmedAt: null,
      blockNumber: null,
    });
    return txHash;
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  store.updateTransaction(hash, receipt.status === "success" ? "confirmed" : "failed", {
    confirmedAt: Date.now(),
    blockNumber: receipt.blockNumber,
  });
  if (receipt.status !== "success") throw new Error(`Approval ${hash} reverted`);
  return true;
}

function decodeAtomicFill(
  receipt: TransactionReceipt,
  recipient: Address,
): { token: Address; curve: Address; tokensOut: bigint; spent: bigint } {
  let token: Address | null = null;
  let curve: Address | null = null;
  let tokensOut = 0n;
  let spent = 0n;
  for (const log of receipt.logs) {
    if (log.topics[0] === TOPIC_V2_LAUNCHED) {
      const decoded = decodeEventLog({
        abi: ponsV2FactoryAbi,
        eventName: "TokenLaunched",
        topics: log.topics,
        data: log.data,
      });
      const args = decoded.args;
      token = args.token;
      curve = args.curve;
    }
    if (log.topics[0] === TOPIC_CURVE_BUY) {
      const decoded = decodeEventLog({
        abi: ponsV2CurveAbiForDecode,
        eventName: "CurveBuy",
        topics: log.topics,
        data: log.data,
      });
      if (decoded.args.recipient.toLowerCase() === recipient.toLowerCase()) {
        tokensOut = decoded.args.tokensOut;
        spent = decoded.args.quoteIn;
      }
    }
  }
  if (!token || !curve) throw new Error("Launch receipt did not contain TokenLaunched");
  if (tokensOut <= 0n) throw new Error("Launch receipt did not contain the opening CurveBuy fill");
  return { token, curve, tokensOut, spent };
}

const ponsV2CurveAbiForDecode = [
  {
    type: "event",
    name: "CurveBuy",
    inputs: [
      { indexed: true, name: "buyer", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "quoteIn", type: "uint256" },
      { indexed: false, name: "tokensOut", type: "uint256" },
      { indexed: false, name: "fee", type: "uint256" },
      { indexed: false, name: "tax", type: "uint256" },
    ],
  },
] as const;

function bufferedGas(estimate: bigint): bigint {
  return (estimate * BigInt(Math.ceil(runtimeConfig.GAS_LIMIT_MULTIPLIER * 1_000))) / 1_000n;
}
