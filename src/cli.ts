import { randomUUID } from "node:crypto";
import { formatUnits, zeroAddress, type Address } from "viem";
import { loadCampaign, validateCampaignStrategies } from "./core/campaign.js";
import { loadConfiguredCredentials } from "./core/credentials.js";
import { executeV2Detected, handleDetectedLaunch, setCredentials, recordAtomicOpeningPosition } from "./core/entryEngine.js";
import { planCurveEntries } from "./core/planner.js";
import { DurablePositionEngine } from "./core/positionEngine.js";
import { StateStore } from "./core/store.js";
import { loadStrategies } from "./core/strategies.js";
import { buildCampaignWallets, requireWallet } from "./core/wallets.js";
import { publicClient } from "./runtime/chain.js";
import { runtimeConfig } from "./runtime/config.js";
import { log } from "./runtime/logger.js";
import { erc20Abi, PONS_V1, PONS_V2, ponsV2FactoryAbi, UNISWAP_V4 } from "./protocol/contracts.js";
import { watchCampaignLaunches, type DetectedV2Launch } from "./protocol/detector.js";
import { applyBuy, readCurveState } from "./protocol/v2CurveMath.js";
import { readV2Lifecycle } from "./protocol/v2Lifecycle.js";
import { executeAtomicLaunch, prepareAtomicLaunch } from "./protocol/v2Launch.js";

interface Context {
  campaign: ReturnType<typeof loadCampaign>;
  strategies: ReturnType<typeof loadStrategies>;
  credentials: ReturnType<typeof loadConfiguredCredentials>;
  wallets: ReturnType<typeof buildCampaignWallets>;
  store: StateStore;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "doctor":
      await doctor(args);
      break;
    case "plan":
      await plan(args);
      break;
    case "launch":
      await launch(args);
      break;
    case "run":
      await run(args);
      break;
    case "status":
      status();
      break;
    case "resume":
      await resume(args);
      break;
    case "sell-all":
      await sellAll(args);
      break;
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      throw new Error(`Unknown command "${command}". Run npm run pons -- help.`);
  }
}

interface CommandOptions {
  campaignFile: string;
  yes: boolean;
}

function parseCommandOptions(args: string[], allowYes = false): CommandOptions {
  let campaignFile = runtimeConfig.CAMPAIGN_FILE;
  let yes = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--campaign" || argument === "-c") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("-")) {
        throw new Error(`${argument} requires a campaign JSON file path`);
      }
      campaignFile = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--campaign=") || argument.startsWith("-c=")) {
      const value = argument.slice(argument.indexOf("=") + 1).trim();
      if (!value) throw new Error(`${argument.split("=")[0]} requires a campaign JSON file path`);
      campaignFile = value;
      continue;
    }
    if (argument === "--yes" && allowYes) {
      yes = true;
      continue;
    }
    throw new Error(`Unknown option "${argument}"`);
  }

  return { campaignFile, yes };
}

function loadContext(campaignFile = runtimeConfig.CAMPAIGN_FILE): Context {
  const campaign = loadCampaign(campaignFile);
  const strategies = loadStrategies(runtimeConfig.STRATEGIES_FILE);
  validateCampaignStrategies(campaign, strategies);
  const credentials = loadConfiguredCredentials();
  const wallets = buildCampaignWallets(campaign, strategies, credentials, publicClient);
  if (wallets.length === 0) throw new Error("Campaign has no enabled wallets");
  return {
    campaign,
    strategies,
    credentials,
    wallets,
    store: new StateStore(runtimeConfig.STATE_DB_FILE),
  };
}

