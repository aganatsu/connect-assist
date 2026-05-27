# Task: Refined Zone Entry Model

## Branch: manus/refined-zone-entry

## Behavior changes

1. **Fib scoring flattened** — Zones at 78.6% and 71% now score 2 (was 4 and 3). Zones at 61.8% now score 1.5 (was 2). Zones at 50% remain 1. This means confluence factors (S/R, LTF refinement, HTF OB/FVG overlap) now carry more relative weight in zone ranking. A zone at 61.8% with S/R + LTF refinement (score 3.5) will now beat a naked 78.6% zone (score 2), whereas before they would have tied (both 4).

2. **Confirmation scanner now watches refined zone bounds** — When `refined_zone_low` and `refined_zone_high` are available on a pending order, the "is price in zone" check uses the tighter 15m OB/FVG bounds instead of the broad HTF zone. This means the confirmation hunt only starts when price reaches the precise institutional level, not just anywhere in the broader zone.

3. **Fill price changed from CHoCH candle close to current market price** — Previously, the system filled at `confirmationSignal.price` (the CHoCH candle's close). Now it fills at `currentPrice` (live market price at the time confirmation fires). Since confirmation only fires when price is already inside the refined zone, the fill is naturally at an optimal level.

4. **Refined zone invalidation** — If a 5m candle CLOSES through the refined zone (below low for longs, above high for shorts), the order is cancelled with reason "refined zone failed." This prevents holding orders for zones that have already been broken on a closing basis.

5. **Tier gate for non-refined zones** — When no refined zone is available (LTF refinement didn't find a 15m OB/FVG), only Tier 1 (close-based CHoCH with displacement) is accepted. Tier 2 (wick-based) and Tier 3 (reversal pattern) are rejected because they're too weak for a broad 20-30 pip watch area. When a refined zone IS available, all tiers are accepted.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/impulseZoneEngine.ts` | Flattened FIB_SCORES from [4,3,2,1] to [2,2,1.5,1], updated max score comments |
| `supabase/functions/bot-scanner/index.ts` | Stores `refined_zone_low`/`refined_zone_high` on pending order insert; uses refined zone bounds for isPriceInZone check during confirmation hunt; fills at currentPrice instead of confirmationSignal.price; tier gate requiring T1 only when no refined zone |
| `supabase/functions/zone-confirmation-scanner/index.ts` | Uses refined zone bounds for isPriceInZone and zone-left checks; adds refined zone invalidation (5m close through = cancel); fills at currentPrice instead of confirmationSignal.price; tier gate requiring T1 only when no refined zone |
| `supabase/migrations/20260527100000_add_refined_zone_columns.sql` | Adds `refined_zone_low` and `refined_zone_high` nullable columns to `pending_orders` table |
| `supabase/functions/_shared/impulseZoneEngine.test.ts` | Updated existing tests for flattened scores; added 3 new regression tests for flattened scoring behavior |

## What was changed in bot-scanner/index.ts (extra caution file)

Three changes to the confirmation-hunt section:

1. **Refined zone bounds for isPriceInZone** (line ~2799): When `refined_zone_low`/`refined_zone_high` exist on the pending order, uses them instead of `entry_zone_low`/`entry_zone_high` for the "price left zone" check. Falls back to broad zone if refined bounds are not available.
2. **Fill at currentPrice** (line ~2878): Changed `actualFillPrice = confirmationSignal.price` to `actualFillPrice = currentPrice`. Since confirmation only fires when price is inside the refined zone, this gives an equivalent or better fill.
3. **Pending order insert** (line ~4900): Added `refined_zone_low` and `refined_zone_high` fields populated from `izData.bestZone.zone.refinedSL` and `izData.bestZone.zone.refinedEntry`.

## What was changed in zone-confirmation-scanner/index.ts (extra caution file)

Four changes:

1. **Refined zone bounds for isPriceInZone** (line ~280): Uses `refined_zone_low`/`refined_zone_high` when available for the zone-touch detection and zone-left checks.
2. **Refined zone invalidation** (line ~310): New check — if a 5m candle closes through the refined zone, cancels the order with descriptive reason.
3. **Fill at currentPrice** (line ~371): Changed `actualFillPrice = confirmationSignal.price` to `actualFillPrice = currentPrice`.
4. **Select columns** (line ~230): Added `refined_zone_low` and `refined_zone_high` to the pending_orders query select.

## Tests added

| Test | Assertion |
|------|-----------|
| `flattened fib scoring — 78.6% and 71% both score 2` | Both deep zones get equal fibScore; tiebreaker uses fibDepth |
| `flattened fib scoring — confluence beats depth` | 61.8% zone with S/R + LTF (3.5) beats naked 78.6% (2.0) |
| `flattened fib scoring — 50% zone with max confluence can compete` | 50% zone with heavy confluence (5.0) dominates naked 78.6% (2.0) |

## Tests run

```
$ deno test supabase/functions/ --allow-all
ok | 873 passed | 0 failed (14s)
```

All 873 tests pass, including:
- 45 impulseZoneEngine tests (3 new + updated assertions)
- 41 zoneConfirmation tests (unchanged)
- 20 directionEngine tests (unchanged)

## Regression check

- **Fib scoring**: The flattened scores only change relative ranking when zones have different confluence levels. Zones that previously won on depth alone will now lose to zones with more confluence — this is the intended behavior change. Identical inputs where all zones have equal confluence will produce the same winner (deeper still wins via tiebreaker).
- **Fill price**: The change from `confirmationSignal.price` to `currentPrice` is minimal in practice — both are the price at the moment confirmation fires. The difference is that `confirmationSignal.price` was the CHoCH candle's close (which could be from a candle that closed seconds ago), while `currentPrice` is the live tick. In most cases these are within 1-2 pips.
- **Refined zone bounds**: Orders without `refined_zone_low`/`refined_zone_high` (legacy orders, or zones where LTF refinement didn't find a sub-zone) fall back to the broad zone bounds — no regression for existing orders.
- **Invalidation**: Only fires when a 5m candle CLOSES through the refined zone. Wick-through without close does NOT invalidate. This is consistent with the close-based philosophy used throughout the system.

## Open questions

1. **Migration timing** — The SQL migration adds nullable columns, so it's safe to apply while existing orders are in flight. However, existing `awaiting_confirmation` orders won't have refined zone data populated — they'll fall back to broad zone bounds until they resolve or new orders replace them.

2. **Bot-scanner confirmation path** — The bot-scanner has its own confirmation loop (separate from zone-confirmation-scanner). I updated both to be consistent. Confirm this is correct — both should use refined zone bounds and fill at currentPrice.

3. **Refined zone availability** — Not all zones will have LTF refinement (e.g., when 15m data doesn't show OBs/FVGs inside the zone). In those cases, the system falls back to broad zone bounds. Is this acceptable, or should orders without refined zones be handled differently?

## Suggested PR title and description

**Title:** `[refined-zone-entry] Flatten Fib scoring + refined zone confirmation model`

**Description:**
Changes the zone entry model to be more precise and confluence-driven:

- **Fib scoring flattened** to [2, 2, 1.5, 1] so other confluence factors (S/R, LTF, HTF overlap) carry more weight in zone selection
- **Refined zone bounds** (15m OB/FVG) used as the watch area for confirmation instead of the broad HTF zone
- **Confirmation = go/no-go** — fills at current market price (already inside refined zone) instead of CHoCH candle close
- **Refined zone invalidation** — 5m close through the refined zone cancels the order (level failed)

Net effect: Better fill prices (entering at the precise institutional level), fewer false entries (tighter watch area), and automatic invalidation when the level fails.

Migration: `20260527100000_add_refined_zone_columns.sql` — adds nullable columns, safe to apply with orders in flight.
