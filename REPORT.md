# Task: Fix BTC Pips Calculation Bug
## Branch: manus/fix-btc-pips-calculation
## Behavior changes
1. BTC/USD "pips away" display now shows correct values (~22,000 instead of 78,006,400)
2. BTC/USD impulse range display now shows correct pips (~18,942 instead of 1,894,245)
3. XAU/USD pips display now uses correct pip size (0.01) instead of heuristic
4. All forex pairs unchanged (default pipSize=0.0001 matches old hardcoded *10000)

## Files modified
- `supabase/functions/_shared/impulseZoneEngine.ts` — Added `pipSize` to `ZoneEngineOptions`, replaced `distanceToZone * 10000` with `distanceToZone / pipSize`
- `supabase/functions/_shared/unifiedZoneEngine.ts` — Replaced heuristic `pipMultiplier = currentPrice > 50 ? 100 : 10000` with `1 / pipSize` from options; renamed param in `buildEntryStory`
- `supabase/functions/bot-scanner/index.ts` — Pass `pipSize: SPECS[pair].pipSize` in options to `findUnifiedZone`
- `supabase/functions/_shared/impulseZoneEngine.test.ts` — Added 2 regression tests

## Tests added
- `findBestEntryZone — pipSize option correctly scales distancePips for BTC (pipSize=1)` — proves BTC pips are 10000x smaller with pipSize=1 vs default
- `findBestEntryZone — pipSize option correctly scales distancePips for XAU (pipSize=0.01)` — proves gold pips are 100x smaller with pipSize=0.01 vs default

## Tests run
```
ok | 1415 passed | 0 failed (20s)
```

## Regression check
- Default pipSize (0.0001) produces identical results to old `* 10000` formula: `distance / 0.0001 === distance * 10000`
- All 45 existing impulseZoneEngine tests pass (they don't pass pipSize, so use default)
- All 8 unifiedZoneEngine tests pass
- All 3 zoneConsolidation tests pass

## Open questions
None.

## Suggested PR title and description
**Title:** Fix BTC/XAU pips calculation — use instrument pipSize instead of hardcoded multiplier

**Description:**
The zone engine hardcoded `distanceToZone * 10000` for pip conversion, which is correct for forex (pipSize=0.0001) but wildly wrong for BTC (pipSize=1, showed 78M pips instead of 22K) and inaccurate for gold (pipSize=0.01, used heuristic `*100` which was close but not exact).

Fix: Add `pipSize` to `ZoneEngineOptions`, pass it from `SPECS[pair].pipSize` in bot-scanner, and use `distance / pipSize` everywhere. Default remains 0.0001 for backward compatibility.
