# Task: Market Fill at Zone (Option C)

## Branch: manus/market-fill-at-zone

## Behavior changes

1. **When `izGateMode="hard"` AND price IS at a validated impulse zone AND `marketFillAtZone=true` (new default), the bot now places a MARKET ORDER immediately** instead of a pending limit order that waits for 5m CHoCH confirmation. This is the primary user-visible change — trades that previously sat at "awaiting_confirmation" forever will now fill immediately when the zone is validated and all gates pass.

2. **Pending orders with CHoCH confirmation are now reserved for the "watching_zone" path only** — when the impulse zone exists but price hasn't reached it yet. The tiered CHoCH system (from the previous branch) still applies to these watching-zone orders.

3. **New Telegram notification tag** — market-fill-at-zone trades include a "🎯 Market Fill at Zone" section showing the zone boundaries.

4. **New detail status** — `"trade_placed_at_zone"` distinguishes zone fills from regular market fills in scan logs.

5. **Fully backwards-compatible** — setting `marketFillAtZone: false` in config restores the old behavior exactly (regression test proves this).

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added `marketFillAtZone` config (default: true), entry decision logic that bypasses pending orders when price is at a validated zone, market-fill logging, detail metadata, and Telegram notification tag |
| `supabase/functions/bot-scanner/market-fill-at-zone.test.ts` | 11 new tests covering entry decision logic, config defaults, metadata, and regression verification |

## What was changed in bot-scanner/index.ts (extra caution file)

Three surgical changes were made:

1. **Line 204** — Added `marketFillAtZone: true` to DEFAULTS (new config option).

2. **Line 961** — Added `marketFillAtZone` to the config resolution function so it's read from `bot_configs` DB table.

3. **Lines 4856-4869** — The entry decision logic. Previously:
   ```ts
   const effectiveLimitEnabled = config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry);
   ```
   Now:
   ```ts
   const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;
   const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone;
   const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));
   ```
   When `useMarketFillAtZone` is true, `effectiveLimitEnabled` becomes false, so the code falls through to the market order path below.

4. **Lines 5004-5006** — Added console log for market-fill-at-zone trades.

5. **Lines 5052-5057** — Added detail metadata (`entryMethod`, `zoneConfirmation`, `impulseZoneEntry`).

6. **Line 5083-5084** — Added zone info to Telegram notification.

## Tests added

| Test | Assertion |
|------|-----------|
| `priceAtZone + marketFillAtZone=true → effectiveLimitEnabled=false` | Market fill at zone disables limit orders |
| `priceAtZone + marketFillAtZone=false → effectiveLimitEnabled=true` | Old behavior preserved when config disabled |
| `price NOT at zone → effectiveLimitEnabled=true` | Watching path still uses limit orders |
| `izGateMode=soft → no market fill at zone` | Feature only activates with hard gate |
| `limitOrderEnabled=true + NOT at zone → limit orders` | Explicit limit config respected |
| `config default is true` | Feature enabled by default |
| `status is 'trade_placed_at_zone'` | Correct status metadata |
| `promoted from staging takes priority` | Staging promotion status not overwritten |
| `entryMethod is 'market_fill_at_zone'` | Correct entry method metadata |
| `marketFillAtZone=false → identical to pre-change` | Full regression: all 6 config combos produce same result as old code |
| `marketFillAtZone=true → ONLY priceAtZone+hard changes` | Proves only the intended case diverges |

## Tests run

```
$ deno test --allow-all supabase/functions/bot-scanner/market-fill-at-zone.test.ts
ok | 11 passed | 0 failed (16ms)

$ deno test --allow-all supabase/functions/
ok | 840 passed | 0 failed (12s)
```

Type checking:
```
$ deno check supabase/functions/bot-scanner/index.ts -> 9 pre-existing errors (verified on base branch, none from our changes)
```

## Regression check

Two dedicated regression tests verify:
1. With `marketFillAtZone=false`, the new code produces **identical results** to the old code for all 6 tested config combinations (izGateMode × priceAtZone × limitOrderEnabled × limitEntry).
2. With `marketFillAtZone=true`, **only one specific case** changes behavior: `izGateMode="hard" + priceAtZone=true`. All other combinations remain unchanged.

Additionally, the type checker confirms 9 errors — all pre-existing (lines 1049, 3294, 3619, 3621, 5373, 5409, 5410), none from our changes.

## Open questions

1. **Should `marketFillAtZone` be per-pair configurable?** Currently it's a global config. Some pairs (e.g., XAU/USD with wider zones) might benefit from still using CHoCH confirmation even when at zone.

2. **Spread filter timing** — The spread check happens AFTER the entry decision. If spread is too wide at the moment of zone touch, the trade is rejected. Should we add a retry mechanism (check spread again on next scan cycle)?

3. **Zone-confirmation-scanner deployment** — For the "watching_zone" path (pending orders), the zone-confirmation-scanner still needs to be deployed with a pg_cron job. Want me to create the migration?

## Suggested PR title and description

**Title:** feat: market fill at zone — immediate entry when price is at validated impulse zone

**Description:**
Previously, with `izGateMode="hard"`, ALL trades went through the pending order path requiring 5m CHoCH confirmation before filling. This caused trades to sit at "awaiting_confirmation" indefinitely when a textbook CHoCH never formed — even though the impulse zone engine had already validated the zone and all 22 safety gates passed.

This PR adds a `marketFillAtZone` config (default: `true`) that fills at market price immediately when:
- `izGateMode="hard"` (zone is validated)
- Price IS at the zone (confirmed by impulse zone engine)
- All safety gates pass
- Score threshold met

The pending order path with CHoCH confirmation is now reserved for the "watching_zone" scenario — when a valid zone exists but price hasn't arrived yet.

**Backwards compatible:** Set `marketFillAtZone: false` in bot_configs to restore old behavior.

**840 tests passing, 11 new tests added.**
