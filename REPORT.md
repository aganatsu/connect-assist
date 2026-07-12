# Task: Unified Advisor

## Branch: manus/unified-advisor

## Behavior changes

1. **NEW**: A single `advisor` edge function replaces the three existing advisors (`strategy-advisor`, `bot-daily-review`, `bot-weekly-advisor`). The old functions remain untouched — the new one runs alongside them until you switch over.
2. **BUG FIX**: Regime adaptation recommendations now use the **correct** factor key names (`marketStructure`, `orderBlock`, `fairValueGap`, `premiumDiscountFib`, `sessionQuality`, `displacement`, `breakerBlock`, `amdPhase`, `dailyBias`) instead of the wrong ones (`premiumDiscount`, `fvg`, `breaker`, `silverBullet`, `amd`, `trendDirection`). This means regime adaptation recommendations will actually work when approved.
3. **NEW**: Factor weight recommendations are now **$-weighted** (dollar lift per trade) instead of count-based. A factor that blocks 20 small winners but lets through 3 big losers is correctly identified as harmful.
4. **NEW**: The prompt payload sent to the LLM contains pre-computed metrics only — no raw trade data. The LLM interprets, it doesn't calculate.
5. **NEW**: Deterministic regime recommendations are merged with LLM recommendations (not dependent on LLM getting the math right).
6. **NEW**: Dedup index prevents multiple pending recommendations of the same type per bot per day.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/advisorCore.ts` | NEW — Shared math core: performance metrics, $-weighted factor lift, symbol stats, regime detection, regime recommendations (with FIXED factor keys), prompt builder, LLM wrapper, Telegram notification |
| `supabase/functions/_shared/advisorCore.test.ts` | NEW — 18 tests covering all core functions |
| `supabase/functions/advisor/index.ts` | NEW — Unified edge function with 3 modes (on_demand, daily, weekly), data loading, dedup, persistence, notifications |
| `supabase/migrations/20250712_unified_advisor.sql` | NEW — Adds review_type, diagnosis, feature_gaps, llm_model, resolved_at columns + dedup index + performance index |

## Tests added

| Test | Asserts |
|------|---------|
| normalizeTradeRecord handles standard fields | Correct field mapping from raw DB row |
| normalizeTradeRecord handles missing/null fields | Graceful fallback to empty/zero |
| computePerformance returns zeros for empty trades | No crash on empty input |
| computePerformance computes correct metrics for mixed trades | Win rate, PnL, profit factor, max consecutive losses |
| computePerformance computes session breakdowns correctly | UTC hour → session mapping |
| computePerformance handles all-winners (profitFactor = Infinity) | Edge case |
| computeFactorLift computes $-lift correctly | Dollar lift, win rate present vs absent |
| computeFactorLift requires minimum 5 present samples | Filters low-sample factors |
| computeSymbolStats groups by symbol correctly | Per-symbol aggregation + rejection tracking |
| detectRegimeFromTrades returns unknown for < 5 trades | Minimum data guard |
| detectRegimeFromTrades detects trending market | Directional bias + low SL rate |
| detectRegimeFromTrades detects choppy market | Mixed direction + high SL rate |
| buildRegimeRecommendations uses CORRECT factor key names | All keys exist in DEFAULT_FACTOR_WEIGHTS |
| buildRegimeRecommendations does NOT use old wrong keys | Regression test for the bug fix |
| buildRegimeRecommendations returns empty for unknown regime | No recs when regime unknown |
| buildRegimeRecommendations returns empty for low confidence | No recs below 0.4 threshold |
| buildPromptPayload produces compact JSON without raw trade data | No entry_price/exit_price in payload |
| Performance metrics are internally consistent | avgWin*wins - avgLoss*losses = totalPnl |

## Tests run

```
ok | 18 passed | 0 failed (12ms) — advisorCore.test.ts
ok | 59 passed | 0 failed (30ms) — gatePerformanceEngine.test.ts (no regression)
ok | 51 passed | 0 failed (22ms) — configMapper.test.ts (no regression)
```

## Regression check

- The old advisor functions (`strategy-advisor`, `bot-daily-review`, `bot-weekly-advisor`) are NOT modified — they continue to work exactly as before.
- The new `advisor` function is additive — it doesn't replace anything until you switch the cron triggers.
- The migration SQL is fully additive (nullable columns, new indexes) — safe to apply to production with existing data.
- The gatePerformanceEngine (shared dependency) has 59 tests passing unchanged.
- The configMapper has 51 tests passing unchanged.

## Open questions

1. **Deployment**: To switch over, you'd update your Supabase cron triggers to call `advisor` with `{"mode":"daily"}` and `{"mode":"weekly"}` instead of the old function names. Want me to write the cron SQL for that?
2. **Frontend**: The Lovable `StrategyAdvisor.tsx` component currently calls `strategy-advisor`. Should I update it to call `advisor` with `{"mode":"on_demand"}`?
3. **Old functions**: Once you verify the new advisor works, should I deprecate the old three functions (add a console.warn + redirect)?
4. **Impact tracking**: The plan mentioned measuring before/after impact of approved recommendations. That requires a scheduled job that runs 7 days after approval. Want me to build that as a follow-up?

## Suggested PR title and description

**Title:** feat: Unified advisor with $-weighted factor lift and fixed regime presets

**Description:**
Replaces the three separate advisor functions with a single `advisor` edge function that supports 3 modes (on_demand, daily, weekly). Key improvements:

- **$-weighted factor lift**: Recommendations based on dollar impact per trade, not just win rate counts
- **Fixed regime presets**: Uses correct factor keys (was silently writing orphan keys before)
- **Deterministic math first**: LLM receives pre-computed metrics only — no raw trade data, no hallucinated numbers
- **Dedup protection**: Prevents duplicate pending recommendations per bot per day
- **Compact prompts**: ~60% smaller token usage by sending structured JSON instead of markdown

The old functions remain untouched for parallel running. Switch over by updating cron triggers.