async function doctor(args: string[]): Promise<void> {
  const context = loadContext(parseCommandOptions(args).campaignFile);
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== runtimeConfig.CHAIN_ID) {
      throw new Error(`RPC chain id is ${chainId}, expected ${runtimeConfig.CHAIN_ID}`);
    }
    const addresses: Address[] = [
      PONS_V2.factory,
      PONS_V2.launchAndBuy,
      UNISWAP_V4.poolManager,
      runtimeConfig.V4_QUOTER_ADDRESS ?? UNISWAP_V4.quoter,
      runtimeConfig.V4_ROUTER_ADDRESS ?? UNISWAP_V4.universalRouter,
      UNISWAP_V4.permit2,
    ];
    if (context.campaign.protocols.includes("v1")) {
      addresses.push(PONS_V1.activeFactory, PONS_V1.legacyFactory);
    }
    for (const address of addresses) {
      const code = await publicClient.getCode({ address });
      if (!code || code === "0x") throw new Error(`No contract deployed at ${address}`);
    }

    const balances = await Promise.all(
      context.wallets.map((wallet) => publicClient.getBalance({ address: wallet.address })),
    );
    console.table(context.wallets.map((wallet, index) => ({
      wallet: wallet.campaign.name,
      address: wallet.address,
      strategy: wallet.strategy.name,
      exempt: wallet.campaign.exempt,
      nativeBalance: `${formatUnits(balances[index]!, 18)} ETH`,
    })));

    if (context.campaign.mode === "launch-and-buy") {
      const prepared = await prepareAtomicLaunch(publicClient, context.campaign, context.wallets);
      console.log(`Atomic launch validated: ${prepared.quote.tokensOut} expected opening tokens`);
      console.log(`Explicit exemptions: ${prepared.exemptions.length}/32`);
      if (prepared.omittedExemptions.length > 0) {
        console.log(`Exemptions omitted after the first 32: ${prepared.omittedExemptions.length}`);
      }
    }
    console.log(`State database: ${runtimeConfig.STATE_DB_FILE}`);
    console.log(`Dry run: ${runtimeConfig.DRY_RUN}`);
    console.log("Doctor checks passed.");
  } finally {
    context.store.close();
  }
}

async function plan(args: string[]): Promise<void> {
  const context = loadContext(parseCommandOptions(args).campaignFile);
  try {
    if (context.campaign.mode === "launch-and-buy") {
      const prepared = await prepareAtomicLaunch(publicClient, context.campaign, context.wallets);
      printAtomicPlan(prepared);
      const remaining = context.wallets.filter(
        (wallet) => wallet.address.toLowerCase() !== prepared.recipient.address.toLowerCase(),
      );
      const stateAfterOpening = applyBuy(prepared.initialState, prepared.quoteIn);
      const rest = planCurveEntries(remaining, stateAfterOpening, prepared.quoteDecimals);
      printCurvePlan(rest, prepared.quoteDecimals);
      return;
    }

    if (context.campaign.target.token) {
      const lifecycle = await readV2Lifecycle(publicClient, context.campaign.target.token);
      if (lifecycle.stage !== "curve") {
        console.log(`Target currently routes to ${lifecycle.stage}; curve entry planning is unavailable.`);
        return;
      }
      const quoteDecimals = lifecycle.pairToken === zeroAddress
        ? 18
        : Number(await publicClient.readContract({
            address: lifecycle.pairToken,
            abi: erc20Abi,
            functionName: "decimals",
          }));
      const first = context.wallets[0]!;
      const state = await readCurveState(publicClient, lifecycle.curve, first.address);
      printCurvePlan(planCurveEntries(context.wallets, state, quoteDecimals), quoteDecimals);
      return;
    }

    console.table(context.wallets.map((wallet) => ({
      order: wallet.campaign.order,
      wallet: wallet.campaign.name,
      strategy: wallet.strategy.name,
      amount: wallet.strategy.entry.amount,
      exempt: wallet.campaign.exempt,
      splitOrders: wallet.strategy.entry.splitOrders,
    })));
    console.log("Live curve pricing will be added when the monitored launch is detected.");
  } finally {
    context.store.close();
  }
}

