# Task: Fix OB Detection in Impulse Zone Engine

## Branch: manus/fix-ob-detection

## Behavior changes

1. **`mapImpulsePOIs()` now runs OB detection on the FULL candle set (same as Tier 1).** Previously, OB detection ran on a narrow impulse slice (+ 10-bar lookback). This caused three problems:
   - The `OB_RECENCY` window (default 50) applied to a smaller array, so `recencyStart` was different from Tier 1's, causing different OBs to be detected
   - Structure breaks computed on the narrow slice differed from the full-candle structure, changing which engulfing patterns qualified as OBs
   - Lifecycle tracking falsely marked OBs as broken/mitigated by the impulse candles themselves
   The fix runs `detectOrderBlocks()` on the full `candles` array with full structure breaks, then filters results to only keep OBs whose price overlaps the impulse range. This guarantees the impulse zone engine sees the exact same OBs that Tier 1 detects.

2. **`refineLowerTF()` now detects OBs using the full 15m `entryCandles` set.** Same root cause — narrow slice → different detection results. The fix runs on the full array and keeps the existing zone-boundary filter.

3. **FVG detection is unchanged in both functions.** FVGs are purely geometric (3-candle gap) and have no lifecycle tracking, so they remain on the original slice.

4. **Net effect on live trading:** More OBs will be detected within impulse zones, leading to more zones qualifying for LTF refinement and potentially higher zone scores. The impulse zone engine will now find OBs that Tier 1 already detects, eliminating the inconsistency where Tier 1 shows "Price inside bullish OB" but the impulse zone shows only FVG. The impulse zone feature is gated by `impulseZoneEnabled` (default `false`), so this only affects accounts that have explicitly enabled it.

## Files modified

- `supabase/functions/_shared/impulseZoneEngine.ts` — Fixed `mapImpulsePOIs()` to run OB detection on full candle set with full structure breaks instead of narrow impulse slice. Fixed `refineLowerTF()` to run OB detection on full entryCandles set. FVG detection unchanged.
- `supabase/functions/_shared/impulseZoneEngine.test.ts` — Added 2 regression tests proving OBs are now detected. Updated 1 existing assertion to account for full-candle indexing.

## Tests added

1. **`mapImpulsePOIs -- regression: detects OB that sits before impulse start`** — Constructs a scenario with a bearish candle at index 5 (the OB), indecision candles at 6-7, and a bullish impulse starting at index 8. Asserts that at least one bullish OB POI is returned. Before the fix, this returned 0 OBs.

2. **`mapImpulsePOIs -- regression: OBs are not falsely broken by impulse candles`** — Constructs a bearish impulse scenario where a bullish candle at index 4 is the OB. Asserts that the OB is not falsely marked as "broken" or "mitigated" by the impulse candles' lifecycle tracking.

## Tests run

```
$ deno test --allow-all --no-check --ignore=src/
ok | 459 passed | 0 failed (8s)
```

Impulse zone engine tests specifically:
```
$ deno test supabase/functions/_shared/impulseZoneEngine.test.ts --allow-all
ok | 34 passed | 0 failed (23ms)
```

Type-check:
```
$ deno check supabase/functions/_shared/impulseZoneEngine.ts
Check supabase/functions/_shared/impulseZoneEngine.ts  (no errors)
```

## Regression check

- The two new regression tests directly prove the fix works: they construct scenarios where the OB sits before the impulse start and assert detection succeeds.
- All 32 pre-existing impulse zone engine tests continue to pass, confirming no regression in FVG detection, Fib scoring, S/R checking, LTF refinement, or zone ranking.
- All 459 Deno tests pass (same count as before + 2 new).
- `smcAnalysis.ts` was NOT modified (rule 2 compliance).

## Open questions

None.

## Suggested PR title and description

**Title:** `fix: Run OB detection on full candle set so impulse zone finds same OBs as Tier 1`

**Description:**
Fixes a bug where the impulse zone engine missed Order Blocks that Tier 1 detected correctly.

**Root cause:** `mapImpulsePOIs()` ran `detectOrderBlocks()` on a narrow impulse slice (~20-80 candles) while Tier 1 ran it on the full candle set (~120 candles). This caused three problems:
1. Different `OB_RECENCY` window → different OBs detected
2. Different structure breaks on the narrow slice → different engulfing patterns qualified
3. Lifecycle tracking falsely marked OBs as broken/mitigated by impulse candles

**Fix:**
- `mapImpulsePOIs()`: Run OB detection on the full `candles` array with full structure breaks, then filter results by impulse price range and direction
- `refineLowerTF()`: Run OB detection on full `entryCandles` array, then filter by zone boundaries
- FVG detection unchanged (purely geometric, no lifecycle issue)

**Testing:** 2 new regression tests + all 459 existing tests pass.
