# Single-Ownership Scanner Phase 3

Date: 2026-08-03

## Scope

Phase 3 adds reversible enforcement for paper/demo execution and backtests.
Live execution remains observation-only.

## Authorization

When `strategy.singleOwnershipMode` is `enforce`, a complete `allow` from the
single-ownership decision replaces legacy percentage, tier and factor-gate
authorization. The owned decision requires:

- Direction Verdict alignment
- a valid, entry-ready Zone Story
- canonical dealing-range location when enabled
- required confirmation
- valid thesis when required
- passing operational safety checks

Missing evidence, `watch`, and `block` fail closed. Valid stop-loss and
take-profit values remain mandatory after authorization.

## Safety Boundary

- Default mode is `observe`.
- Enforcement is limited to paper/demo and backtest paths.
- A live account requesting enforcement is downgraded to observation.
- The legacy score, tiers and factors remain persisted as diagnostics.
- Switching the selector back to `Observe` is the immediate rollback.

## Remaining Work

Early hard ICT and conflict gates still run before the final authority boundary.
They should only be retired after their evidence is represented in Zone Story,
Direction Verdict, Confirmation Authority, or Operational Safety.
