# Task: SL/TP Recalculation on Verdict Direction
## Branch: manus/sltp-recalc-on-verdict
## Behavior changes
1. Pairs that previously failed Gate 10 ("No valid SL/TP for R:R check") because `simpleDirection` returned null — but the Direction Verdict later assigned a valid direction — will now have SL/TP recalculated using the verdict direction. This means more pairs may pass the R:R gate and potentially be taken as trades.
2. The recalculation uses identical inputs to what `runConfluenceAnalysis()` would have used (structure swingPoints, orderBlocks, liquidityPools, ATR, FVGs, fib extensions, DOL targets), ensuring the SL/TP values are structurally sound and not arbitrary.

## Files modified
- `supabase/functions/bot-scanner/index.ts` — Added SL/TP recalculation block (lines 4492-4525) after the direction sync. When `effectiveDirection` is non-null but `analysis.stopLoss` or `analysis.takeProfit` are null, calls `calculateSLTP()` with the verdict direction and all structural inputs from the analysis object. Logs the recalculated values or failure reason.
- `supabase/functions/_shared/sltpRecalc.test.ts` — New test file with 9 regression tests.

## Why this change was needed (bot-scanner/index.ts — extra caution file)
The `calculateSLTP()` function is called inside `runConfluenceAnalysis()` with the direction from `_overrideDirection`. When `simpleDirection` returns null (no trade signal from the direction engine), `_overrideDirection = null`, and `calculateSLTP()` immediately returns `{ stopLoss: null, takeProfit: null }`. Later, the Direction Verdict (which aggregates multiple bias sources) may assign a valid direction and sync it to `analysis.direction`. However, the SL/TP fields remain null because they were computed before the verdict ran. Gate 10 then checks `analysis.stopLoss && analysis.takeProfit` and auto-fails. The fix adds a targeted recalculation that only fires when: (a) verdict provides a direction, AND (b) SL/TP are currently null. This is safe because `calculateSLTP()` is a pure function with well-defined fallbacks.

## Tests added
1. `direction=null returns null SL/TP` — confirms the bug scenario (null direction → null SL/TP)
2. `direction='long' with same inputs produces valid SL/TP` — proves recalculation works for longs
3. `direction='short' with same inputs produces valid SL/TP` — proves recalculation works for shorts
4. `recalculation with no swings still produces valid SL/TP` — verifies fixedSLPips fallback
5. `recalculation with Gold (large pip size) produces valid SL/TP` — verifies non-forex instruments
6. `recalculation produces identical result to upfront direction (deterministic)` — proves idempotency
7. `below_ob SL method works in recalculation scenario` — verifies OB-based SL method
8. `atr_based SL method works in recalculation scenario` — verifies ATR-based SL method
9. `next_level TP method works with recalculated SL` — verifies structural TP method

## Tests run
```
running 9 tests from ./supabase/functions/_shared/sltpRecalc.test.ts
REGRESSION: direction=null returns null SL/TP (confirms the bug scenario) ... ok (1ms)
REGRESSION: direction='long' with same inputs produces valid SL/TP (the recalculation scenario) ... ok (250µs)
REGRESSION: direction='short' with same inputs produces valid SL/TP (the recalculation scenario) ... ok (139µs)
REGRESSION: recalculation with no swings still produces valid SL/TP (fallback to fixedSLPips) ... ok (83µs)
REGRESSION: recalculation with Gold (large pip size) produces valid SL/TP ... ok (164µs)
REGRESSION: recalculation produces identical result to upfront direction (deterministic) ... ok (174µs)
REGRESSION: below_ob SL method works in recalculation scenario ... ok (157µs)
REGRESSION: atr_based SL method works in recalculation scenario ... ok (239µs)
REGRESSION: next_level TP method works with recalculated SL ... ok (347µs)
ok | 9 passed | 0 failed (11ms)

Full suite: FAILED | 1398 passed | 7 failed (14s)
(7 failures are pre-existing — beTrailingRace, brokerFillPriceBE, zoneLiquidity — confirmed on main)
```

## Regression check
- Verified the 7 test failures exist identically on `main` branch (not introduced by this change)
- The fix is additive: it only fires when `analysis.stopLoss/takeProfit` are null AND `effectiveDirection` is non-null. If SL/TP were already computed (the normal case where simpleDirection returned a direction), this code path is never entered.
- `calculateSLTP()` is a pure function — same inputs always produce same outputs. The recalculation uses the exact same input sources as the original call in `confluenceScoring.ts`.

## Open questions
1. Should there be a dashboard indicator showing when SL/TP was recalculated (vs computed in the original scoring pass)? Currently it only logs to console.
2. The recalculation fires for ALL cases where SL/TP are null + direction is non-null. This includes the rare case where `calculateSLTP()` returned null even WITH a direction (e.g., no valid swing structure AND fixedSLPips=0). The code handles this gracefully (logs "RECALC failed") but won't change behavior for those edge cases.

## Suggested PR title and description
**Title:** fix: recalculate SL/TP after direction sync when verdict provides direction

**Description:**
Fixes the "No valid SL/TP for R:R check" gate failure that occurs when:
1. SimpleDirection returns null (no trade signal)
2. `_overrideDirection = null` → `calculateSLTP()` returns null SL/TP
3. Direction Verdict later assigns a valid direction
4. SL/TP remain null → Gate 10 auto-fails

The fix adds a targeted `calculateSLTP()` call after the direction sync (line 4490) that only fires when `effectiveDirection` is non-null but `analysis.stopLoss/takeProfit` are null. Uses the same structural inputs (swings, OBs, liquidity, ATR, FVGs, fib extensions, DOL targets) as the original call.

**Behavior change:** Pairs that previously auto-failed the R:R gate due to null SL/TP will now get valid SL/TP computed and may pass → more trades evaluated.
