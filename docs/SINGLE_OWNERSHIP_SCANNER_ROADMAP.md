# Single-Ownership Scanner Roadmap

Status: observation contract implemented; CI verification pending

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
7. Retire score credits and Tier authorization only after paper verification.

Live enforcement is out of scope. Safety gates are never downgraded.
