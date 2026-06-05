# Task: Unified Advisor — Gate Performance Engine

## Branch: manus/unified-advisor

## Behavior changes

none — pure analytics enhancement. This change does NOT alter:
- What trades get taken
- What positions get sized
- What gates pass or fail
- How rejected setups are logged

It only adds richer context to the LLM prompt used by bot-daily-review and bot-weekly-advisor when generating recommendations. The recommendations themselves still require manual user approval before any config changes are applied.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/gatePerformanceEngine.ts` | **NEW.** Pure-logic module implementing: confusion matrix per gate, CUSUM change detection, net gate value (cost-sensitive), walk-forward validation, regime breakdown, and prompt formatting. ~280 lines. |
| `supabase/functions/_shared/gatePerformanceEngine.test.ts` | **NEW.** 59 unit tests covering all functions: normalizeGateReason (22 gate name variants), computeCusum (7 cases), computeNetGateValue (5 cases), walkForwardValidate (3 cases), computeGatePerformance (8 integration cases), formatGatePerformancePrompt (4 cases), and 1 regression test. |
| `supabase/functions/bot-daily-review/index.ts` | Added import of gatePerformanceEngine. Added Step 5b: query resolved rejected_setups (last 7 days), compute gate performance, format prompt section. Added `gatePerformancePrompt` parameter to `buildUserPrompt`. Added gate performance guidance to SYSTEM_PROMPT (5 rules for LLM to follow). Added `gatePerformanceIncluded` flag to stored performance_summary. |
| `supabase/functions/bot-weekly-advisor/index.ts` | Same integration as bot-daily-review but using 4-week window (matches existing `fourWeeksAgo` cutoff). Added import, Step 8b query, `gatePerformancePrompt` parameter to `buildWeeklyPrompt`, and gate performance guidance to WEEKLY_SYSTEM_PROMPT. |

### Extra caution notes (Rule 3 files):

**bot-daily-review/index.ts:** Added ~45 lines. The change is purely additive — a new data query (Step 5b) that runs in a try/catch so failures are non-fatal, and an optional parameter appended to the existing prompt. The existing flow (Steps 1-7) is unchanged. The LLM output format is unchanged. The only difference is the LLM now receives additional context about gate performance when 10+ resolved rejections exist.

**bot-weekly-advisor/index.ts:** Same pattern as daily. ~45 lines added. Non-fatal try/catch around the rejected_setups query. Optional parameter to buildWeeklyPrompt. Existing flow unchanged.

## Tests added

| Test | Assertion |
|------|-----------|
| `normalizeGateReason` (22 tests) | Every known gate rejection string maps to the correct canonical gate ID |
| `computeCusum` (7 tests) | CUSUM accumulates correctly, breaches at threshold, doesn't false-alarm on sparse errors |
| `computeNetGateValue` (5 tests) | Dollar-weighted cost/benefit calculation is correct for all-TN, all-FN, balanced, and edge cases |
| `walkForwardValidate` (3 tests) | Train/test split produces consistent/inconsistent verdicts correctly |
| `computeGatePerformance` (8 tests) | Full integration: confusion matrices, CUSUM breaches, regime breakdown, walk-forward inclusion/exclusion, multi-gate rejections, empty inputs, filtering of pending/inconclusive |
| `formatGatePerformancePrompt` (4 tests) | Prompt formatting respects minSamples, includes gate table, CUSUM warnings, walk-forward results |
| `regression` (1 test) | Deterministic output for fixed inputs (guards against accidental logic changes) |

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-all
ok | 827 passed | 0 failed (13s)
```

All 827 tests pass (59 new + 768 existing).

## Regression check

1. **Type safety:** `deno check` passes on all 3 files (gatePerformanceEngine.ts, bot-daily-review/index.ts, bot-weekly-advisor/index.ts) with zero errors.
2. **Non-fatal integration:** The gate performance query is wrapped in try/catch. If it fails (e.g., table doesn't exist, network error), the daily/weekly review continues exactly as before — the `gatePerformancePromptStr` stays empty and is not appended to the prompt.
3. **Minimum data guard:** Gate performance analysis only runs when there are 10+ resolved rejections. Below that threshold, the prompt is identical to the previous version.
4. **No schema changes:** No database migrations needed. The code reads from the existing `rejected_setups` table using columns that already exist.
5. **No config changes required:** CUSUM threshold defaults to 5.0 (conservative). Users can optionally add `gatePerformance.cusumThreshold` and `gatePerformance.cusumSlack` to their bot_configs JSON if they want to tune sensitivity.

## Open questions

1. **rawDetail not populated:** The `logRejectedSetup` calls in bot-scanner don't pass `rawDetail` (the full factor breakdown). This means gate performance analysis can only use summary fields (score, tier1_count, failed_gates, regime, session). If you want per-factor analysis of rejected setups in the future, we'd need to start populating `raw_detail` — but that's a separate task and touches bot-scanner (Rule 3).

2. **Walk-forward split ratio:** Currently hardcoded at 0.7 train / 0.3 test. With only 7 days of daily data, this means ~5 days train / 2 days test. For the weekly advisor (4 weeks), it's ~3 weeks train / 1 week test. This is reasonable but could be made configurable if needed.

3. **Outcome-tracker deletion:** You confirmed 30 days is enough. If you ever want longer historical analysis, the outcome-tracker's cleanup logic would need adjustment (separate task).

## Suggested PR title and description

**Title:** feat: Unified Advisor — Gate Performance Engine with CUSUM change detection

**Description:**
Adds a shared gate performance analysis module that computes confusion matrices, CUSUM change detection, cost-sensitive net gate value, and walk-forward validation for each safety gate. Integrates into both bot-daily-review and bot-weekly-advisor to give the LLM full visibility into "what we took vs what we blocked" when generating recommendations.

Key features:
- Per-gate confusion matrix (TP/FP/TN/FN) from resolved rejected setups
- CUSUM sequential analysis to detect persistent over-filtering (configurable threshold)
- Dollar-weighted net gate value (cost of false negatives vs benefit of true negatives)
- Walk-forward validation to prevent overfitting recommendations
- Regime-aware breakdown (trending vs ranging performance per gate)
- Non-fatal integration: gracefully degrades if insufficient data (<10 rejections)

No behavior changes to trading logic. Pure analytics enhancement to the advisor LLM prompt.

59 new tests, 827 total passing.
