# Task: Directional Zone Guard — Prevent Chasing Entries

## Branch: manus/fix-zone-directional-guard

## Behavior changes

1. **Market fill at zone is now blocked when price has already moved away from the zone** (chasing). Previously, `priceAtZone` used a generous 1.5×ATR proximity check that did not verify which SIDE of the zone price was on. A LONG trade could fill at market even when price was 44+ pips ABOVE the demand zone (buying the move, not the zone).

2. **When the directional guard blocks a market fill, the bot falls back to the limit order path** (pending order with tiered CHoCH confirmation). This is the safe path — the trade waits for price to return to the zone rather than chasing.

3. **No change when price is genuinely at/near the zone on the correct side.** The guard uses a buffer of 2× zone width, which is instrument-adaptive: wider zones (gold) get wider buffers automatically.

## Real-world trigger

EUR/AUD LONG filled at 1.62166 when the demand zone was 1.61607–1.61719. That's 44.7 pips ABOVE the zone — the bot was chasing. The `priceAtZone` flag was `true` because 1.5×ATR proximity was satisfied, but the directional check was missing.

## Fix logic (lines 4865–4892 in bot-scanner/index.ts)

```
LONG (demand zone):  price must be ≤ zoneHigh + (2 × zoneWidth)
SHORT (supply zone): price must be ≥ zoneLow  - (2 × zoneWidth)
```

- Buffer = 2× zone width (instrument-adaptive: gold zones are wider → wider buffer)
- When blocked: logs `⚠️ MARKET FILL BLOCKED — price X is on wrong side of zone`
- Falls back to `effectiveLimitEnabled = true` → pending order path

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added directional guard (lines 4865–4892): `priceOnCorrectSide` check before allowing `useMarketFillAtZone`. Logs warning when blocked. |
| `supabase/functions/bot-scanner/market-fill-at-zone.test.ts` | Added 10 new directional guard tests covering LONG/SHORT scenarios, the exact EUR/AUD case, XAU/USD wider zones, and full integration fallback logic. |
| `REPORT.md` | This file. |

## What was changed in bot-scanner/index.ts (extra caution file)

One surgical addition at lines 4865–4892, between the existing `priceIsAtValidatedZone` calculation and the `useMarketFillAtZone` assignment:

```typescript
// ── Directional Guard ──────────────────────────────────────────────
let priceOnCorrectSide = true;
if (priceIsAtValidatedZone && izData?.bestZone) {
  const zoneHigh = izData.bestZone.high;
  const zoneLow = izData.bestZone.low;
  const zoneWidth = zoneHigh - zoneLow;
  const buffer = zoneWidth * 2;
  const currentPrice = analysis.lastPrice;
  if (analysis.direction === "long") {
    priceOnCorrectSide = currentPrice <= zoneHigh + buffer;
  } else {
    priceOnCorrectSide = currentPrice >= zoneLow - buffer;
  }
  if (!priceOnCorrectSide) {
    console.log(`⚠️ MARKET FILL BLOCKED — price on wrong side of zone`);
  }
}
const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide;
```

The `&& priceOnCorrectSide` is the only change to the `useMarketFillAtZone` assignment. Everything else (the limit order path, the market order path, metadata, notifications) is untouched.

## Tests added

| Test | Assertion |
|------|-----------|
| Directional Guard — LONG: price inside zone → allows market fill | `priceOnCorrectSide = true` when price is within zone bounds |
| Directional Guard — LONG: price slightly above zone (within buffer) → allows | Allows when within 2× zone width above zone top |
| Directional Guard — LONG: price far above zone (beyond buffer) → BLOCKS | EUR/AUD scenario: 1.62166 vs zone 1.61607–1.61719 → blocked |
| Directional Guard — LONG: price below zone → allows (approaching) | Price below demand zone is fine for longs |
| Directional Guard — SHORT: price inside zone → allows market fill | `priceOnCorrectSide = true` when price is within zone bounds |
| Directional Guard — SHORT: price slightly below zone (within buffer) → allows | Allows when within 2× zone width below zone bottom |
| Directional Guard — SHORT: price far below zone (beyond buffer) → BLOCKS | Mirror of EUR/AUD: 30 pips below supply zone → blocked |
| Directional Guard — SHORT: price above zone → allows (approaching) | Price above supply zone is fine for shorts |
| Directional Guard — full integration: blocks chasing, falls back to limit | Full decision logic: priceAtZone=true but directional guard blocks → effectiveLimitEnabled=true |
| Directional Guard — XAU/USD wider zones: 50-pip zone allows 100-pip buffer | Instrument-adaptive: gold's wider zones get proportionally wider buffers |

