# Task: Fix Liquidity Detection (Equal Highs/Lows)

## Branch: manus/fix-liquidity-detection

## Behavior changes

1. **Liquidity pools are now detected using ATR-based tolerance** instead of `priceRange × 0.001`. On a typical 1H forex chart (ATR ~15 pips), the tolerance is now ~3 pips instead of ~0.16 pips. This means the system will detect equal highs/lows that were previously invisible.

2. **Only swing points are compared**, not every candle's high/low. This eliminates false positives from random candle wicks and focuses on structurally significant levels (local maxima/minima).

3. **Break-through validation added**: If price CLOSED above/below the pool level between the first and last touch, the pool is rejected. This prevents stale/invalidated levels from being reported.

4. **Confluence scoring will now fire the "Liquidity Sweep" factor more often**, because pools are actually detected. Previously this factor was almost always `present: false` due to the tight tolerance. Snapshot tests show scores increasing by ~1.0–4.3 points on fixtures where liquidity sweeps are present.

5. **`equalHighsLowsSensitivity` config is now wired** (was dead code before). Maps 1–5 scale to ATR multiplier:
   - 1 = tight (0.10×ATR) — only very precise equal levels
   - 2 = moderate (0.15×ATR)
   - 3 = balanced (0.20×ATR) — **default, industry standard**
   - 4 = loose (0.25×ATR)
   - 5 = wide (0.30×ATR) — catches more levels, may include near-misses

6. **Per-timeframe tolerance is now config-driven** with automatic TF bumps:
   - Daily: `base + 0.10` (capped at 0.40)
   - 4H: `base + 0.05` (capped at 0.35)
   - 1H / Entry TF: `base` (no bump)

## Files modified

| File | Change |
|------|--------|
| `supabase/functions/_shared/smcAnalysis.ts` | Rewrote `detectLiquidityPools()`: ATR-based tolerance, swing point filtering, break-through validation, average-price clustering |
| `supabase/functions/_shared/confluenceScoring.ts` | Now reads `config.equalHighsLowsSensitivity` to derive tolerance (was hardcoded 0.20) |
| `supabase/functions/bot-scanner/index.ts` | Added `equalHighsLowsSensitivity` to config mapping; 3 HTF callers now use sensitivity-driven tolerance with per-TF bumps; passes sensitivity to gamePlan |
| `supabase/functions/_shared/gamePlan.ts` | Extended options interface to accept `equalHighsLowsSensitivity` and `liquidityPoolMinTouches`; uses them for daily liquidity detection |
| `supabase/functions/smc-analysis/index.ts` | Added comments; callers use default (0.20) which is correct for standalone analysis |
| `supabase/functions/bot-config/index.ts` | No change needed — `equalHighsLowsSensitivity: 3` already in defaults (now actually used) |
| `supabase/functions/_shared/__snapshots__/*.json` | Regenerated 3 snapshot files (intentional drift from liquidity detection improvement) |
| `supabase/functions/_shared/liquidityDetection.test.ts` | **NEW** — 17 targeted regression tests (11 core + 6 sensitivity config) |

## Tests added

| Test | Assertion |
|------|-----------|
| `detects equal highs (BSL) with ATR-based tolerance` | Finds BSL pool near 1.3810 with strength >= 2 |
| `detects equal lows (SSL) with ATR-based tolerance` | Finds SSL pool near 1.3740 with strength >= 2 |
| `old algorithm would have missed these pools (regression proof)` | Proves old tolerance (0.14 pips) < new tolerance (3+ pips), and new algo finds >= 2 pools |
| `rejects pools where price closed through between touches` | Pool at ~1.1050 NOT detected because price closed above between touches |
| `detects sweep-rejection lifecycle correctly` | Pool marked swept=true, rejectionConfirmed=true, state="swept_rejected" |
| `returns empty for insufficient candles` | < 10 candles → empty array |
| `respects minTouches parameter` | minTouches=5 finds fewer pools than minTouches=2 |
| `tolerance scales with ATR (volatile vs calm)` | Both volatile and calm pairs detect pools (tolerance adapts) |
| `output shape matches LiquidityPool interface` | All required fields present with correct types |
| `sorted by strength descending` | Output ordering verified |
| `configurable tolerance per timeframe` | Looser tolerance (0.40) finds >= tight tolerance (0.10) pools |
| `sensitivity 1-5 maps to correct ATR multipliers` | Mapping array produces expected values |
| `out-of-range values are clamped` | Values <1 clamp to 0.10, >5 clamp to 0.30 |
| `per-TF bumps produce correct hierarchy` | Daily > 4H > 1H tolerance hierarchy verified |
| `max sensitivity with daily bump caps at 0.40` | Prevents runaway tolerance |
| `different sensitivities produce different pool counts` | Wide finds >= tight pools |
| `default sensitivity (3) detects pools on standard fixture` | Confirms the default works |

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 497 passed | 0 failed (9s)
```

All 497 tests pass (480 existing + 17 new liquidity/sensitivity tests).

## Regression check

1. **Snapshot tests**: The 3 confluence scoring snapshots were regenerated. The only difference is "Liquidity Sweep" factor changing from `present: false` to `present: true` in fixtures where equal highs/lows exist. This is the intended fix — the factor was previously always false because detection was broken.

2. **Score impact**: Scores increase by ~1.0–4.3 points (out of 23.5 max) when liquidity sweep is now correctly detected. This means some setups that previously scored below threshold may now pass. This is correct behavior — the system was under-scoring valid setups.

3. **No false positives**: The break-through validation ensures that invalidated levels (where price already closed through) are NOT reported. The swing-point filtering ensures random wick noise doesn't create phantom pools.

4. **Interface compatibility**: Output shape is identical (`LiquidityPool` interface unchanged). All downstream consumers (TP calculation, DOL targeting, chart overlays, scoring) work without modification.

## Open questions

1. **UI label for sensitivity**: The config field is `equalHighsLowsSensitivity` with values 1–5. Should the UI show a slider labeled "Liquidity Detection Sensitivity" with labels like "Tight / Moderate / Balanced / Loose / Wide"?

2. **Per-TF bump constants**: The bumps (+0.10 for daily, +0.05 for 4H) are hardcoded. Should these also be configurable, or is the current hierarchy sufficient?

## Suggested PR title and description

**Title:** fix(liquidity): ATR-based tolerance + swing point filtering + config-driven sensitivity

**Description:**
The liquidity pool detection (`detectLiquidityPools`) was using `priceRange × 0.001` as tolerance, which produced ~0.16 pips on a typical 1H chart — far too tight to detect real equal highs/lows. This PR changes to the industry-standard approach:

- **ATR × tolerance factor** (default 0.20 = 20% of ATR, ~3 pips on 1H forex)
- **Swing point filtering** — only compares local maxima/minima, not every candle
- **Break-through validation** — rejects pools where price already closed through between touches
- **Config-driven sensitivity** — `equalHighsLowsSensitivity` (1–5) now controls the ATR multiplier (was dead code)
- **Per-timeframe scaling** — automatic bumps for higher TFs (Daily +0.10, 4H +0.05)

This is a behavior change: the "Liquidity Sweep" confluence factor will now fire correctly, and the "LIQ: none detected" display issue is resolved. Scores may increase by 1–4 points on setups with valid liquidity sweeps.

17 new regression tests added. All 497 tests pass.
