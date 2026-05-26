# Task: Strict Zone Proximity — Fix priceAtZone Chasing Bug

## Branch: manus/strict-zone-proximity

## Behavior changes

1. **Market fill at zone now requires `priceAtZoneStrict` (0.3×ATR + correct side) instead of loose `priceAtZone` (1.5×ATR).** This means market fills will only execute when price is genuinely at or very near the zone, not 44+ pips away. Trades that previously would have market-filled at a distance will now route to the pending order / CHoCH confirmation path instead.

2. **Dashboard "AT ZONE" badge now shows three states:** "AT ZONE" (price inside zone bounds), "NEAR ZONE" (within 0.3×ATR + correct side), "NEAR (LOOSE)" (within 1.5×ATR but not strict). The amber "NEAR (LOOSE)" badge also shows pip distance and "(wrong side)" when applicable.

3. **Telegram "Market Fill at Zone" message now shows distance from zone edge** when price is not literally inside the zone (e.g., "Zone: [1.08500-1.08600] (5.2p from edge)").

4. **New log line** when loose priceAtZone fires but strict doesn't — helps audit which trades would have been bad fills under the old logic.

## Real-world trigger

EUR/AUD LONG filled at 1.62166 when the demand zone was 1.61607–1.61719. That's 44.7 pips ABOVE the zone — the bot was chasing. The `priceAtZone` flag was `true` because 1.5×ATR (~45p on EUR/AUD) barely covered the distance. The trade should have gone to the pending order / CHoCH path, not market-filled.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/impulseZoneEngine.ts` | Added `PRICE_AT_ZONE_STRICT_ATR_MULT = 0.3`, new fields on BestZone interface (`priceInsideZone`, `priceAtZoneStrict`, `sideOk`, `distancePips`), rewrote proximity calculation with 3-tier logic |
| `supabase/functions/bot-scanner/index.ts` | Changed market fill gate from loose `priceAtZone` to strict `priceAtZoneStrict && sideOk`; added new fields to izData passthrough; updated Telegram message to show distance; added diagnostic logging |
| `src/components/ImpulseZonePanel.tsx` | Updated interface and display to show AT ZONE / NEAR ZONE / NEAR (LOOSE) badges with distance info |
| `supabase/functions/_shared/strictZoneProximity.test.ts` | New test file: 15 tests covering the proximity logic |

## What was changed in bot-scanner/index.ts (extra caution file)

The market fill decision logic (around line 4860) was changed from:
```typescript
// OLD: loose priceAtZone (1.5×ATR, no side check)
const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;
```
to:
```typescript
// NEW: strict priceAtZoneStrict (0.3×ATR + correct side)
const strictZone = izData?.bestZone?.priceAtZoneStrict === true;
const sideOk = izData?.bestZone?.sideOk === true;
const priceIsAtValidatedZone = izGateMode === "hard" && strictZone && sideOk;
```

The directional guard (Layer 3, 2× zone width buffer) remains as a fallback safety net after this check. The old `priceAtZone` flag is still computed and used for watchlist/awareness decisions (line 4136) — those paths are unchanged.

Additionally, new fields were added to the izData passthrough (line ~4007):
```typescript
priceInsideZone: zoneResult.bestZone.priceInsideZone,
priceAtZoneStrict: zoneResult.bestZone.priceAtZoneStrict,
sideOk: zoneResult.bestZone.sideOk,
distancePips: zoneResult.bestZone.distancePips,
```

## Tests added

