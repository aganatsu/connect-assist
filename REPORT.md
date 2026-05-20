# Task: Daily POI Detection & Chart Overlays

## Branch: manus/daily-poi-and-chart-overlays

## Behavior changes

1. **Daily POIs now feed into HTF POI scoring**: When daily candles have >= 10 bars, the scanner detects D1 FVGs, Order Blocks, and Breaker Blocks and pushes them to the `htfPOIs` array with `timeframe: "D"`. The existing BOOST_MAP already assigns the highest weights to "D" (fvg: 1.0, ob: 0.8, breaker: 0.6), so pairs where price sits inside a Daily POI will now receive a higher HTF POI Alignment score. This means some trades that previously scored just below threshold may now pass if price is at a Daily level.

2. **Daily Fib/PD/Liquidity detection added**: The scanner now computes Daily ZigZag Fibonacci levels, Premium/Discount zones, and Liquidity Pools. These are injected into `_htfFibLevels.d`, `_htfPD.d`, and `_htfLiquidityPools.d` for downstream multi-TF scoring.

3. **`chartOverlays` field added to scan detail**: The scan detail object now includes a `chartOverlays` property containing full entity price-level data (OBs, FVGs, Breakers, Swing Points, Liquidity Pools, Fib Levels, HTF POIs, Daily Entities). This is purely informational for the frontend — it does NOT affect scoring or trade decisions.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added Daily POI detection block (28 lines), Daily Fib/PD/Liquidity detection (14 lines), updated HTF Phase 2 injection to include Daily data, added `chartOverlays` field to detail object (60 lines), updated console.log to show Daily counts |
| `supabase/functions/_shared/dailyPOIAndChartOverlays.test.ts` | New test file with 12 tests covering Daily POI detection, scoring hierarchy, quality thresholds, chart overlay structure, and regression checks |

## Tests added

| Test | Assertion |
|------|-----------|
| `Daily POI: analyzeMarketStructure works on daily candles with >= 10 bars` | Structure detection produces BOS, CHoCH, and swing points from daily candles |
| `Daily POI: detectFVGs produces FVGs from daily candles` | FVGs have valid high/low/state/type fields |
| `Daily POI: detectOrderBlocks produces OBs from daily candles` | OBs have valid high/low/state/type fields |
| `Daily POI: detectBreakerBlocks produces breakers from daily OBs` | Breakers have valid structure |
| `Daily POI: 'D' timeframe POIs score higher than equivalent '4H' POIs` | D FVG weight >= 4H FVG weight |
| `Daily POI: 'D' OB scores higher than '4H' OB` | D OB weight >= 4H OB weight |
| `Daily POI: 'D' breaker scores higher than '4H' breaker` | D breaker weight >= 4H breaker weight |
| `Daily POI: FVG quality threshold >= 2 allows lower-quality FVGs` | Threshold 2 qualifies >= threshold 3 count |
| `Daily POI: no regression — adding D POIs does not change 4H/1H scoring` | Far-away D POI doesn't affect 4H scoring |
| `Chart Overlays: structure has all required top-level fields` | All 7 overlay categories present with correct field types |
| `Chart Overlays: dailyEntities contains full D1 entity data` | Daily OBs/FVGs/Breakers have numeric high/low and valid state/direction |
| `Chart Overlays: slicing limits prevent payload bloat` | Arrays capped at configured limits (30/20/40) |

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 480 passed | 0 failed (9s)
```

Note: 35 pre-existing type errors in `tpNextLevelSkip.test.ts` (missing `datetime`/`state`/`testedCount` fields on mock SwingPoints) — these are unrelated to this change and existed before.

## Regression check

1. **Scoring regression**: Test `"Daily POI: no regression — adding D POIs does not change 4H/1H scoring"` verifies that adding a far-away Daily POI does not alter the score of an existing 4H POI alignment.
2. **Existing test suite**: All 468 pre-existing tests pass unchanged.
3. **BOOST_MAP unchanged**: The `confluenceScoring.ts` BOOST_MAP already had a "D" entry — we did NOT modify it. We only feed POIs into it.
4. **Gate definitions unchanged**: No gate logic was modified. Daily POIs only affect the HTF POI Alignment factor score (Factor 23), which is a Tier 2 scoring factor, not a gate.

## Open questions

1. **Quality threshold for Daily FVGs**: Set to >= 2 (vs >= 3 for 4H/1H). This is a judgment call — daily candles produce fewer structure breaks so FVGs tend to have lower quality scores. Should this be configurable per-pair?
2. **chartOverlays payload size**: Currently capped at 30 OBs, 30 FVGs, 20 breakers, 40 swing points, 20 liquidity pools, 15 daily OBs, 15 daily FVGs, 10 daily breakers. These limits keep the JSON payload reasonable (~5-10KB) but could be adjusted.
3. **Frontend consumption**: The `chartOverlays` field is now available in scan detail but the Lovable UI (connect-assist repo) does not yet render it. Issue #46 tracks the frontend chart visualization work.
4. **Daily Fib ZigZag parameters**: Using `detectZigZagPivots(dailyCandles, 5, 20)` — wider parameters than 4H (3, 10) to capture larger daily swings. May need tuning.

## Suggested PR title and description

**Title:** feat: Add Daily POI detection and chartOverlays for UI chart plotting

**Description:**

Implements GitHub issue #45 (Daily POI detection) and prepares data for issue #46 (chart visualization).

### What this does:
- **Daily POI Detection**: Runs `analyzeMarketStructure` → `detectFVGs` / `detectOrderBlocks` / `detectBreakerBlocks` on D1 candles and feeds results into the HTF POI scoring pipeline with `timeframe: "D"`. The existing BOOST_MAP assigns highest weights to Daily (fvg: 1.0, ob: 0.8, breaker: 0.6).
- **Daily Fib/PD/Liquidity**: Adds Daily ZigZag Fibonacci, Premium/Discount, and Liquidity Pool detection alongside existing 4H/1H analysis.
- **Chart Overlays**: Adds a `chartOverlays` field to the scan detail object containing full entity price-level data for frontend chart rendering (OBs, FVGs, Breakers, Swing Points, Liquidity Pools, Fib Levels, HTF POIs, Daily Entities).

### Behavior impact:
Trades where price sits inside a Daily POI will now score higher on the HTF POI Alignment factor. This may cause some borderline pairs to pass the confluence threshold that previously didn't.

### Tests:
12 new tests added. All 480 tests pass.
