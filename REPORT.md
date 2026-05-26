# Task: Zone Display Clarity
## Branch: manus/zone-display-clarity
## Behavior changes

1. **Zone Setup ACTIVE** Telegram notification now includes a `Zone:` line showing the zone bounds `[low-high]` — previously only showed the trigger price.
2. **Zone Setup ACTIVE** notification now shows `⚠️ Zone shifted: was [X-Y] → now [A-B]` when a watchlist-promoted pair's zone has moved by more than 1 pip between the original staging and the promotion cycle.
3. **Trade Opened** (market fill) notification now shows `⚠️ Zone shifted` when a watchlist-promoted trade's zone moved since it was first staged.
4. **CONFIRMED Entry** notification now shows `⚠️ Fill Xp above/below zone` when the actual fill price is outside the zone bounds — making it immediately visible when a fill deviates from the intended zone level.

All changes are display-only. No gate logic, scoring, or entry decisions are affected.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added zone bounds to Zone Setup ACTIVE notification; added zone shift detection for watchlist-promoted setups in both Zone Setup ACTIVE and Trade Opened notifications; added fill distance warning to CONFIRMED Entry notification |
| `supabase/functions/bot-scanner/zone-display-clarity.test.ts` | New test file: 13 tests covering zone shift detection and fill distance calculation |

## What was changed in bot-scanner/index.ts (extra caution file)

Three Telegram notification templates were updated (display-only, no logic changes):

1. **Zone Setup ACTIVE (line ~4997):** Added `Zone: [low-high]` line and zone shift detection block that compares `existingStaged.analysis_snapshot.impulseZone` (original zone at staging time) with current `limitEntry.zoneLow/High`. Shows ⚠️ warning if zone moved >1 pip.

2. **Trade Opened (line ~5136):** Added zone shift detection for watchlist-promoted market fills using the same comparison logic.

3. **CONFIRMED Entry (line ~2974):** Added IIFE that calculates `actualFillPrice` vs zone bounds and shows `⚠️ Fill Xp above/below zone` when fill is outside the zone. Uses JPY-aware pip multiplier.

## Tests added

| Test | Assertion |
|------|-----------|
| zone shift: detects shift when zone moves more than 1 pip | Shift detected, message contains old and new bounds |
| zone shift: no shift when zone stays the same | No shift flagged |
| zone shift: no shift for sub-pip movement (noise) | Sub-pip differences ignored |
| zone shift: detects shift when only low moves | Partial movement detected |
| zone shift: detects shift when only high moves | Partial movement detected |
| zone shift: EUR/AUD real scenario — zone shifts from OB1 to OB2 | Real-world case validated |
| fill distance: fill inside zone shows no warning | No false positive |
| fill distance: fill above zone shows distance in pips | 44.7p calculated correctly |
| fill distance: fill below zone shows distance in pips | 10.7p calculated correctly |
| fill distance: JPY pair uses correct pip multiplier | ×100 not ×10000 |
| fill distance: fill exactly at zone edge shows no warning | Edge case handled |
| fill distance: fill exactly at zone low shows no warning | Edge case handled |
| fill distance: XAUUSD fill above zone | Gold pair handled |

## Tests run

```
$ deno test supabase/functions/bot-scanner/zone-display-clarity.test.ts
ok | 13 passed | 0 failed (18ms)

$ deno test supabase/functions/bot-scanner/market-fill-at-zone.test.ts
ok | 21 passed | 0 failed (17ms)

$ deno test supabase/functions/_shared/strictZoneProximity.test.ts
ok | 15 passed | 0 failed (15ms)
```

## Regression check

- All 21 existing market-fill-at-zone tests pass unchanged
- All 15 strict zone proximity tests pass unchanged
- Changes are display-only (Telegram message strings) — no gate, scoring, or entry logic touched
- The zone shift detection uses a >0.0001 threshold (>1 pip) to avoid noise from floating point

## Open questions

1. Should the zone shift warning also be logged to the `signal_reason` JSON for historical audit?
2. Gold/indices pip calculation in the fill distance warning uses the generic ×10000 multiplier — should we add instrument-specific pip tables for more accurate display?

## Suggested PR title and description

**Title:** `feat: add zone shift + fill distance warnings to Telegram notifications`

**Description:**
Adds display clarity to Telegram trade notifications:
- Zone Setup ACTIVE now shows zone bounds [low-high]
- Watchlist-promoted trades show ⚠️ when zone shifted between staging and promotion
- Confirmed entries show ⚠️ with pip distance when fill is outside zone bounds

Display-only changes — no gate logic, scoring, or entry decisions affected.
Addresses the EUR/AUD confusion where zone [1.61607-1.61719] was shown but entry was at 1.62166.
