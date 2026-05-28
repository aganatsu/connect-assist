# Task: Entry Confirmation Story — UI + Telegram

## Branch: manus/confirmation-story

## Behavior changes

1. **ExpandedPositionCard** now shows a new "Entry Confirmation" section (ROW 1.5) between the trade header and management cards. This section renders:
   - Confirmation signal type (engulfing, rejection wick, FVG, sweep+reclaim, displacement, volume spike)
   - Confirmation tier badge (T1/T2/T3)
   - Displacement strength with color coding (green ≥1.5×, white ≥1.0×, warn <1.0×)
   - Significance level (high/medium/low)
   - Supporting signals as pills
   - Zone type and boundaries
   - Timeline: placed → zone touch → attempts → filled
   - Watchlist origin summary (cycles watched, initial score)
   - Falls back gracefully: shows "Market Fill at Zone" or "Limit Order Fill" badges when full confirmation data is absent
   - **Only renders when confirmation data exists in signal_reason** — no visual change for trades without zone confirmation data

2. **Telegram confirmed entry notification** now includes:
   - Confirmation tier in the header (e.g., "LIVE CONFIRMED Entry T1")
   - Supporting signals line (e.g., "Supporting: rejection wick, fvg created")
   - Confirmation attempts count
   - Significance level alongside displacement
   - Cleaner formatting with dedicated "🎯 Confirmation" section header

3. **Telegram market fill notification** now includes:
   - Zone type label (e.g., "IZ-OB" instead of just coordinates)
   - En-dash separator for zone range (visual consistency)
   - Refined entry price when available
   - "(inside)" label when price is inside zone

## Files modified

- `src/components/ExpandedPositionCard.tsx` — Added ~100 lines for the Entry Confirmation Story section (ROW 1.5). Reads existing `sr.confirmation`, `sr.limitOrderOrigin`, `sr.impulseZoneEntry` data from signal_reason JSON and renders it visually. No new data fetching, no new API calls.
- `supabase/functions/bot-scanner/index.ts` — Enhanced two Telegram notification messages:
  - Line ~2979: Confirmed limit order fill notification — added tier, supporting signals, attempts, significance
  - Line ~5151: Market fill at zone notification — added zone type, refined entry, cleaner formatting

### Extra caution explanation (bot-scanner/index.ts)

**What changed:** Two Telegram notification message strings were enhanced with additional fields that were already available in scope (`confirmationSignal.tier`, `confirmationSignal.supportingSignals`, `confirmationSignal.significance`, `pending.confirmation_attempts`, `izData.bestZone.type`, `izData.bestZone.refinedEntry`).

**Why it's safe:** These are purely cosmetic changes to notification text. No trade logic, gate evaluation, position sizing, or order execution code was touched. The additional fields are accessed with optional chaining and fallback defaults, so missing data produces empty strings rather than errors. The notification `fetch()` calls and error handling remain identical.

## Tests added

No new test files for this task — the changes are purely presentational (UI rendering + Telegram message strings). The existing 896 deno tests all pass, confirming no regressions in scanner logic.

## Tests run

```
$ deno test supabase/functions/ --allow-all --no-check
ok | 896 passed | 0 failed (13s)
```

## Regression check

- All 896 existing tests pass with zero failures
- The bot-scanner changes only modify Telegram message string construction — no trade logic, gate evaluation, or order execution code was altered
- The UI changes only read existing `signal_reason` JSON fields — no new API calls or data mutations
- Both Telegram message changes use optional chaining with fallback defaults, ensuring backward compatibility with older signal_reason formats that may lack the newer fields

## Open questions

1. **MobilePositionCard** — currently does NOT show the confirmation story (it's a compact view). Should it show a condensed version?
2. **TradeReplayDetails** (closed trade history) — should the confirmation story also appear on closed trade detail views?
3. The Telegram confirmed entry message is getting longer. Should we add a user preference to toggle verbose vs. compact Telegram notifications?

## Suggested PR title and description

**Title:** feat: add entry confirmation story to open trade cards and Telegram notifications

**Description:**
Surfaces the zone confirmation data that was already stored in `signal_reason` but never displayed.

**UI (ExpandedPositionCard):**
- New "Entry Confirmation" section shows what signal fired (engulfing, rejection wick, FVG, etc.), confirmation tier, displacement strength, supporting signals, zone boundaries, timeline, and watchlist origin
- Graceful fallback for market fills and limit order fills without full confirmation data

**Telegram:**
- Confirmed entry notifications now include tier, supporting signals, significance, and attempt count
- Market fill notifications now include zone type and refined entry price

No trade logic changes. All 896 tests pass.
