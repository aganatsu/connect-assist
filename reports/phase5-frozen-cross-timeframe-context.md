# Cross-Timeframe Impulse Authority — Phase 5

## Outcome

Phase 5 adds `frozen-cross-tf-context.v1` to the existing immutable
`setup-policy-freeze.v1` package.

Every newly qualified setup now carries one exact provenance chain:

- Timeframe Evidence row ID
- Gameplan ID and version
- Direction Verdict ID and version
- style-policy version, base hash, and pair-specific hash
- selected zone candidate ID, timeframe, lifecycle, and model rank
- parent/child relationship and overlap measurements
- selected child impulse reference and parent candidate impulse reference
- current evidence-certificate hashes

The package is propagated through Watchlist, pending confirmation, and opened
position by the existing setup lifecycle. Confirmation cannot replace it with a
newer scan, plan, verdict, policy, or zone story.

## One authority

This phase deliberately extends `frozen_strategy_context`; it does not create a
parallel strategy snapshot. The existing database trigger and
`frozen_strategy_hash` constraint still protect the complete package.

Generated read-only columns expose the contract version, Timeframe Evidence ID,
and relationship on `staged_setups`, `pending_orders`, and `paper_positions`.
They are projections from the frozen JSON, not writable copies.

## UI

Zone Story shows a **Frozen authority** row whenever the record has qualified
setup context. It identifies the exact Gameplan, Direction Verdict, lineage,
style-policy hash, and evidence certificates used at qualification.

## Runtime safety

`frozen-cross-tf-context.v1` is observation-only. It records the complete
decision provenance but does not alter the current winner, score, gate,
position size, order type, or broker execution.

## Validation

- Pure contract tests cover populated and absent-zone contexts.
- Wiring tests cover all setup construction paths and database projections.
- Existing setup lifecycle tests prove frozen evidence survives later runtime
  changes.
- Full Deno, TypeScript, lint, and production build checks are required before
  this phase is opened for review.

## Deployment

Apply:

`supabase/migrations/20260802010000_add_frozen_cross_timeframe_context.sql`

Deploy:

- `bot-scanner`

Publish the frontend to expose the Frozen authority row.

## Explicitly deferred

No lineage or scenario field becomes executable in this phase. Phase 6 measures
the shadow policy against historical and forward outcomes before any controlled
mode can be offered.