## Tests run

```
running 21 tests from ./supabase/functions/bot-scanner/market-fill-at-zone.test.ts
Market Fill at Zone — entry decision: priceAtZone + marketFillAtZone=true → effectiveLimitEnabled=false ... ok
Market Fill at Zone — entry decision: priceAtZone + marketFillAtZone=false → effectiveLimitEnabled=true (old behavior) ... ok
Market Fill at Zone — entry decision: price NOT at zone → effectiveLimitEnabled=true (watching path) ... ok
Market Fill at Zone — entry decision: izGateMode=soft → effectiveLimitEnabled depends on limitOrderEnabled only ... ok
Market Fill at Zone — entry decision: limitOrderEnabled=true overrides marketFillAtZone when NOT at zone ... ok
Market Fill at Zone — config: default is true (enabled by default) ... ok
Market Fill at Zone — metadata: status is 'trade_placed_at_zone' for zone fills ... ok
Market Fill at Zone — metadata: promoted from staging takes priority over zone fill status ... ok
Market Fill at Zone — metadata: entryMethod is 'market_fill_at_zone' ... ok
Market Fill at Zone — regression: with marketFillAtZone=false, behavior is identical to pre-change ... ok
Directional Guard — LONG: price inside zone → allows market fill ... ok
Directional Guard — LONG: price slightly above zone (within buffer) → allows market fill ... ok
Directional Guard — LONG: price far above zone (beyond buffer) → BLOCKS market fill ... ok
Directional Guard — LONG: price below zone → allows market fill (approaching zone) ... ok
Directional Guard — SHORT: price inside zone → allows market fill ... ok
Directional Guard — SHORT: price slightly below zone (within buffer) → allows market fill ... ok
Directional Guard — SHORT: price far below zone (beyond buffer) → BLOCKS market fill ... ok
Directional Guard — SHORT: price above zone → allows market fill (approaching zone) ... ok
Directional Guard — full integration: blocks market fill when chasing, falls back to limit order ... ok
Directional Guard — XAU/USD wider zones: 50-pip zone allows up to 100-pip buffer ... ok
Market Fill at Zone — regression: with marketFillAtZone=true, ONLY priceAtZone+hard changes behavior ... ok

ok | 21 passed | 0 failed (16ms)
```

Type checking:
```
$ deno check supabase/functions/bot-scanner/index.ts
9 pre-existing errors (lines 1049, 3294, 3619, 3621) — none from our changes
```

## Regression check

1. **Existing 10 market-fill-at-zone tests still pass** — the directional guard only adds an additional check; when price IS on the correct side, behavior is identical to before.
2. **The regression test (test #10)** explicitly verifies that with `marketFillAtZone=false`, the new code produces identical results to the pre-change logic for all input combinations.
3. **Type check**: 9 pre-existing TS errors (lines 1049, 3294, 3619, 3621) — none introduced by this change.
4. **The guard only affects the `useMarketFillAtZone` path** — if `marketFillAtZone` is disabled in config, or if `izGateMode` is not "hard", or if `priceAtZone` is false, the directional guard is never evaluated.

## Open questions

1. **Should the buffer be configurable?** Currently hardcoded at 2× zone width. Could be a `marketFillMaxOvershoot` config parameter (multiplier of zone width). For now, 2× is conservative and instrument-adaptive.
2. **Should we log to the `trade_signals` table when a market fill is blocked?** This would help audit how often the guard fires in production. Currently only logs to console (visible in Supabase function logs).
3. **Should the `priceAtZone` flag itself be tightened?** The 1.5×ATR proximity is still generous. The directional guard patches the worst case (wrong side), but we could also reduce the ATR multiplier from 1.5 to 1.0 for a tighter overall check.

## Suggested PR title and description

**Title:** `fix: add directional guard to prevent chasing entries at zone`

**Description:**
```
Fixes the EUR/AUD chasing issue where a LONG trade filled 44.7 pips ABOVE
the demand zone because priceAtZone uses 1.5×ATR proximity without checking
which side of the zone price is on.

Adds a directional guard:
- LONG: price must be ≤ zoneHigh + (2 × zone width)
- SHORT: price must be ≥ zoneLow - (2 × zone width)

When blocked, falls back to limit order path (pending order with CHoCH confirmation).
Buffer is instrument-adaptive: wider zones get wider buffers automatically.

10 new tests covering the exact EUR/AUD scenario, both directions, XAU/USD
wider zones, and full integration fallback logic. All 21 tests passing.
```
