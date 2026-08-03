# Single-Ownership Scanner Roadmap

Status: paper and explicit live single-ownership enforcement implemented

## Decision ownership

- Direction Verdict owns direction.
- Zone Story owns impulse, selected OB/FVG, liquidity context, invalidation,
  and setup readiness.
- Canonical Dealing Range owns price location.
- Confirmation Authority owns entry timing.
- Thesis Validation owns lifecycle validity.
- Operational Safety owns account, broker, news, exposure, drawdown, spread,
  duplicate, cooldown, and risk checks.
- Legacy percentages, tiers, weights, bonuses, penalties, and Impulse-Zone
  credits are diagnostics only under single-ownership enforcement.

## Phases

1. Pure decision contract and historical duplication baseline.
2. Attach observation to live scanner, rejected setups, trades, and backtest.
3. Add Rejected Setups comparison UI.
4. Add paper-only `Observe` and `Enforce` modes with immediate rollback.
5. Let owned authorities reach safety evaluation without requiring the legacy
   score threshold first in paper enforcement.
6. Continue recording the legacy decision and diagnostics for comparison.
7. Retire score, tier, conflict and duplicate ICT authorization in explicit paper enforcement while retaining their diagnostic output.
8. Apply fill-time parity to main pending fills and fast zone confirmation.
9. Collapse legacy diagnostics in scan, position and signal details.

Live enforcement requires the explicit `Enforce Live` mode. Operational safety gates are never downgraded.
Duplicate ICT, conflict, score and tier gates are diagnostic-only in explicit
paper enforcement. Unified and standalone Zone Story routes remain active, and
unknown future gates fail closed until explicitly classified.
