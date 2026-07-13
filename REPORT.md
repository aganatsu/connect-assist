# Task: Signal Source Badge — Fix Detail Breakdown Misinformation
## Branch: manus/signal-source-badge

## Behavior changes

1. **New UI badge on live scan details:** When a trade is placed, the signal detail row now shows a colored badge: `UNIFIED ×1` (cyan), `CASCADE ×1` (purple), or `STANDALONE ×0.5` (orange). Previously, no indication of entry path was shown.

2. **New context note for standalone trades:** When a trade was placed via standalone fallback, an orange info box appears in the expanded detail: "Entry via standalone impulse zone — unified confirmation not met. Position size halved (×0.5)."

3. **Signal source persisted to database:** `signalSource` and `unifiedZone` are now included in the `signal_reason` JSON stored in `paper_positions`. This means future closed trades will also display the badge in trade history. (Existing trades opened before this deploy will not have the field — badge simply won't render for them.)

4. **No change to trading logic, gates, weights, or position sizing.** The signal source was already computed and stored in `scan_logs.details_json` — this change only adds it to `signal_reason` and surfaces it in the UI.

## Files modified

| File | Change |
|------|--------|
| `supabase/functions/bot-scanner/index.ts` | Added `signalSource` and `unifiedZone` to `signal_reason` JSON in both market-order (line 6217) and limit-order (line 6001) insert paths |
| `src/pages/BotView.tsx` | Added signal source badge + context note to `ScanSignalDetail` component (live scan results) and `ScanDetailInline` component (inline detail view), plus badge in closed-trade history expansion |
| `src/components/ExpandedPositionCard.tsx` | Added signal source badge to the trade header bar for open positions |
| `src/components/MobilePositionCard.tsx` | Added compact signal source badge (`UNI`/`CAS`/`STD½`) to mobile position cards |
| `supabase/functions/_shared/signalSourcePersistence.test.ts` | New test file verifying signal source persistence |

## Tests added

| Test | Asserts |
|------|---------|
| `signal_reason JSON includes signalSource field (market order path)` | Market-order signal_reason JSON.stringify includes `signalSource` and `unifiedZone` |
| `signal_reason JSON includes signalSource field (limit order path)` | Limit-order signal_reason JSON.stringify includes `signalSource` and `unifiedZone` |
| `signalSource is set to one of: unified, standalone, cascade` | All three assignment paths exist in bot-scanner |
| `signalSource assignment happens BEFORE signal_reason construction` | The assignment at ~line 4846 precedes the JSON.stringify at ~line 6217 |

## Tests run

```
deno test --no-check --allow-all supabase/
FAILED | 1575 passed | 6 failed (17s)
```

All 6 failures are **pre-existing** (confirmed identical on `main`):
- 5× `brokerFillPriceBE.test.ts` — BE price calculation assertions
- 1× `beTrailingRace.test.ts` — short position co-activation

Our 4 new tests all pass. Zero new failures introduced.

## Regression check

- The `signal_reason` JSON change is purely additive — we append two new fields (`signalSource`, `unifiedZone`) to an existing JSON.stringify object. No existing fields are modified or removed.
- `deno check` confirms zero new type errors from our change (the 62 pre-existing type errors are unrelated).
- Frontend changes are display-only — they read `d.signalSource` / `sr.signalSource` and render a badge. If the field is absent (legacy trades), the badge simply doesn't render (conditional `{sr.signalSource && ...}`).
- No gate logic, scoring, position sizing, or trade execution code was modified.

## Open questions

1. **Existing open positions:** Positions opened before this deploy won't have `signalSource` in their `signal_reason`. Should we backfill from `scan_logs.details_json`? (Low priority — they'll close eventually and new trades will have it.)

2. **Pre-existing test failures:** The 6 failing `brokerFillPriceBE` / `beTrailingRace` tests appear to be a regression from a prior change. Unrelated to this task but worth investigating separately.

## Suggested PR title and description

**Title:** `[signal-source-badge] Show unified/standalone/cascade entry path in trade detail breakdown`

**Description:**
Fixes the detail breakdown misinformation where trades placed via standalone fallback (0.5× size) showed the unified zone analysis without indicating the trade bypassed unified confirmation.

Changes:
- Adds `signalSource` and `unifiedZone` to `signal_reason` JSON (both market + limit order paths)
- Displays colored badge (UNIFIED ×1 / STANDALONE ×0.5 / CASCADE ×1) in:
  - Live scan detail rows
  - Inline scan detail view
  - Closed trade history expansion
  - Open position expanded card
  - Mobile position card
- Shows explanatory note for standalone trades: "Entry via standalone impulse zone — unified confirmation not met. Position size halved (×0.5)"
- 4 new static analysis tests verifying persistence schema

No behavior changes to trading logic.
