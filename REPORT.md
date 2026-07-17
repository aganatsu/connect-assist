# Task: Verdict-First Zone Direction

## Branch: manus/verdict-first-zone-direction

## Behavior changes

1. **Zone engine now searches in the direction determined by `computeDirectionVerdict` (HTF consensus) instead of `analysis.direction` (15m scoring).** When the verdict disagrees with the 15m direction, the zone engine will find impulses aligned with the HTF trend instead of the 15m structure. This means pairs where the 15m shows a counter-trend pullback will no longer produce zones in the wrong direction.

2. **Cascade zone engine (swing_trader) also uses the verdict direction.** Previously it used `analysis.direction`; now it uses `effectiveDirection` from the verdict.

3. **htfConfluenceData.direction aligns with the verdict.** OB/FVG filtering in the zone engine now matches the authoritative direction.

4. **ICT HTF analysis also uses effectiveDirection.** Previously it scored alignment between 15m direction and weekly structure. Now it scores alignment between the verdict direction and weekly structure — so it won't penalize trades that are actually trend-aligned.

5. **Direction source indicator added to detail.** New fields `detail.directionSource` and `detail.directionVerdict.directionSource` (values: `"verdict"` or `"15m_fallback"`) plus `detail.directionVerdict.effectiveDirection` — frontend can now show which system drove zone selection.

6. **Fallback behavior preserved:** When the verdict is neutral, blocked (`shouldBlock=true`), or unavailable (null), the system falls back to `analysis.direction` — identical to old behavior.

7. **`analysis.direction` synced to verdict direction for ALL downstream code.** After `effectiveDirection` is computed, `analysis.direction` is overwritten to match. This ensures SL/TP computation, pending order placement, market order execution, broker calls, correlation checks, staging, and all other downstream code uses the authoritative direction — not the 15m scoring direction. Safety: SL recomputation at line 5723 uses the synced direction; impulse/unified zone SL overrides provide additional coverage; SL sanity check at line 6315 catches any remaining wrong-side SL as a final safety net.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Moved `computeDirectionVerdict()` block from line ~4855 to line ~4340 (before `findUnifiedZone`). Added early `weeklyBiasResult` computation using `analyzeWeeklyBiasAndDOL`. Introduced `effectiveDirection` variable that prioritizes verdict over 15m direction. Updated `htfConfluenceData.direction`, `findUnifiedZone` direction arg, cascade zone engine direction, ICT HTF analysis direction, and the no-zone fallback message to all use `effectiveDirection`. Added `directionSource` and `effectiveDirection` fields to detail for frontend display. Added import for `analyzeWeeklyBiasAndDOL`. **Added direction sync: `analysis.direction = effectiveDirection` after verdict computation — ensures all downstream trade mechanics (SL/TP, orders, broker) use the verdict direction.** |
| `supabase/functions/_shared/verdictFirstZoneDirection.test.ts` | NEW: 17 tests covering effectiveDirection logic, direction mapping, mismatch scenarios, HTF alignment, and regression cases. |
| `supabase/functions/_shared/styleTuningPort.test.ts` | Updated test assertion to expect `effectiveDirection` instead of `analysis.direction` in the cascade zone engine condition. |
| `REPORT.md` | This file |

## Tests added

| Test | Assertion |
|------|-----------|
| verdict=short overrides analysis.direction=long | effectiveDirection = "short" |
| verdict=long overrides analysis.direction=short | effectiveDirection = "long" |
| verdict agrees with analysis — no conflict | effectiveDirection matches both |
| verdict=neutral falls back to analysis.direction | effectiveDirection = analysis.direction |
| verdict shouldBlock=true falls back | effectiveDirection = analysis.direction |
| no verdict (null) falls back | effectiveDirection = analysis.direction |
| no verdict AND no analysis → null | effectiveDirection = null |
| direction mapping: long → bullish | zone engine gets "bullish" |
| direction mapping: short → bearish | zone engine gets "bearish" |
| direction mapping: null → null | zone engine skipped |
| scenario: 15m long, verdict short → bearish | Zone searches bearish (the fix) |
| scenario: 15m short, verdict long → bullish | Zone searches bullish |
| scenario: verdict neutral, 15m long → bullish | Fallback works |
| htfConfluence aligns (short→bearish) | HTF filter correct |
| htfConfluence aligns (long→bullish) | HTF filter correct |
| regression: verdict agrees → unchanged | Old and new behavior identical |
| regression: no verdict → unchanged | Falls back exactly like old code |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/verdictFirstZoneDirection.test.ts
ok | 17 passed | 0 failed (11ms)

$ deno test --no-check --allow-all supabase/functions/_shared/
ok | 1364 passed | 6 failed (16s)
```

6 failures are pre-existing (beTrailingRace.test.ts:307, brokerFillPriceBE.test.ts:88/138/175/265/302) — confirmed present on main before this branch.

## Regression check

- When `directionVerdict.verdict` agrees with `analysis.direction` (the common case), `effectiveDirection === analysis.direction` and all downstream behavior is byte-for-byte identical.
- When no verdict is available (null), fallback to `analysis.direction` preserves exact old behavior.
- The only divergence is when verdict DISAGREES with 15m — this is the intentional fix (trend-aligned zone selection).
- Verified via regression tests that assert old === new when sources agree.
- styleTuningPort.test.ts updated and passing (was failing before update because it checked for `analysis.direction` string in source).

## Open questions

None — all resolved during implementation.

## Suggested PR title and description

**Title:** fix: use direction verdict (HTF consensus) for zone engine instead of 15m scoring

**Description:**
The zone engine (`findUnifiedZone`) was using `analysis.direction` from the 15m scoring engine to decide which direction to search for impulses. This caused a mismatch: the 15m might show a counter-trend pullback (e.g., "long") while the authoritative direction verdict (Daily trend + H4 CHoCH + weekly bias + regime) says "short."

Result: the zone engine would find bullish impulses when the trend is bearish — producing zones that trade against the main trend.

Fix: Move `computeDirectionVerdict()` above `findUnifiedZone()` and feed the verdict direction into the zone engine. Falls back to 15m direction when verdict is neutral/blocked/unavailable.

This ensures "trend is your friend" — impulse zones are always aligned with the HTF consensus direction.
