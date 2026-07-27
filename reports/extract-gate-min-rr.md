# Task: Extract Min R:R gate into shared function (Stage 2, Gate 1)
## Branch: manus/gate-minrr-shared
## Behavior changes
1. **Reason string format change (backtest-engine only):** The gate's reason string now uses the same format as bot-scanner (`R:R X.XX raw, Y.YY effective (spread Z.Zp) < N min`) instead of the old backtest format (`RR: Y.YY effective (X.XX raw, spread Z.Zp) min: N`). This is cosmetic — the pass/fail logic is identical.
2. **"No SL/TP calculated" → "No valid SL/TP for R:R check":** The failure message when SL/TP are missing is now consistent across both engines (previously backtest said "No SL/TP calculated").

No change to which trades pass or fail. The mathematical computation is identical.

## Files modified
- `supabase/functions/_shared/gateMinRR.ts` — NEW: shared Min R:R gate function with spread + optional commission cost accounting
- `supabase/functions/_shared/gateMinRR.test.ts` — NEW: 12 cross-engine agreement tests
- `supabase/functions/bot-scanner/index.ts` — Gate 10 replaced with `checkMinRR()` call (import added, 15 lines of inline logic → 7-line function call)
- `supabase/functions/backtest-engine/index.ts` — Gate 4 replaced with `checkMinRR()` call (import added, 12 lines of inline logic → 5-line function call)

## Tests added
1. `bot-scanner path matches backtest path for same spread` — proves both engines agree when given identical spread
2. `both engines FAIL for identical inputs below threshold` — proves agreement on rejection
3. `both engines agree on boundary case (comfortably above threshold)` — proves agreement near threshold
4. `both engines agree on just-below-boundary (fails)` — proves agreement just below threshold
5. `returns failed when SL is null` — edge case
6. `returns failed when TP is null` — edge case
7. `returns failed when both SL and TP are undefined` — edge case
8. `zero risk (SL == entry) returns failed` — division-by-zero guard
9. `commission cost reduces effective RR` — bot-scanner live path
10. `very high commission can cause failure` — proves commission can flip pass→fail
11. `cross-engine agreement on XAU/USD (different pip size)` — proves non-forex instruments agree
12. `backtest with wider spread produces different result than default` — proves spreadPipsOverride actually changes outcome

## Tests run
```
ok | 1655 passed | 0 failed (18s)
```

## Regression check
The shared function preserves the exact same mathematical formula from both engines:
- `effectiveReward = max(0, rawReward - spreadCostInPrice - commCostInPrice)`
- `effectiveRR = risk > 0 ? effectiveReward / risk : 0`
- `passed = effectiveRR >= minRiskReward`

Bot-scanner's commission path and backtest-engine's spread-only path are both exercised through the same function with optional parameters.

## Open questions
None.

## Suggested PR title and description
**Title:** `[gate-minrr-shared] Extract Min R:R gate into _shared/gateMinRR.ts`

**Description:**
Stage 2, Gate 1 of the gate consolidation plan.

Extracts the Min R:R check (spread + commission adjusted) from both bot-scanner (Gate 10) and backtest-engine (Gate 4) into a shared function in `_shared/gateMinRR.ts`.

- Bot-scanner passes `commissionPerLot` + `rateMap` for full cost accounting
- Backtest-engine passes `spreadPipsOverride` for per-candle spread data
- 12 cross-engine agreement tests prove identical pass/fail behavior
- No behavior change to which trades pass or fail
- Reason string format now consistent across both engines (cosmetic only)