async function launch(args: string[]): Promise<void> {
  await setCredentials();
  const context = loadContext(parseCommandOptions(args).campaignFile);
  if (context.campaign.mode !== "launch-and-buy") {
    context.store.close();
    throw new Error("The launch command requires campaign mode launch-and-buy");
  }
  const prepared = await prepareAtomicLaunch(publicClient, context.campaign, context.wallets);
  printAtomicPlan(prepared);
  const result = await executeAtomicLaunch(publicClient, context.store, prepared);
  if (!result) {
    console.log("Dry run complete; no launch transaction was sent.");
    context.store.close();
    return;
  }

  const symbol = await publicClient.readContract({
    address: result.token,
    abi: erc20Abi,
    functionName: "symbol",
  }).catch(() => context.campaign.launch!.token.symbol);
  await recordAtomicOpeningPosition({
    store: context.store,
    campaign: context.campaign,
    wallet: prepared.recipient,
    deployer: prepared.creator.address,
    token: result.token,
    curve: result.curve,
    pairToken: prepared.pairToken,
    quoteDecimals: prepared.quoteDecimals,
    symbol,
    tokensOut: result.tokensOut,
    spent: result.spent,
    txHash: result.txHash,
    blockNumber: result.receipt.blockNumber,
  });

  const remaining = context.wallets.filter(
    (wallet) => wallet.address.toLowerCase() !== prepared.recipient.address.toLowerCase(),
  );
  if (remaining.length > 0) {
    const detected: DetectedV2Launch = {
      protocol: "v2",
      token: result.token,
      curve: result.curve,
      deployer: prepared.creator.address,
      pairToken: prepared.pairToken,
      launchConfigId: context.campaign.launch!.launchConfigId,
      graduationThreshold: 0n,
      blockNumber: result.receipt.blockNumber,
      transactionHash: result.txHash,
      seenAt: Date.now(),
    };
    await executeV2Detected(
      { client: publicClient, store: context.store, campaign: context.campaign, wallets: context.wallets },
      detected,
      remaining,
    );
  }
  await runPositionLoop(context);
}

async function run(args: string[]): Promise<void> {
  await setCredentials();
  const context = loadContext(parseCommandOptions(args).campaignFile);
  if (context.campaign.mode === "launch-and-buy") {
    context.store.close();
    throw new Error("Use the launch command for a launch-and-buy campaign");
  }
  const runId = randomUUID();
  context.store.saveCampaignRun({
    id: runId,
    campaignName: context.campaign.name,
    mode: context.campaign.mode,
    status: "running",
    contextJson: JSON.stringify({ protocols: context.campaign.protocols }),
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });

  if (context.campaign.mode === "direct-token") {
    await executeDirectTarget(context);
    await runPositionLoop(context, runId);
    return;
  }

  const positions = new DurablePositionEngine(
    publicClient,
    context.store,
    context.wallets,
    context.strategies,
  );
  positions.start(runtimeConfig.POSITION_TICK_MS);
  const active = new Set<string>();
  const unwatch = watchCampaignLaunches(context.campaign, (detected) => {
    const key = detected.token.toLowerCase();
    if (active.has(key)) return;
    active.add(key);
    void handleDetectedLaunch(
      { client: publicClient, store: context.store, campaign: context.campaign, wallets: context.wallets },
      detected,
    ).catch((error) => log.error({ error, token: detected.token }, "launch handling failed"))
      .finally(() => active.delete(key));
  });
  await waitForShutdown(() => {
    unwatch();
    positions.stop();
    context.store.saveCampaignRun({
      id: runId,
      campaignName: context.campaign.name,
      mode: context.campaign.mode,
      status: "stopped",
      contextJson: JSON.stringify({ protocols: context.campaign.protocols }),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    context.store.close();
  });
}

function status(): void {
  const store = new StateStore(runtimeConfig.STATE_DB_FILE);
  try {
    console.log(store.summary());
    console.table(store.listOpenPositions().map((position) => ({
      wallet: position.walletName,
      token: position.token,
      symbol: position.symbol,
      venue: position.venue,
      tokens: position.tokens.toString(),
      costBasis: formatUnits(position.costBasis, position.quoteDecimals),
      strategy: position.strategyId,
      highest: `${position.highestMultiple.toFixed(3)}x`,
      opened: new Date(position.openedAt).toISOString(),
    })));
    const pending = store.listPendingTransactions();
    if (pending.length > 0) console.table(pending);
  } finally {
    store.close();
  }
}

async function resume(args: string[]): Promise<void> {
  const context = loadContext(parseCommandOptions(args).campaignFile);
  await reconcilePending(context.store);
  await runPositionLoop(context);
}

async function sellAll(args: string[]): Promise<void> {
  const options = parseCommandOptions(args, true);
  if (!runtimeConfig.DRY_RUN && !options.yes) {
    throw new Error("Emergency liquidation requires --yes (or enable DRY_RUN)");
  }
  const context = loadContext(options.campaignFile);
  try {
    await reconcilePending(context.store);
    const engine = new DurablePositionEngine(
      publicClient,
      context.store,
      context.wallets,
      context.strategies,
    );
    await engine.liquidateAll("operator-requested");
  } finally {
    context.store.close();
  }
}

async function executeDirectTarget(context: Context): Promise<void> {
  const token = context.campaign.target.token!;
  const lifecycle = await readV2Lifecycle(publicClient, token);
  if (lifecycle.stage !== "curve") throw new Error(`Direct target is in ${lifecycle.stage}, not curve trading`);
  const blockNumber = await publicClient.getBlockNumber();
  const record = await publicClient.readContract({
    address: PONS_V2.factory,
    abi: ponsV2FactoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  });
  await executeV2Detected(
    { client: publicClient, store: context.store, campaign: context.campaign, wallets: context.wallets },
    {
      protocol: "v2",
      token,
      curve: lifecycle.curve,
      deployer: lifecycle.deployer,
      pairToken: lifecycle.pairToken,
      launchConfigId: 0n,
      graduationThreshold: record.graduationThreshold,
      blockNumber,
      transactionHash: `0x${"0".repeat(64)}`,
      seenAt: Date.now(),
    },
  );
}

async function reconcilePending(store: StateStore): Promise<void> {
  for (const transaction of store.listPendingTransactions()) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: transaction.hash });
      store.updateTransaction(
        transaction.hash,
        receipt.status === "success" ? "confirmed" : "failed",
        { confirmedAt: Date.now(), blockNumber: receipt.blockNumber },
      );
    } catch {
      log.warn({ hash: transaction.hash }, "transaction still pending or unavailable");
    }
  }
}