| Test | Assertion |
|------|-----------|
| EUR/AUD chasing regression | Price 44.7p above zone → priceAtZone=true, priceAtZoneStrict=false, sideOk=false |
| Price inside zone | All flags true, distance=0 |
| LONG: 5p below demand | strict=true, sideOk=true (correct side, within threshold) |
| LONG: 5p above demand (within 0.3×ATR) | strict=true, sideOk=true |
| LONG: 25p above demand | strict=false, sideOk=false |
| SHORT: 5p above supply | strict=true, sideOk=true |
| SHORT: 30p below supply | strict=false, sideOk=false |
| SHORT: 4p below supply (within 0.3×ATR) | strict=true, sideOk=true |
| XAU/USD: 80p above demand | strict=false (wider ATR scales correctly) |
| XAU/USD: 10p above demand | strict=true (gold's wider ATR allows proportional buffer) |
| Boundary: price at zone high | priceInsideZone=true |
| Boundary: price at zone low | priceInsideZone=true |
| Bot-scanner integration: EUR/AUD blocks market fill | Simulates full decision logic, confirms block |
| Bot-scanner integration: price inside zone allows fill | Confirms valid fills still work |
| Backwards compat: loose priceAtZone unchanged | 5 test cases proving 1.5×ATR behavior identical |

## Tests run

```
$ deno test supabase/functions/_shared/strictZoneProximity.test.ts
ok | 15 passed | 0 failed (15ms)

$ deno test supabase/functions/bot-scanner/market-fill-at-zone.test.ts
ok | 21 passed | 0 failed (21ms)

$ deno test supabase/functions/_shared/impulseZoneEngine.test.ts
ok | 37 passed | 0 failed (37ms)

$ deno test supabase/functions/ (full suite)
FAILED | 809 passed | 33 failed (8s)
— All 33 failures are PRE-EXISTING (37 on main). Our changes resolved 4 previously-failing tests.
— None of the failures are related to zone proximity, strict fields, or market fill logic.
```

## Regression check

1. **Loose `priceAtZone` unchanged:** Test "backwards compat" proves 5 different price/zone/ATR combinations produce identical results to the old implementation.
2. **Existing market-fill tests pass:** All 21 tests in `market-fill-at-zone.test.ts` still pass (including the 10 directional guard tests from the previous branch).
3. **Existing impulseZoneEngine tests pass:** All 37 tests pass — the new fields are additive and don't change existing return values.
4. **Watchlist path unaffected:** The `priceAtZone` (loose) flag is still used at line 4136 for the watchlist gate decision — this behavior is unchanged.

## Open questions

1. **Should `PRICE_AT_ZONE_STRICT_ATR_MULT` be configurable per-pair?** Currently hardcoded at 0.3. Gold might benefit from a slightly different value given its wider ATR. Could add to `pairConfig` if needed.

2. **The pending order path (zone-confirmation-scanner):** Lovable's analysis confirmed it uses a much tighter buffer (0.1× zone width) and requires physical price touch. No change needed there. But should we add a similar `sideOk` check to the pending order placement itself (line ~4990)?

3. **Should the "NEAR (LOOSE)" state still add pairs to watchlist?** Currently it does (same as before). The only change is that it won't market-fill. This seems correct but worth confirming.

## Suggested PR title and description

**Title:** `fix(zone-proximity): add strict zone validation to prevent market fills when price is far from zone`

**Description:**
```
Fixes the EUR/AUD chasing bug where a LONG trade market-filled at 1.62166 when
the demand zone was at 1.61607–1.61719 (44.7 pips away). The priceAtZone flag
was true because 1.5×ATR (~45p) barely covered the distance.

Adds 3-layer protection:
  Layer 1: priceAtZoneStrict (0.3×ATR) — 9 pips on EUR/AUD vs old 45 pips
  Layer 2: sideOk — directional awareness (longs can't be far above demand)
  Layer 3: priceOnCorrectSide — 2× zone width buffer (existing guard)

Market fill gate now requires priceAtZoneStrict && sideOk (not loose priceAtZone).
Trades where price has moved away route to pending order / CHoCH path instead.

Dashboard shows AT ZONE / NEAR ZONE / NEAR (LOOSE) with distance.
Telegram shows distance from zone edge.

15 new unit tests including exact EUR/AUD regression scenario.
All 73 zone-related tests passing (15 + 21 + 37).
```
