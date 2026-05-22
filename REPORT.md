# Task: Fix Market Order Look-Ahead Bias
## Branch: manus/fix-market-order-lookahead
## Behavior changes
1. **Market orders now use `analysis.lastPrice` (actual current price)** instead of zone `refinedEntry` or zone midpoint. Paper trades opened via market order path will have entry prices matching the real market price at scan time, not a future zone level.
2. **SL sanity guard added**: Trades where the market entry price is already past the stop-loss (e.g., short where entry > SL) are rejected with status `skipped_sl_sanity` instead of being opened as instant losers.
3. **Auto-enable limit orders when `izGateMode === "hard"`**: When the impulse zone gate is in hard mode and a zone entry price is available, limit orders are automatically enabled even if `config.limitOrderEnabled` is false. This ensures zone-price entries correctly wait for price to reach the level (via pending_orders) instead of filling at market with look-ahead bias.
4. **Pending orders summary reflects auto-enable**: The scan result metadata now reports `pendingOrders.enabled: true` and `pendingOrders.autoEnabled: true` when limit orders are auto-enabled by hard gate mode.
5. **Cleanup migration flags affected positions**: Existing paper positions opened before the fix with impulse zone data and entry_price != current_price are flagged with `close_reason = 'lookahead_bias_flagged'`. Pending orders from before the fix are cancelled with `cancel_reason = 'lookahead_bias_cleanup'`.
6. **Limit order fills now use live price (candle close) at detection time**: Previously, `actualFillPrice` used `Math.max/min(candle extreme, limitPrice)` which always resolved to the static limit price. Now it uses `currentPrice` (the candle close = most recent tick), simulating realistic broker fills where the entry is at the market price when the zone is touched.

## Files modified
- `supabase/functions/bot-scanner/index.ts` — (CAUTION file) Market order lastPrice fix (line 4703), SL sanity guard (lines 4706-4714), `effectiveLimitEnabled` auto-enable logic (line 4574), updated `pendingOrders` summary (lines 5285, 5302), limit order fill pricing fix (line 2615: `actualFillPrice = currentPrice`).
- `supabase/functions/_shared/marketOrderLookahead.test.ts` — 8 unit tests for the look-ahead bias fix and SL sanity guard.
- `supabase/functions/_shared/effectiveLimitEnabled.test.ts` — 10 unit tests for the auto-enable limit order logic and pendingOrders summary.
- `supabase/functions/_shared/limitOrderFillPrice.test.ts` — 9 unit tests for the limit order live-fill pricing fix.
- `supabase/migrations/20260522100000_flag_lookahead_paper_positions.sql` — SQL migration to flag open paper positions and cancel pending orders affected by look-ahead pricing.
- `REPORT.md` — This report.

## Caution file explanation: bot-scanner/index.ts
**Commit 1 (market order fix):** Removed zone-entry logic for market orders, replaced with `const marketEntryPrice = analysis.lastPrice`. Added SL sanity guard (8 lines) that rejects trades where entry is already past SL.

**Commit 2 (auto-enable limit orders):** Added `effectiveLimitEnabled` variable (1 line) that OR's `config.limitOrderEnabled` with `(izGateMode === "hard" && !!limitEntry)`. Changed the limit-order-path condition from `config.limitOrderEnabled && limitEntry` to `effectiveLimitEnabled && limitEntry`. Updated pendingOrders summary to use the same condition.

**Commit 3 (limit fill pricing):** Changed `actualFillPrice` from `Math.max/min(lastCandle extreme, entryPrice)` to `currentPrice` (candle close). Updated `limitOrderOrigin` metadata to track both `limitPrice` and `actualFillPrice`. Updated Telegram notification and trade reasoning summary to show actual fill price.

These are **behavior changes that affect which trades get taken**: (a) trades where current price is past SL are now skipped, (b) hard-gate trades with zone entries now go through the limit order path (pending_orders) instead of market-filling at current price, (c) limit order fills now record the live market price instead of the static limit price.