async function runPositionLoop(context: Context, runId?: string): Promise<void> {
  const engine = new DurablePositionEngine(
    publicClient,
    context.store,
    context.wallets,
    context.strategies,
  );
  await engine.tick();
  engine.start(runtimeConfig.POSITION_TICK_MS);
  await waitForShutdown(() => {
    engine.stop();
    if (runId) {
      context.store.saveCampaignRun({
        id: runId,
        campaignName: context.campaign.name,
        mode: context.campaign.mode,
        status: "stopped",
        contextJson: "{}",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    context.store.close();
  });
}

function printAtomicPlan(prepared: Awaited<ReturnType<typeof prepareAtomicLaunch>>): void {
  console.log("Atomic Pons v2 launch-and-buy plan");
  console.table([{
    creator: prepared.creator.campaign.name,
    recipient: prepared.recipient.campaign.name,
    pairToken: prepared.pairToken === zeroAddress ? "native ETH" : prepared.pairToken,
    quoteIn: formatUnits(prepared.quoteIn, prepared.quoteDecimals),
    expectedTokens: prepared.quote.tokensOut.toString(),
    impact: `${prepared.quote.priceImpactBps / 100}%`,
    explicitExemptions: prepared.exemptions.length,
    omittedExemptions: prepared.omittedExemptions.length,
    salt: prepared.salt,
  }]);
}

function printCurvePlan(planResult: ReturnType<typeof planCurveEntries>, decimals: number): void {
  if (planResult.entries.length === 0) return;
  console.table(planResult.entries.map((entry) => ({
    order: entry.order,
    wallet: entry.walletName,
    part: `${entry.part}/${entry.parts}`,
    action: entry.action,
    requested: formatUnits(entry.requestedQuoteIn, decimals),
    planned: formatUnits(entry.quoteIn, decimals),
    tokens: entry.quote.tokensOut.toString(),
    impact: `${entry.quote.priceImpactBps / 100}%`,
    slippage: `${entry.slippageBps / 100}%`,
    reason: entry.reason,
  })));
  console.log(`Total planned spend: ${formatUnits(planResult.totalPlannedSpend, decimals)}`);
}

function waitForShutdown(cleanup: () => void): Promise<never> {
  return new Promise<never>(() => {
    const shutdown = (signal: string): void => {
      log.info({ signal }, "shutting down");
      cleanup();
      process.exit(0);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

function help(): void {
  console.log(`pons-launch-engine

Commands:
  doctor [-c file]    Validate files, RPC, contracts, wallets and launch settings
  plan [-c file]      Preview ordered wallet fills and price impact
  launch [-c file]    Atomically launch a Pons v2 token and execute the campaign
  run [-c file]       Monitor a target deployer or enter a direct target token
  status              Show durable positions and pending transactions
  resume [-c file]    Reconcile pending transactions and resume exit monitoring
  sell-all --yes      Sequential emergency liquidation; accepts -c file

Options:
  -c, --campaign <file>  Override CAMPAIGN_FILE for this command
`);
}

void main().catch((error) => {
  log.fatal({ err: error }, "command failed");
  process.exitCode = 1;
});
