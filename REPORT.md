# Task: Fix break-even SL using paper trade price instead of broker fill price

## Branch: manus/fix-be-broker-fill-price

## Behavior changes

1. **Break-even SL now uses actual broker fill price** — When a trade is mirrored to MT4/MT5 (MetaAPI) or OANDA, the actual execution fill price is stored in `signal_reason.brokerEntryPrice`. All subsequent BE calculations (R-based activation, max-hold BE, session-end BE) and R-multiple calculations use this broker price instead of the paper entry price. This means the BE SL sent to the broker will now correctly reflect where the broker actually filled, not where the scanner's market data said the price was.

2. **Trailing stop and R-multiple calculations also use broker fill price** — The `computeAdaptiveTrail()` call and R-multiple calculation in `scannerManagement.ts` now use the broker fill price when available, ensuring trailing stop tightening and profit calculations are accurate relative to the actual execution price.

3. **No change for paper-only trades** — Trades that are not mirrored to a broker (paper mode) continue to use `pos.entry_price` as before. Legacy positions without `brokerEntryPrice` in their `signal_reason` also fall back to the paper entry price.

## Files modified

- `supabase/functions/_shared/scannerManagement.ts` — Added `brokerEntryPrice` resolution logic: reads from `signalData.brokerEntryPrice` when available, falls back to `pos.entry_price` for paper/legacy trades. Renamed original parse to `paperEntryPrice` for clarity.
- `supabase/functions/bot-scanner/index.ts` — (1) Added `brokerFillPrice` variable in the mirror loop. (2) Extract fill price from MetaAPI deal history (`deal.price`). (3) Extract fill price from OANDA `orderFillTransaction.price`. (4) After successful mirror, persist `brokerEntryPrice` into the position's `signal_reason` JSON alongside `mirrored_connection_ids`.
- `supabase/functions/_shared/brokerFillPriceBE.test.ts` — New test file with 6 tests.

### Extra caution notes (per project rules):

**bot-scanner/index.ts:** Added broker fill price extraction in the MetaAPI deal history loop (which already existed for commission auto-detect) and in the OANDA fill transaction block (also already existed for commission). After the mirror loop, when persisting `mirrored_connection_ids`, we now also read-modify-write the `signal_reason` JSON to inject `brokerEntryPrice`. This is a read-then-update pattern on the same row that was just inserted moments earlier in the same function execution, so there's no race condition risk. The fill price is only stored when `brokerFillPrice != null` (i.e., when at least one broker successfully filled and returned a price).

**scannerManagement.ts:** Changed `const entryPrice = parseFloat(pos.entry_price)` to first check `signalData.brokerEntryPrice`. The variable `entryPrice` is used in all downstream calculations (BE, trailing, R-multiple, management floor). This is the core fix — all three BE paths (lines ~418, ~457, ~767) and the trailing/R-multiple paths automatically use the correct price because they all reference `entryPrice`.

## Tests added

1. `BE activation uses brokerEntryPrice instead of paper entry_price` — Verifies BE SL is calculated from broker fill (1.08520) not paper entry (1.08500)
2. `BE activation falls back to paper entry_price when brokerEntryPrice is absent` — Verifies legacy/paper trades still work
3. `Short trade BE uses brokerEntryPrice correctly` — Verifies short direction BE uses broker fill
4. `R-multiple calculation uses brokerEntryPrice` — Verifies R is computed from broker fill (prevents premature/late BE activation)
5. `Invalid brokerEntryPrice (NaN) falls back to paper entry` — Edge case: corrupted data
6. `brokerEntryPrice=null falls back to paper entry` — Edge case: explicit null

## Tests run

```
ok | 956 passed | 0 failed (14s)
```

All 956 tests pass (950 existing + 6 new).

## Regression check

- The `entryPrice` variable is only different when `signalData.brokerEntryPrice` is present and valid. For all existing paper-only positions (which have no `brokerEntryPrice` in their `signal_reason`), the behavior is identical to before — `entryPrice` resolves to `parseFloat(pos.entry_price)` via the fallback path.
- Test 2 explicitly verifies this fallback behavior.
- The 950 existing tests all pass unchanged, confirming no regression in scoring, gates, or other management logic.

## Open questions

1. **Existing live positions:** Positions that were already opened and mirrored before this fix will NOT have `brokerEntryPrice` in their `signal_reason`. They will continue using the paper entry price for BE. Should I write a backfill script that queries MetaAPI for the actual fill price of currently-open positions and patches their `signal_reason`?

2. **Limit fill path (zone confirmations):** The limit fill mirror at line ~3010 doesn't fetch deal history, so it can't extract the fill price. However, limit orders fill at the requested price (no slippage), so `actualFillPrice` (which is already stored as `entry_price`) should be accurate. Confirm this is acceptable.

3. **Multiple brokers with different fills:** Currently `brokerFillPrice` takes the first successful broker's fill price. If you have multiple broker connections that fill at different prices, only the first is stored. Is this acceptable, or should we store per-connection fill prices?

## Suggested PR title and description

**Title:** fix: use actual broker fill price for break-even SL calculations

**Description:**
Fixes a bug where break-even stop-loss was calculated using the paper trade entry price instead of the actual broker execution price. When there's slippage between the scanner's market price and the broker's fill, the BE SL was being placed at the wrong level — potentially getting stopped out prematurely or leaving money on the table.

Changes:
- Extract and store actual fill price from MetaAPI (deal.price) and OANDA (orderFillTransaction.price) after successful mirror
- Store as `brokerEntryPrice` in position's `signal_reason` JSON (no schema migration needed)
- `scannerManagement.ts` now uses `brokerEntryPrice` for all BE/trailing/R-multiple calculations when available
- Falls back to paper entry price for paper-only trades and legacy positions
- 6 new tests covering all scenarios (broker price, fallback, short, invalid, null)
- 956/956 tests passing
