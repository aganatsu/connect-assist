# Task: Structure-Based Trailing + Confluence Fib Fix

## Branch: manus/structure-trailing

## Behavior changes

1. **Day trader and swing trader styles** now trail SL to the most recent confirmed swing point (highest swing low for longs, lowest swing high for shorts) instead of a fixed pip distance behind price. This means SL placement respects market structure rather than being mechanical.
2. **Scalper style** remains unchanged — uses proportional (fixed-pip) trailing as before.
3. **Proportional fallback** — if no valid swing point is found (e.g., candle fetch fails, no swings above current SL), the system falls back to the existing proportional trailing behavior. This ensures SL always trails forward.
4. **Confluence stacking display** now reports at most ONE Fib level per zone (the closest to zone center), instead of inflating layer counts by counting all Fib levels that happen to overlap a wide zone. This is display-only — does NOT affect trade entry, exit, or scoring gates.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added `trailingStopMode` to DEFAULTS ("proportional"), day_trader STYLE_OVERRIDES ("structure"), swing_trader STYLE_OVERRIDES ("structure"), and config resolution block. Does NOT modify gate definitions or factor weights. |
| `supabase/functions/_shared/scannerManagement.ts` | **Extra caution file.** Modified Phase B trailing tightening block to support structure-based trailing. Added `trailingStopMode` config reading, per-trade override support, and the swing-point detection logic with proportional fallback. Also added `detectSwingPoints` import. |
| `supabase/functions/_shared/smcAnalysis.ts` | **Protected file — user granted permission.** Fixed confluence stacking Fib loop to only count the single closest Fib level per zone instead of all overlapping Fib levels. |
| `supabase/functions/_shared/structureTrailing.test.ts` | New test file — 8 tests for structure-based trailing. |
| `supabase/functions/_shared/confluenceFibCount.test.ts` | New test file — 4 tests for confluence Fib over-counting fix. |

## Changes to scannerManagement.ts (extra caution file)

The Phase B trailing block (previously lines 546-584) was replaced with a structure-aware version. The logic flow is:

1. If `posTrailingMode === "structure"`: fetch candles on the position's entry timeframe, run `detectSwingPoints` with ATR filter (0.3), find valid swing points (above SL and below price for longs, below SL and above price for shorts), pick the most protective one, subtract/add `slBufferPips` buffer.
2. If no valid swing found OR mode is "proportional": compute the proportional trail level (same as before).
3. Apply the trail only if it tightens (never widens) — same safety check as before.
4. Attribution includes `[structure]` or `[proportional]` tag for traceability.

The change adds one API call per management cycle per position (candle fetch) when in structure mode. This is the same pattern already used by the structure invalidation feature.

## Changes to smcAnalysis.ts (protected file — user granted permission)

The `computeConfluenceStacking` function's Fib loop (Layer 3) was changed from:
- **Before**: Loop through all 5 Fib ratios, add each one that overlaps the zone → could produce 3-5 Fib layers per zone
- **After**: Loop through all 5 Fib ratios, track the one closest to zone center, add only that single best match → at most 1 Fib layer per zone

This fixes the misleading display where a zone would show "FVG + Fib 38.2% + Fib 50% + Fib 61.8%" (inflated 5-layer count) when in reality only one Fib level genuinely aligns with the zone.

## Tests added

### structureTrailing.test.ts (8 tests)
1. `trailingStopMode=proportional → uses fixed-pip trailing` — verifies default behavior unchanged
2. `trailingStopMode=structure (long) → trails to highest valid swing low` — core long logic
3. `trailingStopMode=structure (short) → trails to lowest valid swing high` — core short logic
4. `trailingStopMode=structure → falls back when no valid swing found` — flat market handling
5. `trailingStopMode=structure → falls back when candle fetch fails` — network error resilience
6. `trailingStopMode=structure → never widens SL` — safety check
7. `trailingStopMode missing from config → defaults to proportional` — backward compatibility
8. `trailingStopMode=structure respects slBufferPips` — buffer verification

### confluenceFibCount.test.ts (4 tests)
1. `at most ONE Fib layer per zone` — the core fix assertion
2. `picks the closest Fib to zone center` — verifies selection logic
3. `zone with no Fib overlap still produces valid stack` — no false positives
4. `fibLevels array in result has at most 1 entry per stack` — user-facing field check

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 124 passed | 0 failed (5s)
```

All 124 tests pass (112 existing + 8 new trailing + 4 new confluence).

## Regression check

1. **Proportional trailing unchanged**: Test #1 explicitly verifies that `trailingStopMode=proportional` produces identical SL movement (currentPrice - trailingPips × pipSize) as the old code.
2. **Default mode is proportional**: Test #7 verifies that omitting `trailingStopMode` from config defaults to proportional — existing users with no config change see zero behavior difference.
3. **Existing test suite**: All 112 pre-existing tests (unicorn scoring, FVG qualification, SL floor, structure invalidation, cross-engine equivalence, candle source, calcPnl) continue to pass.
4. **Confluence scoring tests**: The existing `confluenceScoring.test.ts` tests still pass, confirming the Fib fix doesn't break scoring.

## Open questions

1. **Management frequency**: Structure trailing fetches candles each cycle. For positions on 15m timeframe, running management every 1 minute means most cycles will see the same candles. Consider adding a "last structure trail check" timestamp to skip redundant fetches. Not critical for correctness but would reduce API calls.
2. **FVG layer (future)**: The design supports adding FVG-based trailing later. When ready, it would slot in between the swing check and the proportional fallback.

## Suggested PR title and description

**Title:** `feat: structure-based SL trailing + fix confluence Fib over-counting`

**Description:**
Adds a new `trailingStopMode` config option (`"proportional"` | `"structure"`). When set to `"structure"` (default for day_trader and swing_trader styles), trailing SL moves to confirmed swing points instead of a fixed pip distance behind price. Falls back to proportional if no valid swing is found.

Also fixes confluence stacking to only count the single closest Fib level per zone, preventing inflated layer counts when multiple Fib levels overlap a wide zone.

- 12 new tests, all 124 tests passing
- No behavior change for scalpers or users without explicit config
- Proportional fallback ensures SL always trails forward
