# Task: Extract ATR Volatility Filter gate to shared function
## Branch: manus/extract-gate-atr-volatility
## Behavior changes
none — pure refactor

## Files modified
- `supabase/functions/_shared/gateATRVolatility.ts` — New shared gate function
- `supabase/functions/_shared/gateATRVolatility.test.ts` — Cross-engine agreement tests
- `supabase/functions/bot-scanner/index.ts` — Gate 18: replaced inline if/else cascade with `checkATRVolatility()` call; added import
- `supabase/functions/backtest-engine/index.ts` — Gate 9b: replaced inline minOk/maxOk logic with `checkATRVolatility()` call; added import

## Tests added
- `checkATRVolatility: passes when ATR within range` — basic pass case
- `checkATRVolatility: fails when ATR below minimum` — min bound enforcement
- `checkATRVolatility: fails when ATR above maximum` — max bound enforcement
- `checkATRVolatility: min disabled when 0` — disabled bound behavior
- `checkATRVolatility: max disabled when 0` — disabled bound behavior
- `checkATRVolatility: both bounds disabled` — all-disabled pass
- `checkATRVolatility: at exact minimum boundary passes` — boundary behavior (strict <)
- `checkATRVolatility: at exact maximum boundary passes` — boundary behavior (strict >)
- `reason string: contains 'ATR ' for gatePerformanceEngine pattern` — reason string safety
- `reason string: split(':')[0] yields 'ATR filter' for backtest diagnostics` — aggregation key safety
- `cross-engine: shared matches bot-scanner inline for all test cases` — 10 synthetic inputs
- `cross-engine: shared matches backtest-engine inline for all test cases` — 10 synthetic inputs
- `boundary: bot-scanner uses strict < for min (not <=)` — boundary precision
- `boundary: bot-scanner uses strict > for max (not >=)` — boundary precision

## Tests run
```
ok | 1742 passed | 0 failed (18s)
```

## Regression check
Cross-engine agreement tests replicate both engines' original inline logic as local functions and assert the shared function produces identical pass/fail on 10 synthetic inputs per engine. Boundary tests verify the exact comparison operators (strict < for min, strict > for max) match both engines' original behavior.

## Reason string safety
- `gatePerformanceEngine.ts` pattern `includes("ATR ")` — satisfied by "ATR filter: ..." format ✅
- Backtest diagnostics `split(":")[0]` — yields "ATR filter" aggregation key ✅
- No other consumers parse this reason string (Telegram, narrative, dashboard checked)

## Note on boundary semantics
Bot-scanner used `<` for min and `>` for max (strict inequalities — at boundary = pass).
Backtest-engine used `>=` for pass and `<=` for pass (non-strict — at boundary = pass).
Both agree: at the exact boundary value, the gate passes. The shared function preserves this with strict `<` and `>`.

## Open questions
None.

## Suggested PR title and description
**Title:** [extract-gate-atr-volatility] Extract ATR Volatility Filter to _shared/gateATRVolatility.ts

**Description:**
Extracts the ATR Volatility Filter gate check into a shared function used by both bot-scanner (Gate 18) and backtest-engine (Gate 9b). Both engines compute atrPips externally and pass it to the shared function, which handles only the threshold comparison and reason-string formatting.

Reason string format (`"ATR filter: ..."`) satisfies both `gatePerformanceEngine.ts` pattern matching (`includes("ATR ")`) and backtest diagnostics aggregation (`split(":")[0]` → `"ATR filter"`).

14 new tests including cross-engine agreement suites and reason-string safety assertions.
