# Task: Backtest Walk-Forward Implementation (Phase A4)
## Branch: manus/backtest-walk-forward
## Behavior changes
1. When `walkForwardFolds >= 2` is set in backtest config, results now include a `walkForward` object with per-fold statistics, consistency score, and verdict classification (robust/moderate/fragile)
2. Previously, setting `walkForwardFolds` did nothing — the parameter was accepted but ignored. Now it activates real time-series cross-validation.
3. Progress message now includes walk-forward verdict when enabled (e.g., "Done: 45 trades, 62.5% WR, PF 1.85 | WF: robust (100%)")
4. Walk-forward only activates when `walkForwardFolds >= 2` AND `allTrades.length >= walkForwardFolds` (minimum 1 trade per fold)

## Files modified
- `supabase/functions/backtest-engine/index.ts` — Added WalkForwardFold and WalkForwardSummary interfaces (lines 184-208), computeWalkForward function (lines 1097-1196), invocation after stats calculation (lines 2712-2718), result inclusion (line 2752), and enhanced progress message (lines 2769-2771)
- `supabase/functions/backtest-engine/walkForward.test.ts` — New test file with 14 test cases

## Tests added
1. "4 folds with equal trade distribution" — verifies trades split correctly across 4 equal time periods
2. "verdict classification - robust (>= 0.75)" — all folds profitable → robust
3. "verdict classification - moderate (>= 0.50, < 0.75)" — 2/4 folds profitable → moderate
4. "verdict classification - fragile (< 0.50)" — 1/4 folds profitable → fragile
5. "fold boundaries are equal time slices" — verifies temporal boundaries are evenly spaced
6. "trades assigned by entryTime" — confirms trade-to-fold assignment uses entry timestamp
7. "empty fold handled gracefully" — folds with 0 trades produce 0 stats without errors
8. "best and worst fold identification" — correct fold indices for extremes
9. "win rate standard deviation computed correctly" — mathematical verification
10. "per-fold drawdown calculated correctly" — peak-to-trough within fold
11. "partial trades excluded from trade count but included in PnL" — _partial suffix filtering
12. "boundary trade goes to correct fold" — edge case at fold boundary
13. "PnL standard deviation measures fold-to-fold variance" — equal PnL → 0 stddev
14. "profitFactor per fold computed correctly" — grossProfit / grossLoss

## Tests run
```
$ deno test supabase/functions/backtest-engine/ --no-check --allow-read
ok | 209 passed | 0 failed (1s)
```

## Regression check
- All 195 existing tests (determinism, score parity, gates parity, SL override) continue to pass
- When walkForwardFolds = 0 (default), the code path is completely skipped — zero impact on existing behavior
- The function is pure (no side effects, no DB calls) — it only reads the already-computed trades array

## Open questions
1. Should the dashboard UI display walk-forward results? (Currently they're in the JSON results but not surfaced in the frontend)
2. Should walk-forward be enabled by default (e.g., 4 folds) or remain opt-in?
3. The existing `determinism.test.ts` has walk-forward contract tests (lines 279-392) that define the expected behavior — our implementation matches that contract exactly.

## Suggested PR title and description
**Title:** feat(backtest): implement walk-forward validation

**Description:**
The `walkForwardFolds` parameter was previously accepted but never used (phantom feature). This PR implements proper time-series cross-validation:

- Splits trades into N equal time-based folds by `entryTime`
- Computes per-fold statistics (win rate, PF, drawdown, expectancy)
- Calculates consistency score (profitable folds / total folds)
- Classifies result as robust (≥75%), moderate (≥50%), or fragile (<50%)
- Reports win rate standard deviation and PnL standard deviation across folds
- Only activates when `walkForwardFolds >= 2` and sufficient trades exist

This enables users to validate that their config performs consistently across different time periods, not just in aggregate.
