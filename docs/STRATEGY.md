# Execution strategy

The engine separates three concerns:

- `credentials.json` proves which wallets can sign.
- `campaign.json` selects and orders wallets for one launch.
- `strategies.json` defines reusable entry and exit rules.

That separation prevents a global environment value from silently overriding a
wallet’s intended size or risk controls.

## Ordered multi-wallet entry

Campaign wallets are sorted by `order`. Work is divided into `batchSize`
groups, while each wallet’s nonce lane remains sequential. Pons v2 entries that
share a curve also share a market lane: one receipt settles before the next
wallet reads and requotes the curve. `confirmEachBatch` controls whether other
independent lanes can advance while a batch remains pending.

For a v2 curve, the planner advances the curve through earlier sibling orders
before quoting each later order. This exposes the expected first-to-last fill
difference before execution. Live execution serializes those siblings, requotes
after each receipt, and applies the next order’s `onPriceLimit` policy:

- `resize` reduces the spend until it fits `maxPriceImpact`.
- `skip` leaves that order unsubmitted.
- `retry` asks the scheduler to retry within the configured retry budget.

`splitOrders` divides one wallet’s requested amount into sequential parts. It
can reduce the risk of one stale, oversized transaction but does not erase the
economic impact of the combined buy.

Fixed slippage accepts a percentage such as `"3%"`. `"auto"` derives a live
allowance from the current price impact, bounded between 1% and 25%. In both
cases, the quote already reflects preceding sibling fills and the transaction
contains a concrete minimum output.

## Pons v1 restricted blocks

Pons v1 launches directly into a Uniswap v3 pool. If the launch transaction is
in block `N`, ordinary external buys cannot land in that same launch block.
Blocks `N+1` and `N+2` remain restricted by the token’s per-wallet and
cumulative purchase limits.

The v1 adapter:

1. computes the wallet’s remaining restricted allowance;
2. attempts an exact-output swap in `N+1` within the active caps;
3. retries eligible failures around `N+2`; and
4. retains an exact-input fallback after the restriction window ends.

V1 does not have a persistent creator-managed exemption list. Its launch-time
exception is limited to the creator’s atomic initial buy.

## Pons v2 opening tax and exemptions

Pons v2 starts with a high buy-side snipe tax that decays during the first five
seconds. Tax is determined by the token recipient. The launcher, creator fee
recipient, atomic `launchAndBuy` recipient, and up to 32 explicitly configured
addresses can be exempt.

The contract’s `currentSnipeTaxBps(recipient)` result is authoritative:

- A campaign wallet marked `exempt: true` must read zero before it fires.
- A non-exempt wallet waits until the live tax is no greater than its strategy’s
  `maxSnipeTax`.
- If the threshold is not reached within `ENTRY_MAX_WAIT_MS`, the entry fails
  instead of accepting an unexpected tax.

The first 32 non-automatic campaign exemptions are passed to an atomic launch.
Additional wallets remain in the campaign but must observe a live zero tax
before entering; they are never silently allowed to pay the opening tax.

For an exempt own-launch wallet, waiting provides no tax benefit and usually
means a worse curve price. For a public wallet, firing immediately can sacrifice
most of the buy to tax. The two cases intentionally use different thresholds.

## Atomic Pons v2 launch-and-buy

`launch-and-buy` mode uses the official Pons router to create the token and
perform the first buy in one transaction. Before signing, the engine verifies:

- the chosen launch configuration is available;
- the pairing asset is approved by the Pons configuration;
- the creator tax and fee recipient are explicit;
- custom-pair approval is available when required;
- the explicit exemption list fits the 32-address protocol limit; and
- the opening amount respects its strategy impact policy.

The creator wallet pays for the launch transaction. `initialBuyWallet` selects
the token recipient and supplies that wallet’s strategy amount. Remaining
campaign wallets enter from freshly read curve state after the receipt.

## Exit rules

Position value is requoted in the launch pairing asset. Rules are evaluated in
this order:

1. stop loss;
2. break even after the configured profit threshold;
3. trailing stop from the highest recorded multiple;
4. maximum hold time; and
5. the next untriggered take-profit tier.

Only one exit action is started for a position in a tick. Triggered take-profit
rules are persisted, so a restart does not repeat them. A tier’s `sell`
percentage applies to the position balance remaining when that tier fires.

Exits are sent sequentially and requoted after preceding sells. This matters
because simultaneous sibling sells can move the curve or pool below later
wallets’ minimum-output bounds.

## Pons v2 lifecycle

The Pons factory phase is used instead of inferring the venue from time:

| Phase | Engine behavior |
| --- | --- |
| Curve | Quote and sell directly through the curve |
| Swept | Wait for, or permissionlessly push, pool creation |
| Pool | Reconstruct the PoolKey and route through Uniswap v4 |
| Rescue | Keep the position recorded and report the exceptional state |

When `readyToGraduate()` becomes true, curve sells are already closed even if
the pool has not yet been created. There can therefore be a temporary interval
where no exit venue is available.

## Persistence and retries

SQLite records submitted transactions before confirmation, along with launches,
positions, rule triggers, and campaign runs. `npm run resume` reconciles pending
hashes with chain receipts before restarting the position loop.

Retries are reserved for errors classified as transient, such as pending nonce,
rate limiting, replacement, timeout, or price-limit retry requests. Contract
reverts that indicate a permanent validation failure are surfaced rather than
blindly replayed.
