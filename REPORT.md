# Task: Unlock Pending Order Confirmation Paths

## Branch: manus/unlock-pending-confirmations

## Behavior changes

1. **`isPriceInZone` is now directional** — For LONG setups, price rising ABOVE the zone no longer resets the order to pending (this is the confirmation direction). Only price dropping BELOW the zone (wrong direction) invalidates. Vice versa for SHORT. Previously, price leaving the zone in ANY direction caused a reset, creating a catch-22 where the confirmation (CHoCH breakout) itself killed the order.

2. **Tier gate relaxed from "Tier 1 only" to "Tier 1 or 2"** — When no refined zone is available, Tier 2 confirmations (wick-based CHoCH with supporting signal like engulfing, rejection wick, FVG, or volume spike) are now accepted. Only Tier 3 (reversal pattern without any CHoCH) is still blocked without a refined zone. Previously, only close-based CHoCH (Tier 1) was accepted.

3. **Standalone signals can now place pending orders** — The block that prevented standalone signals (those without pre-existing unified zone confirmation) from placing pending orders has been removed. The pending order path already requires CHoCH/confirmation at fill time, so blocking placement was redundant and defeated the purpose of the pending order system.

4. **LTF CHoCH (1m) now available during confirmation** — The pending order confirmation path now fetches 1m candles and passes them to `evaluateConfirmation`, enabling Level 2 (LTF CHoCH) detection. Previously, `ltfCandles` was never passed, making this path unreachable.

5. **Sweep + CHoCH (highest conviction) now available during confirmation** — Sweep data from `signal_reason` (stored at order placement time) is now extracted and passed to `evaluateConfirmation`, enabling Level 1 (Sweep + CHoCH) detection. Previously, `sweepEvent` was never passed.

**Net effect:** Pending orders that previously could NEVER fill (0 trades from 100+ setups) will now be able to fill when valid confirmation occurs. All 6 entry-ready confirmation methods are now reachable instead of just 1.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/zoneConfirmation.ts` | Made `isPriceInZone` directional (only invalidate on wrong-direction exit). Added `ltfCandles` and `sweepEvent` params to `detectZoneConfirmation` and passes them to `evaluateConfirmation`. |
| `supabase/functions/bot-scanner/index.ts` | (1) Relaxed Tier gate from `tier !== 1` to `tier === 3`. (2) Removed standalone pending order block. (3) Added 1m candle fetch and sweep data extraction in Branch B confirmation path. |
| `supabase/functions/zone-confirmation-scanner/index.ts` | Same 3 fixes as bot-scanner: relaxed Tier gate, added 1m candle fetch, added sweep data extraction. |
| `supabase/functions/_shared/zoneConfirmation.test.ts` | Updated existing tests to match new directional logic. Added 7 new directional isPriceInZone tests. |

## Tests added

| Test | Assertion |
|------|-----------|
| `isPriceInZone directional: LONG — price below zone = invalidation (wrong direction)` | Price below zoneLow - buffer returns false for LONG |
| `isPriceInZone directional: LONG — price above zone = valid (confirmation direction)` | Price above zone returns true for LONG |
| `isPriceInZone directional: SHORT — price above zone = invalidation (wrong direction)` | Price above zoneHigh + buffer returns false for SHORT |
| `isPriceInZone directional: SHORT — price below zone = valid (confirmation direction)` | Price below zone returns true for SHORT |
| `isPriceInZone directional: LONG — price within buffer below zone = still valid` | Minor wick below zone stays valid |
| `isPriceInZone directional: SHORT — price within buffer above zone = still valid` | Minor wick above zone stays valid |
| `isPriceInZone directional: ATR-based buffer works correctly for LONG` | ATR-based buffer correctly bounds invalidation |

## Tests run

```
$ deno test supabase/functions/_shared/zoneConfirmation.test.ts --allow-all --no-check
ok | 48 passed | 0 failed (18ms)

$ deno test supabase/functions/_shared/confirmationHierarchy.test.ts --allow-all --no-check
ok | 8 passed | 0 failed (13ms)

$ deno test supabase/functions/_shared/ --allow-all --no-check
FAILED | 1371 passed | 6 failed (14s)
(All 6 failures are pre-existing on main branch — unrelated to this change)
```

## Regression check

- Ran full test suite on `main` branch: 1364 passed, 6 failed
- Ran full test suite on this branch: 1371 passed, 6 failed (7 new tests added, all passing)
- Same 6 pre-existing failures in both (BE trailing tests + findImpulseLeg)
- `confirmationHierarchy.test.ts`: 8/8 pass (no regression in confirmation logic)
- `zoneConfirmation.test.ts`: 48/48 pass (all directional behavior verified)
- The `isPriceInZone` change is **intentionally behavior-changing** — it fixes the catch-22 that prevented all pending orders from filling

## Open questions

1. **Zone-confirmation-scanner deployment** — Is this function currently deployed to Supabase? If not, the 1-minute confirmation checks won't run regardless of code fixes. Need to verify with `supabase functions list`.

2. **ATR availability** — The `isPriceInZone` function now accepts an optional `atr` parameter for adaptive buffer sizing. Currently no callers pass it. Should we add ATR fetching to the confirmation path for more intelligent zone bounds?

3. **Tier 3 without refined zone** — Currently still blocked. Should we allow Tier 3 (reversal pattern: engulfing + rejection wick + displacement, no CHoCH) when other confluence factors are present (high fib depth, S/R alignment)?

## Suggested PR title and description

**Title:** fix: unlock pending order confirmation paths (directional zone exit + tier gate + LTF/sweep data)

**Description:**
Fixes the root cause of 100+ zone setups never triggering a trade. Four compounding bugs made it nearly impossible for pending orders to fill:

1. `isPriceInZone` reset the order when price left in the confirmation direction (the CHoCH breakout itself killed the order)
2. Tier gate blocked Tier 2 (wick CHoCH + support) without refined zone
3. Standalone signals were blocked from placing pending orders
4. LTF candles and sweep data were never passed to the confirmation engine

This PR fixes all four, unlocking all 6 entry-ready confirmation methods (Sweep+CHoCH, LTF CHoCH, Same-TF CHoCH, Displacement, Wick CHoCH+support, Reversal pattern) instead of just 1.

**BEHAVIOR CHANGE:** Pending orders will now fill when valid confirmation occurs. Previously 0% fill rate → expected normal fill rate.
