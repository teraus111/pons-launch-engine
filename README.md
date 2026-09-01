# pons-launch-engine

An open-source campaign engine for launching and buying your own tokens on
[Pons](https://docs.ponsfamily.com/) on Robinhood Chain (chain ID `4663`). It
supports Pons v1 and v2, controlled multi-wallet execution, persistent position
tracking, and automated exits through the venue where the token currently
trades.

(“Pons v1” and “Pons v2” below refer to the two protocol generations, not the application version.)

## Features

- Monitors one designated deployer for Pons v1 and/or v2 launches.
- Can atomically create a Pons v2 token and make its first buy with the official
  `launchAndBuy` router.
- Supports native ETH and approved custom Pons v2 pairing assets.
- Uses up to 32 explicit Pons v2 exemption addresses, while verifying the live
  recipient tax before every opening-window buy.
- Targets the Pons v1 restricted blocks `N+1` and `N+2` with protocol-aware
  wallet and cumulative caps.
- Plans wallet fills in order, schedules configurable batches, and serializes
  orders sharing a v2 curve so every later wallet requotes after the prior fill.
- Supports automatic or fixed slippage, price-impact limits, order splitting,
  retries, resizing, and skip policies.
- Supports tiered take profit, stop loss, trailing stop, break even, maximum
  hold time, and sequential emergency liquidation.
- Routes Pons v2 exits through the bonding curve before graduation and Uniswap
  v4 after graduation.
- Persists launches, transactions, positions, triggered rules, and campaign
  runs in SQLite so monitoring can resume after a restart.
- Keeps wallet keys in a local gitignored credentials file. Keys are never
  printed by the included tools.

| Pons generation | Entry venue | Opening behavior | Exit venue |
| --- | --- | --- | --- |
| v1 | Uniswap v3 | Restricted attempts in `N+1` and `N+2`, then fallback | Same v3 pool |
| v2 | Bonding curve | Atomic launch-and-buy or tax-aware ordered entries | Curve, then Uniswap v4 |

## Requirements

- Node.js `22.5.0` or newer
- A dedicated Robinhood Chain RPC provider with HTTP and preferably WebSocket
  endpoints
- Alchemy for RPC provider (free account)
- Dedicated wallets funded only with assets you can afford to lose

## Installation

```bash
git clone https://github.com/slightlyuseless/pons-launch-engine.git
cd pons-launch-engine
npm install
cp .env.example .env
cp credentials.example.json credentials.json
cp strategies.example.json strategies.json
cp campaign.example.json campaign.json
cp launch-campaign.example.json launch-campaign.json
```

On PowerShell, replace `cp` with `Copy-Item`.

Set your provider URLs in `.env`. The official Pons and Uniswap contract
addresses are built in; the public Robinhood endpoint is used only as a read
fallback.

## Wallet credentials

`credentials.json` contains wallet identity only. A wallet’s entry and exit
rules belong in `strategies.json`, so the same strategy can be reused by many
wallets without duplicating secrets.

```json
[
  {
    "name": "Wallet 1",
    "privateKey": "0x...",
    "publicKey": "0x..."
  }
]
```

`publicKey` means the wallet’s 20-byte EVM address. It must match the private
key. Names, private keys, and addresses must each be unique.

You can import existing wallets by adding them with this schema, or append new
wallets without replacing existing entries:

```bash
npm run generate-wallets -- 5
```

Generated names start at `Wallet 1` and skip every existing name. Private keys
are written only to the configured credentials file and are not printed.

## Strategies

Each top-level key in `strategies.json` is a reusable strategy profile:

```json
{
  "opening": {
    "entry": {
      "amount": "0.1",
      "slippage": "auto",
      "maxPriceImpact": "20%",
      "maxSnipeTax": "0%",
      "onPriceLimit": "resize",
      "splitOrders": 1
    },
    "exit": {
      "takeProfit": [
        { "at": "2x", "sell": "25%" },
        { "at": "4x", "sell": "50%" }
      ],
      "stopLoss": "50%",
      "trailingStop": "20%",
      "breakEvenAfter": "2x",
      "maxHoldSeconds": null
    }
  }
}
```

`amount` uses the pairing asset’s decimals. `maxSnipeTax: "0%"` is appropriate
for verified exempt wallets. A non-exempt wallet waits until the contract’s
live recipient tax is at or below its configured maximum. Automatic slippage
uses the current quote and impact; every transaction still receives an explicit
minimum output.

See [docs/STRATEGY.md](docs/STRATEGY.md) for entry ordering, v1 restrictions,
v2 tax handling, exit precedence, and graduation behavior.

## Campaigns

`campaign.json` selects wallets by name, assigns each a strategy, and defines
their execution order. The three modes are:

- `monitor`: watch one deployer and react to matching Pons v1/v2 launches.
- `direct-token`: enter an already-known Pons v2 token contract.
- `launch-and-buy`: atomically create and buy a new Pons v2 token, then execute
  the remaining wallet entries.

Use [campaign.example.json](campaign.example.json) for monitoring and
[launch-campaign.example.json](launch-campaign.example.json) for an atomic v2
launch. The example credential is public test data and must never be funded.

`CAMPAIGN_FILE` in `.env` remains the default for campaign-aware commands. To
select a file for one command, use `--campaign <file>` or `-c <file>`. npm needs
its own `--` separator before flags passed to the engine:

```bash
npm run doctor -- --campaign launch-campaign.json
npm run plan -- --campaign launch-campaign.json
npm run launch
```

`npm run launch` selects `launch-campaign.json` automatically. Override it when
using a differently named launch file:

```bash
npm run launch -- --campaign my-launch.json
```

For a monitoring or direct-token campaign:

```bash
npm start -- --campaign campaign.json
```

### Uploading launch metadata with Pinata

To create a token programmatically, off-chain assets referenced by its metadata
must be uploaded to an IPFS service. A local image path is only meaningful on
your computer and cannot be used as the token's public logo. Pons stores the
other supplied metadata onchain; the engine uploads the local logo and places
the resulting `ipfs://CID` in the launch transaction.

The launch example supports [Pinata IPFS](https://pinata.cloud/):

1. Create a free Pinata account.
2. Create an API key with public file-upload permission and copy its JWT.
3. Paste the JWT into your local `.env` file. Never put it in campaign JSON or
   commit it to Git.

```dotenv
PINATA_JWT=YOUR_PINATA_JWT
```

4. Set the image path in `launch-campaign.json`, relative to that campaign
   file:

```json
"logoFile": "./assets/token-logo.png"
```

PNG, JPEG, GIF, WebP, and SVG files up to 10 MB are accepted. `doctor` and
`plan` validate the local file. A real `launch` uploads it to Pinata's public
IPFS and uses the returned URI; a dry run does not upload anything.

If the image is already hosted on IPFS, use `"logo": "ipfs://..."` instead.
Set exactly one of `logoFile` or `logo`.

Pons v2 supports at most 32 explicit exemption addresses. The first 32 campaign
wallets with `exempt: true` are included in execution order, excluding addresses
the protocol exempts automatically. Atomic-campaign `doctor` and `plan` output
reports any additional flagged wallets that were omitted. Marking a wallet
exempt in JSON does not bypass the contract check: the engine still requires
its live recipient tax to be zero before buying, so an omitted wallet waits
rather than paying the opening tax.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run doctor -- --campaign <file>` | Validate files, RPC chain, deployed contracts, wallets, and settings for one campaign |
| `npm run plan -- --campaign <file>` | Preview ordered spends, expected fills, impact, resizing, and skipped entries for one campaign |
| `npm run launch` | Execute `launch-campaign.json` as an atomic Pons v2 launch-and-buy campaign |
| `npm run launch -- --campaign <file>` | Execute a differently named atomic launch campaign |
| `npm start -- --campaign <file>` | Monitor a deployer or enter a direct target token using that campaign |
| `npm run status` | Show durable open positions and pending transactions |
| `npm run resume -- --campaign <file>` | Reconcile pending receipts and resume exit monitoring |
| `npm run sell-all -- --yes --campaign <file>` | Sequentially liquidate every open position |
| `npm run generate-wallets -- 5` | Append five locally generated wallets |
| `npm test` | Run the local test suite |
| `npm run typecheck` | Check TypeScript without emitting files |

An optional dry run can be enabled with `DRY_RUN=true`. Use `npm run doctor`
and `npm run plan` to inspect configuration and projected execution before any
broadcast.

## Recovery

The SQLite state file defaults to `state/pons.db`. On restart:

1. Run `npm run status` to inspect open positions and pending transactions.
2. Run `npm run resume` to reconcile receipts and restart exit monitoring.
3. Use `npm run sell-all -- --yes` only when you intentionally want emergency
   liquidation.

Do not delete the state database while positions remain open. The database does
not replace wallet ownership; it records what the engine knows about its work.

## Safety

- Later wallets can land later. V2 curve entries are serialized and requoted;
  v1 bounds account for sibling orders before its restricted-block batches.
  Neither path can guarantee sequencer ordering or execution.
- Quotes and simulations cannot eliminate price movement, RPC failures,
  sequencer ordering, tax, liquidity, or smart-contract risk.
- Pons v2 curve sells close before graduation completes. The engine tracks the
  lifecycle, can push a stalled permissionless graduation, and switches to v4
  after the pool exists, but the transition can temporarily make exits
  unavailable.
- The software is unaudited and independent of Pons, Uniswap, and Robinhood.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the component and state
model.

## License

MIT
