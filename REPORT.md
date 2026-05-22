# Task: Fix Market Order Look-Ahead Bias
## Branch: manus/fix-market-order-lookahead
## Behavior changes
1. **Market orders now fill at current price (analysis.lastPrice)** — previously, when `izGateMode === "hard"`, market orders used the zone's `refinedEntry` or zone midpoint as the fill price, which was look-ahead bias (recording fills at prices that hadn't been reached yet).
2. **SL sanity guard added** — trades where the market entry price is already past the SL are now rejected with status `skipped_sl_sanity`. This catches scenarios where the zone-based SL is too tight relative to the actual current price.
3. **Some trades that previously appeared profitable will now be correctly rejected** — specifically, trades where the "entry" was artificially favorable due to using zone price instead of market price. These trades would have been instant losers in real execution.

## Files modified
- `supabase/functions/bot-scanner/index.ts` — Replaced zone-price market entry logic (lines 4694-4712) with `analysis.lastPrice`. Added SL sanity guard that skips trades where entry is already past SL.
- `supabase/functions/_shared/marketOrderLookahead.test.ts` — New test file with 8 tests covering the fix.

## Caution file explanation: bot-scanner/index.ts
The change removes 10 lines of zone-entry logic for market orders and replaces with:
1. `const marketEntryPrice = analysis.lastPrice;` — single source of truth for market fills
2. An SL sanity guard (8 lines) that checks if entry is already past SL before placing the trade

This is a **behavior change that affects which trades get taken**: trades where the current price is already past the SL (which were previously hidden by the look-ahead bias) will now be correctly skipped. This is intentional — these trades would have been instant losses in live execution.

## Tests added
| Test | Assertion |
|------|-----------|
| Market entry uses lastPrice, not zone refinedEntry | entryPrice === lastPrice, not zone price |
| Market entry uses lastPrice even when zone data is available | Ignores refinedEntry and zone midpoint |
| SL sanity guard: short with entry above SL is rejected | entry >= SL → rejected |
| SL sanity guard: short with entry below SL is accepted | entry < SL → accepted |
| SL sanity guard: long with entry below SL is rejected | entry <= SL → rejected |
| SL sanity guard: long with entry above SL is accepted | entry > SL → accepted |
| SL sanity guard: entry exactly at SL is rejected for both directions | entry == SL → rejected |
| Regression: old code would have used zone price, new code uses lastPrice | XAU/USD scenario from user report: entry 4545 > SL 4544.367 → correctly rejected |

## Tests run
```
supabase/ tests: 684 passed | 34 failed (all pre-existing, same as main branch)
New test file: 8 passed | 0 failed
```

## Regression check
- Backtest engine already uses `analysis.lastPrice` for entry — no change needed there
- The 34 test failures are identical to main branch (pre-existing, unrelated to this change)
- The fix intentionally changes behavior: trades that relied on look-ahead zone pricing will now be rejected by the SL sanity guard

## Open questions
1. **Limit orders are the correct path for zone-price entries.** If you want entries at the zone's refined level, enable `limitOrderEnabled: true` in config. The limit order system already correctly waits for price to reach the level before filling. Should I enable this by default for `izGateMode: "hard"`?
2. **Existing paper positions** that were opened with look-ahead entries are still in the database. Want me to write a query to flag/close them?

## Suggested PR title and description
**Title:** Fix look-ahead bias: market orders use actual price, not zone price

**Description:**
Market orders in the bot-scanner were using the impulse zone's `refinedEntry` as the fill price when `izGateMode === "hard"`. This is look-ahead bias — the bot recorded fills at prices that hadn't been reached yet, inflating paper P&L.

Fix: Market orders always fill at `analysis.lastPrice` (the actual current price). Zone-price entries should use limit orders (`limitOrderEnabled: true`) which correctly wait for price to touch the level.

Also adds an SL sanity guard that rejects trades where the entry price is already past the SL (which the look-ahead was masking).
