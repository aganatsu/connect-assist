# Task: Zone Confirmation Entry
## Branch: manus/zone-confirmation-entry

## Behavior changes

1. **Pending orders no longer fill immediately when price touches the zone.** Instead, they transition to `"awaiting_confirmation"` status and wait for a 5-minute CHoCH (Change of Character) signal before entering.
2. **Entry price is now the live price at CHoCH confirmation**, not the static zone level. This eliminates look-ahead bias entirely.
3. **If price leaves the zone without confirming**, the order resets to `"pending"` status and `confirmation_attempts` is incremented. The bot waits for the next zone approach.
4. **If the impulse leg is broken** (price exceeds the impulse origin), the order is cancelled with reason `"impulse_broken_during_confirmation"`.
5. **Telegram notifications now show confirmation details**: type (bearish/bullish CHoCH), displacement strength, and supporting signals.
6. **Scan result summary includes `awaitingConfirmation` count** in the pendingOrders object.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/zoneConfirmation.ts` | **NEW** — Core helper: `detectZoneConfirmation()`, `isPriceInZone()`, `isImpulseBroken()`, `formatConfirmationSummary()`. Uses existing `analyzeMarketStructure()` from smcAnalysis.ts to detect CHoCH on 5m candles. |
| `supabase/functions/_shared/zoneConfirmation.test.ts` | **NEW** — 26 tests covering CHoCH detection, zone boundary logic, impulse invalidation, format helpers, and state machine integration. |
| `supabase/functions/bot-scanner/index.ts` | **MODIFIED** — Replaced the immediate-fill logic in the pending order loop with a two-stage state machine: `pending → awaiting_confirmation → filled`. Added 5m candle fetch, CHoCH detection call, zone exit reset, and impulse invalidation. Updated Telegram notifications and signal_reason metadata. |
| `supabase/migrations/20260522150000_add_confirmation_columns_to_pending_orders.sql` | **NEW** — Adds `zone_touch_time` (timestamptz) and `confirmation_attempts` (integer) columns to `pending_orders`. Creates index for efficient status queries. |

## Caution file explanation: bot-scanner/index.ts

The pending order processing section (lines ~2570-2900) was substantially rewritten. The old flow was:

```
price touches zone → immediate fill at limit price
```

The new flow is:

```
price touches zone → transition to "awaiting_confirmation"
  → fetch 5m candles → run analyzeMarketStructure → check for CHoCH
    → if CHoCH found: fill at live price (confirmationSignal.price)
    → if price leaves zone: reset to "pending", increment attempts
    → if impulse broken: cancel order
