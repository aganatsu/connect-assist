# Task: Fix Market Order Look-Ahead Bias
## Branch: manus/fix-market-order-lookahead
## Behavior changes
1. **Market orders now use `analysis.lastPrice` (actual current price)** instead of zone `refinedEntry` or zone midpoint. Paper trades opened via market order path will have entry prices matching the real market price at scan time, not a future zone level.
2. **SL sanity guard added**: Trades where the market entry price is already past the stop-loss (e.g., short where entry > SL) are rejected with status `skipped_sl_sanity` instead of being opened as instant losers.
3. **Auto-enable limit orders when `izGateMode === "hard"`**: When the impulse zone gate is in hard mode and a zone entry price is available, limit orders are automatically enabled even if `config.limitOrderEnabled` is false. This ensures zone-price entries correctly wait for price to reach the level (via pending_orders) instead of filling at market with look-ahead bias.
4. **Pending orders summary reflects auto-enable**: The scan result metadata now reports `pendingOrders.enabled: true` and `pendingOrders.autoEnabled: true` when limit orders are auto-enabled by hard gate mode.
5. **Cleanup migration flags affected positions**: Existing paper positions opened before the fix with impulse zone data and entry_price != current_price are flagged with `close_reason = 'lookahead_bias_flagged'`. Pending orders from before the fix are cancelled with `cancel_reason = 'lookahead_bias_cleanup'`.

## Files modified
- `supabase/functions/bot-scanner/index.ts` — (CAUTION file) Market order lastPrice fix (line 4703), SL sanity guard (lines 4706-4714), `effectiveLimitEnabled` auto-enable logic (line 4574), updated `pendingOrders` summary (lines 5285, 5302).
- `supabase/functions/_shared/marketOrderLookahead.test.ts` — 8 unit tests for the look-ahead bias fix and SL sanity guard.
- `supabase/functions/_shared/effectiveLimitEnabled.test.ts` — 10 unit tests for the auto-enable limit order logic and pendingOrders summary.
- `supabase/migrations/20260522100000_flag_lookahead_paper_positions.sql` — SQL migration to flag open paper positions and cancel pending orders affected by look-ahead pricing.
- `REPORT.md` — This report.

## Caution file explanation: bot-scanner/index.ts
**Commit 1 (market order fix):** Removed zone-entry logic for market orders, replaced with `const marketEntryPrice = analysis.lastPrice`. Added SL sanity guard (8 lines) that rejects trades where entry is already past SL.

**Commit 2 (auto-enable limit orders):** Added `effectiveLimitEnabled` variable (1 line) that OR's `config.limitOrderEnabled` with `(izGateMode === "hard" && !!limitEntry)`. Changed the limit-order-path condition from `config.limitOrderEnabled && limitEntry` to `effectiveLimitEnabled && limitEntry`. Updated pendingOrders summary to use the same condition.

These are **behavior changes that affect which trades get taken**: (a) trades where current price is past SL are now skipped, (b) hard-gate trades with zone entries now go through the limit order path (pending_orders) instead of market-filling at current price.

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

## Tests run
```
$ deno test supabase/ --no-check
FAILED | 694 passed | 34 failed (8s)
```
All 34 failures are pre-existing (identical to main branch). 18 new tests all pass.

## Regression check
- The `effectiveLimitEnabled` logic is additive: only auto-enables in hard gate + zone entry scenario. All other paths unchanged.
- Backtest engine already uses `analysis.lastPrice` — no change needed.
- The SQL migration uses safe WHERE clauses with date cutoff and only flags (does not auto-close).
- The pendingOrders summary adds `autoEnabled` field — existing consumers checking `.enabled` see same value for previously-enabled configs.

## Open questions
1. **Should flagged positions be auto-closed?** The migration flags them with `close_reason = 'lookahead_bias_flagged'` but does not close. User can review and decide.
2. **UI indicator for auto-enabled limit orders?** Dashboard could show "Limit orders auto-enabled (hard gate mode)" in scan results.
3. **bot-config validation?** Should the config UI show a warning or auto-check the limit order toggle when hard gate is selected?

## Suggested PR title and description
**Title:** fix: market order look-ahead bias + auto-enable limit orders for hard IZ gate

**Description:**
Fixes look-ahead bias where market orders used zone `refinedEntry` price instead of actual current price (`analysis.lastPrice`). Adds SL sanity guard that rejects trades where entry is already past the SL. Auto-enables limit orders when `izGateMode === "hard"` to ensure zone-price entries wait for price to reach the level. Includes cleanup migration to flag affected paper positions.

Changes:
- Market orders always fill at `analysis.lastPrice` (no more free look-ahead profit)
- SL sanity guard rejects instant-loss trades (`skipped_sl_sanity` status)
- `effectiveLimitEnabled` auto-enables limit orders in hard IZ gate mode
- Scan result summary reflects auto-enable state
- SQL migration flags pre-fix positions for review
- 18 new unit tests
