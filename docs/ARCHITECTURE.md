# Architecture

The executable entry point is `src/cli.ts`. It loads strict JSON configuration,
builds runtime wallet signers, and connects protocol adapters to a durable state
store.

```text
credentials + campaign + strategies
               |
               v
        campaign validation
               |
       +-------+--------+
       |                |
       v                v
 launch detection   atomic v2 launch
       |                |
       +-------+--------+
               v
       planner + scheduler
               |
       v1 v3 / v2 curve entry
               |
               v
          SQLite state
               |
               v
        position rule engine
               |
     v1 v3 / v2 curve / v2 v4
```

## Main modules

- `src/core/campaign.ts`: campaign schema and cross-file validation.
- `src/core/strategies.ts`: strategy schema and normalized percentages.
- `src/core/credentials.ts`: local credential validation and encrypted vaults.
- `src/core/planner.ts`: ordered curve projection and impact policy.
- `src/core/scheduler.ts`: batching, wallet nonce lanes, and retry policy.
- `src/core/store.ts`: SQLite schema and transactional state updates.
- `src/core/entryEngine.ts`: detected-launch and direct-token entries.
- `src/core/positionEngine.ts`: durable exit rules and venue transitions.
- `src/protocol/v2Launch.ts`: official Pons atomic launch-and-buy integration.
- `src/protocol/v2Lifecycle.ts`: phase and Uniswap v4 pool reconstruction.
- `src/protocol/uniswapV4.ts`: quote, Permit2 approval, and Universal Router
  execution for graduated positions.

## Durable records

The state database has independent records for launches, transaction hashes,
positions, triggered rules, campaign runs, and checkpoints. Transaction hashes
are not inferred from balances. A restart first reconciles pending hashes and
then resumes rule evaluation from the stored position state.

Every wallet has a local nonce lane. The scheduler can run independent markets
in parallel but will not overlap transactions from the same wallet. Orders
against the same Pons v2 curve use a shared market lane and settle one at a time
so each sibling receives a fresh quote.
