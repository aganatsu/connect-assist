# Task: Impulse Zone Engine
## Branch: manus/impulse-zone-engine
## Behavior changes
none — pure addition (informational data only, no gate, no trade blocking)

The impulse zone engine attaches zone analysis data to the scan detail object under `detail.impulseZone`. This data is available for dashboard display but does NOT influence trade decisions, scoring, or gate evaluation. No existing trades, scores, or gates are affected.

## Files modified
| File | Description |
|------|-------------|
| `supabase/functions/_shared/impulseZoneEngine.ts` | NEW — Full impulse zone engine module (findImpulseLeg, mapImpulsePOIs, overlayFibOnPOIs, checkHistoricalSR, refineLowerTF, rankAndSelectBestZone, findBestEntryZone) |
| `supabase/functions/_shared/impulseZoneEngine.test.ts` | NEW — 24 unit tests covering all functions |
| `supabase/functions/bot-scanner/index.ts` | Added import + ~40 lines of informational zone engine call between detail object construction and staging logic |
| `REPORT.md` | This file |

## bot-scanner/index.ts change explanation
**What changed:** Added an import for `findBestEntryZone` and `ZoneEngineResult` from the new module. After the `detail` object is constructed (line ~3435) and before the staging logic begins, a new block runs the zone engine on 1H candles and attaches results to `detail.impulseZone`. The entire block is wrapped in try/catch — any error is logged and a fallback `{ hasZone: false }` is attached. This is purely informational and does not affect any trade decisions.

**Why:** This provides the foundation for the user's ICT/SMC top-down zone detection workflow. The data flows to the dashboard for visual validation. Once validated in production, a future task can promote it to a soft/hard gate.

## Tests added
| Test | Assertion |
|------|-----------|
| `findImpulseLeg — returns null for insufficient candles` | Returns null for < 20 candles |
| `findImpulseLeg — detects valid bullish impulse` | Finds impulse with isValid=true, direction=bullish |
| `findImpulseLeg — detects valid bearish impulse` | Finds impulse with isValid=true, direction=bearish |
| `findImpulseLeg — rejects impulse with >50% pullback` | Does not return an impulse spanning the invalid pullback |
| `findImpulseLeg — returns null for wrong direction` | No bullish impulse in bearish data (or vice versa) |
| `mapImpulsePOIs — returns empty for invalid impulse` | isValid=false → no POIs |
| `mapImpulsePOIs — finds POIs within valid impulse` | POIs are within impulse price range and index range |
| `overlayFibOnPOIs — returns empty for empty POIs` | No input → no output |
| `overlayFibOnPOIs — scores POIs by Fib depth correctly` | Deeper POIs get higher scores, sorted by depth |
| `overlayFibOnPOIs — filters POIs outside OTE zone` | Shallow POIs (20% retracement) are filtered out |
| `overlayFibOnPOIs — bearish impulse Fib scoring` | Bearish direction Fib calculation is correct |
| `checkHistoricalSR — confirms S/R when closes cluster at zone` | srConfirmed=true, totalScore incremented |
| `checkHistoricalSR — does not confirm when no S/R at zone` | srConfirmed=false when S/R is far from zone |
| `checkHistoricalSR — handles short lookback gracefully` | No crash with minimal data |
| `refineLowerTF — returns unchanged zone when not enough LTF candles` | Empty candles → zone unchanged |
| `refineLowerTF — refines zone when LTF structure exists inside` | ltfRefined=true with entry/SL when structure found |
| `rankAndSelectBestZone — returns null for empty array` | No zones → null |
| `rankAndSelectBestZone — selects highest-scoring zone` | Picks zone with totalScore=6 |
| `rankAndSelectBestZone — rejects zones with fibScore < 1` | Too-shallow zones rejected |
| `rankAndSelectBestZone — uses fibDepth as tiebreaker` | Equal scores → deeper zone wins |
| `findBestEntryZone — returns reason when no impulse found` | Flat data → null + explanation |
| `findBestEntryZone — full pipeline with bullish impulse` | End-to-end bullish pipeline |
| `findBestEntryZone — full pipeline with bearish impulse` | End-to-end bearish pipeline |
| `findBestEntryZone — priceAtZone detection` | priceAtZone is boolean, distanceToZone is number |

## Tests run
```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 276 passed | 0 failed (7s)
```
(Pre-existing type errors in tpNextLevelSkip.test.ts and gamePlan.ts are unrelated — confirmed by running `deno check` on main before our changes. All runtime tests pass.)

## Regression check
- Ran full test suite (276 tests) — all pass
- The zone engine is **informational only** — it does NOT gate trades, does NOT modify scores, does NOT change any existing behavior
- Wrapped in try/catch with graceful fallback — even if the engine throws, the scan continues unaffected
- Verified pre-existing type errors exist on main (not introduced by this branch)

## Open questions
1. **Promotion to gate:** When ready to use this as a trade filter, should it be a hard gate (blocks trades without a valid zone) or a soft penalty (score reduction when no zone found)?
2. **Dashboard display:** The `detail.impulseZone` data is ready for frontend consumption. Want me to add a dashboard widget in a follow-up task?
3. **4H vs 1H:** Currently runs on 1H candles. Should it also run on 4H when available and pick the better result?

## Suggested PR title and description
**Title:** `feat: Impulse Zone Engine — ICT top-down zone detection (informational)`

**Description:**
Adds a new `impulseZoneEngine.ts` module that implements the full ICT/SMC top-down zone detection pipeline:

1. **findImpulseLeg** — Detects the most recent structure-breaking impulse with 50% pullback validation
2. **mapImpulsePOIs** — Extracts FVGs and OBs created within the impulse
3. **overlayFibOnPOIs** — Scores zones by Fibonacci depth (OTE zone prioritized)
4. **checkHistoricalSR** — Validates zones against close-only historical S/R clusters
5. **refineLowerTF** — Drops to 15m to find precise OB/FVG inside the best zone
6. **rankAndSelectBestZone** — Final ranking (max score: 6/6)

Integration: Runs after confluence scoring in bot-scanner, attaches results to scan detail as `impulseZone`. Purely informational — does not gate or modify trades. Wrapped in try/catch for safety.

24 new unit tests. All 276 tests pass.