```

Key design decisions:
- `detectZoneConfirmation()` is a pure function that takes candles and returns a signal or null. It does NOT modify state.
- The state machine lives entirely in the pending order loop. State is persisted via `status` column and `zone_touch_time`/`confirmation_attempts` columns.
- 5m candles are fetched using the existing `cachedFetch()` infrastructure with `"5min"` interval.
- The CHoCH detection reuses `analyzeMarketStructure()` from smcAnalysis.ts (not modified) — it just filters the structure breaks for the correct direction and recency.

## Tests added

| # | Test | Assertion |
|---|------|-----------|
| 1 | `detectZoneConfirmation: returns bearish_choch for short direction` | Bearish CHoCH detected in bearish reversal pattern |
| 2 | `detectZoneConfirmation: returns bullish_choch for long direction` | Bullish CHoCH detected in bullish reversal pattern |
| 3 | `detectZoneConfirmation: returns null when no CHoCH present` | No false positives in steady uptrend |
| 4 | `detectZoneConfirmation: returns null for wrong direction` | Bearish CHoCH not returned when looking for bullish |
| 5 | `detectZoneConfirmation: respects zoneTouchIndex filter` | Only considers CHoCHs after zone touch |
| 6 | `detectZoneConfirmation: returns null for insufficient candles` | Graceful handling of < 5 candles |
| 7 | `detectZoneConfirmation: respects requireCloseBased config` | Close-based filter applied |
| 8 | `detectZoneConfirmation: respects minDisplacement config` | Displacement threshold filter applied |
| 9 | `isPriceInZone: returns true when price is inside zone (long)` | Zone boundary detection for longs |
| 10 | `isPriceInZone: returns true when price is inside zone (short)` | Zone boundary detection for shorts |
| 11 | `isPriceInZone: returns false when price is above zone (long)` | Rejects price above zone for longs |
| 12 | `isPriceInZone: returns false when price is below zone (short)` | Rejects price below zone for shorts |
| 13 | `isPriceInZone: returns true at zone edge (exact boundary)` | Edge case: exact boundary |
| 14 | `isPriceInZone: includes buffer for near-zone prices` | 5% buffer zone tolerance |
| 15 | `isPriceInZone: returns false when clearly outside buffer` | Rejects clearly outside prices |
| 16 | `isImpulseBroken: returns false when price is within impulse range (short)` | Valid impulse for shorts |
| 17 | `isImpulseBroken: returns true when price exceeds impulse origin (short)` | Broken impulse for shorts |
| 18 | `isImpulseBroken: returns false when price is within impulse range (long)` | Valid impulse for longs |
| 19 | `isImpulseBroken: returns true when price exceeds impulse origin (long)` | Broken impulse for longs |
| 20 | `isImpulseBroken: returns false at exact impulse boundary` | Edge case: exact boundary |
| 21 | `formatConfirmationSummary: formats bearish CHoCH correctly` | Output format verification |
| 22 | `formatConfirmationSummary: handles empty supporting signals` | Graceful empty array handling |
| 23 | `State machine: zone touch detection triggers confirmation hunt` | isPriceInZone + isImpulseBroken integration |
| 24 | `State machine: price leaving zone resets to pending` | Zone exit detection |
| 25 | `State machine: impulse broken cancels order` | Impulse invalidation |
| 26 | `DEFAULT_ZONE_CONFIRMATION_CONFIG has sensible defaults` | Config sanity check |

## Tests run

```
$ deno test --allow-all --no-check
FAILED | 776 passed | 2 failed (12s)
```

The 2 failures are pre-existing:
1. `./src/test/example.test.ts` — uncaught error (test infrastructure issue, exists on main)
2. `findImpulseLeg — ETH-like bearish impulse` — pre-existing impulseZoneEngine test failure

All 26 new tests pass. No regressions introduced.

## Regression check

1. **No existing fill logic was removed** — the code path for immediate fills is now gated behind the confirmation state machine. Orders that were already in `"pending"` status will transition to `"awaiting_confirmation"` on next zone touch, then fill on CHoCH.
2. **Existing pending order expiry/cancellation logic is preserved** — expiry checks run before the confirmation logic.
3. **Broker mirroring is unchanged** — once a confirmed fill happens, the same broker mirror code executes as before.
4. **The 4 pre-existing type errors** (equalHighsLowsSensitivity, liquidityPoolMinTouches) are unrelated to this change and exist on main.
5. **smcAnalysis.ts is NOT modified** — the CHoCH detection reuses the existing `analyzeMarketStructure()` function.

## Open questions

1. **Migration timing**: The `zone_touch_time` and `confirmation_attempts` columns need to be added to the production database before deploying this code. Should I apply the migration now or wait for your approval?
2. **Existing pending orders**: Orders currently in `"pending"` status will naturally transition to the new flow on their next scan cycle. No manual intervention needed. Confirm this is acceptable?
3. **5m candle availability**: The bot fetches 5m candles via MetaApi/TwelveData. If 5m data is unavailable for a pair, the confirmation check is skipped and the order stays in `"awaiting_confirmation"` until data becomes available. Should there be a fallback (e.g., use 15m CHoCH instead)?
4. **requireCloseBased default**: Currently set to `true` (only close-based CHoCHs count). This is more conservative but may miss some valid entries. Want me to change to `false` (wick-based also counts)?

## Suggested PR title and description

**Title:** feat: zone-triggered confirmation entry (CHoCH on 5m before fill)

**Description:**
Replaces immediate limit-order fills with a two-stage confirmation entry system:

1. When price reaches the impulse zone, the pending order transitions to `"awaiting_confirmation"`
2. The bot fetches 5m candles and watches for a CHoCH (Change of Character) in the expected direction
3. Only when CHoCH confirms does the order fill — at the live price, not the static zone level
4. If price leaves the zone without confirming, the order resets and waits for the next approach
5. If the impulse leg is broken (price exceeds origin), the order is cancelled

This eliminates look-ahead bias and ensures entries are backed by actual reversal confirmation on the lower timeframe.

**Breaking changes:** None. Existing pending orders will naturally adopt the new flow.
**Migration required:** `20260522150000_add_confirmation_columns_to_pending_orders.sql`