## Tests added
| # | Test | Assertion |
|---|------|----------|
| 1 | Market entry uses lastPrice, not zone refinedEntry | entryPrice === lastPrice |
| 2 | Market entry uses lastPrice even when zone data is available | Ignores refinedEntry and midpoint |
| 3 | SL sanity guard: short with entry above SL is rejected | entry >= SL → rejected |
| 4 | SL sanity guard: short with entry below SL is accepted | entry < SL → accepted |
| 5 | SL sanity guard: long with entry below SL is rejected | entry <= SL → rejected |
| 6 | SL sanity guard: long with entry above SL is accepted | entry > SL → accepted |
| 7 | SL sanity guard: entry exactly at SL is rejected | entry == SL → rejected both dirs |
| 8 | Regression: XAU/USD scenario correctly rejected | entry 4545 > SL 4544.367 for short |
| 9 | effectiveLimitEnabled: auto-enables for hard+limitEntry | true when hard gate + zone |
| 10 | effectiveLimitEnabled: no auto-enable without limitEntry | false when hard gate + no zone |
| 11 | effectiveLimitEnabled: no auto-enable for soft mode | false for soft gate |
| 12 | effectiveLimitEnabled: no auto-enable for off mode | false for off gate |
| 13 | effectiveLimitEnabled: respects explicit config=true | true regardless of gate mode |
| 14 | effectiveLimitEnabled: false when all disabled | false for soft/off + config off |
| 15 | pendingOrders summary: enabled for explicit config | true for config.limitOrderEnabled |
| 16 | pendingOrders summary: enabled for hard gate | true for izGateMode=hard |
| 17 | pendingOrders summary: disabled otherwise | false for soft/off + config off |
| 18 | Regression: hard gate + zone → limit order path | Documents XAU/USD behavior change |
| 19 | Fill detection: long fills when candle low touches limit | low <= limit → fill |
| 20 | Fill detection: long does NOT fill when low above limit | low > limit → no fill |
| 21 | Fill detection: short fills when candle high touches limit | high >= limit → fill |
| 22 | Fill detection: short does NOT fill when high below limit | high < limit → no fill |
| 23 | New fill price: uses live price, not limit price | fill === currentPrice |
| 24 | New fill price: XAU/USD short scenario | live 4543.50 ≠ limit 4541.56 |
| 25 | New fill price: EUR/USD long scenario | live 1.08220 ≠ limit 1.08250 |
| 26 | New fill price: exact touch edge case | fill === limit when equal |
| 27 | Old fill price always resolves to limit (proving the bug) | Math.max/min always = limit |

## Tests run
```
$ deno test supabase/ --no-check
FAILED | 704 passed | 33 failed (8s)
```
All 33 failures are pre-existing (identical to main branch). 27 new tests all pass.

## Regression check
- The `effectiveLimitEnabled` logic is additive: only auto-enables in hard gate + zone entry scenario. All other paths unchanged.
- Backtest engine already uses `analysis.lastPrice` — no change needed.
- The SQL migration uses safe WHERE clauses with date cutoff and only flags (does not auto-close).
- The pendingOrders summary adds `autoEnabled` field — existing consumers checking `.enabled` see same value for previously-enabled configs.
- Limit fill pricing: the fill detection logic (candle low/high touch check) is unchanged. Only the price written to `entry_price` changed from static limit to live tick. The `trigger_price` column still stores the original limit price for audit trail.

## Open questions
1. **Should flagged positions be auto-closed?** The migration flags them with `close_reason = 'lookahead_bias_flagged'` but does not close. User can review and decide.
2. **UI indicator for auto-enabled limit orders?** Dashboard could show "Limit orders auto-enabled (hard gate mode)" in scan results.
3. **bot-config validation?** Should the config UI show a warning or auto-check the limit order toggle when hard gate is selected?

## Suggested PR title and description
**Title:** fix: realistic fill pricing for both market and limit orders

**Description:**
Fixes unrealistic fill pricing across both order paths:

1. **Market orders** used zone `refinedEntry` instead of actual current price — now fill at `analysis.lastPrice`.
2. **Limit orders** used `Math.max/min(candle extreme, limitPrice)` which always resolved to the static limit price — now fill at `currentPrice` (live tick at detection time).
3. **SL sanity guard** rejects trades where entry is already past the SL.
4. **Auto-enable limit orders** when `izGateMode === "hard"` to ensure zone entries go through pending_orders.
5. **Cleanup migration** flags pre-fix paper positions for review.

Changes:
- Market orders always fill at `analysis.lastPrice` (no more free look-ahead profit)
- Limit orders fill at live price when zone is touched (not static limit price)
- SL sanity guard rejects instant-loss trades (`skipped_sl_sanity` status)
- `effectiveLimitEnabled` auto-enables limit orders in hard IZ gate mode
- Scan result summary reflects auto-enable state
- SQL migration flags pre-fix positions for review
- 27 new unit tests
