# Task: HTF POI Detection (Phase 1)
## Branch: manus/htf-poi-detection
## Behavior changes
1. **New scoring factor "HTF POI Alignment" (Factor 23, Tier 2)**: When price is inside a higher-timeframe FVG, Order Block, or Breaker Block, the confluence score receives a boost of up to +2.0 points. This means setups that are backed by HTF institutional zones will score higher and be more likely to pass the confluence threshold.
2. **1H candles are now always fetched** (previously only fetched when Opening Range was enabled). This adds +1 API call per pair per scan cycle for configs that had Opening Range disabled.
3. **HTF POIs appear as layers in confluence stacking display**: The scan output now shows HTF zone backing (e.g., "FVG + S/R + Fib 61.8% + 4H FVG").
4. **Snapshot baselines updated**: The confluence scoring snapshot tests have been regenerated to include the new factor in the factor list.
5. **enabledMax increased by 2.0**: The maximum possible tiered score is now 2.0 higher (HTF POI Alignment max weight), which slightly lowers the percentage score for setups that do NOT have HTF backing. This is intentional — it makes HTF-backed setups relatively stronger.

## Files modified
- `supabase/functions/bot-scanner/index.ts` — Added HTF POI computation (runs detectFVGs, detectOrderBlocks, detectBreakerBlocks on 4H and 1H candles), injects results as `config._htfPOIs`. Made 1H candle fetch unconditional.
- `supabase/functions/_shared/confluenceScoring.ts` — Added Factor 23 "HTF POI Alignment" scoring logic. Checks if lastPrice is inside any HTF POI, applies tiered scoring (4H > 1H, FVG > OB > Breaker, aligned > neutral > counter), caps at 2.0. Injects HTF POI layers into confluence stacking. Added to TIER_2_FACTORS and FACTOR_MAX_WEIGHT.
- `supabase/functions/_shared/smcAnalysis.ts` — Extended ConfluenceLayer type to support `"htf_fvg" | "htf_ob" | "htf_breaker"` types. Updated label builder to handle HTF layer types.
- `supabase/functions/_shared/__snapshots__/confluenceScoring.snapshot.json` — Regenerated (includes new factor)
- `supabase/functions/_shared/__snapshots__/confluenceScoring.bearish.snapshot.json` — Regenerated
- `supabase/functions/_shared/__snapshots__/confluenceScoring.ranging.snapshot.json` — Regenerated
- `supabase/functions/_shared/htfPOIAlignment.test.ts` — New test file (9 tests)

## Tests added
1. `HTF POI: no data → factor scores 0` — Verifies null/absent _htfPOIs produces no score
2. `HTF POI: POIs exist but price not inside any → factor scores 0` — Verifies distant POIs don't score
3. `HTF POI: price inside 4H FVG → scores correctly` — Verifies base 0.8 score for 4H FVG
4. `HTF POI: price inside counter-directional 4H FVG → same or reduced score vs aligned` — Verifies alignment multiplier
5. `HTF POI: multiple POIs → scores stack, capped at 2.0` — Verifies cap enforcement
6. `HTF POI: 1H zones score less than 4H zones` — Verifies timeframe hierarchy
7. `HTF POI: no regression — absent _htfPOIs produces same score as explicit null` — Backward compatibility
8. `HTF POI: htfPOIs field is returned in analysis result` — Verifies return object includes data
9. `HTF POI: factor is classified as Tier 2` — Verifies tier assignment

## Tests run
```
$ deno test --no-lock --no-check --allow-read --allow-write --allow-env supabase/functions/
ok | 258 passed | 0 failed (6s)
```

## Regression check
- Snapshot tests regenerated and verified stable on second run (identical output)
- All 258 tests pass including existing structure invalidation, confluence scoring, gate, and management tests
- When `_htfPOIs` is null or absent, the factor scores exactly 0 with no side effects — existing behavior is preserved for any config that doesn't compute HTF POIs
- The enabledMax increase (from +2.0 max weight) slightly lowers percentage scores for non-HTF-backed setups. This is intentional and documented as behavior change #5 above.

## Open questions
1. **Daily candles for swing_trader HTF POI**: Currently the bot-scanner only computes HTF POIs on 4H and 1H candles. For swing_trader, you mentioned wanting 4H + Daily. The daily candles ARE fetched but the current implementation only runs detection on 4H + 1H. Adding Daily detection is a small follow-up (same pattern, just add daily candles to the detection loop). Want me to add this?
2. **Score impact on existing setups**: The +2.0 enabledMax increase means existing setups without HTF backing will score ~2-5% lower in percentage terms. This makes HTF-backed setups relatively stronger (which is the goal). If you find the threshold is too aggressive, we can lower the max weight from 2.0 to 1.5.

## Suggested PR title and description
**Title:** feat: HTF POI detection — boost confluence when entry is inside 4H/1H institutional zones

**Description:**
Adds a new Tier 2 scoring factor "HTF POI Alignment" that detects FVGs, Order Blocks, and Breaker Blocks on the 4H and 1H timeframes, then boosts the confluence score when the entry price is inside one of these higher-timeframe institutional zones.

Key changes:
- Runs `detectFVGs`, `detectOrderBlocks`, `detectBreakerBlocks` on 4H and 1H candles during each scan cycle
- Scores 4H zones higher than 1H (institutional significance hierarchy)
- Scores FVGs > OBs > Breakers (zone type hierarchy)
- Applies alignment multiplier (×1.2 aligned, ×0.5 counter, ×1.0 neutral)
- Caps total HTF POI boost at 2.0 points
- Injects HTF POI layers into confluence stacking display
- 9 new tests, all 258 tests passing
