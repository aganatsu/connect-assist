# Task: Fix Impulse Zone Score Display & Live Price on Open Trades

## Branch: manus/impulse-score-and-live-price-fix

## Behavior changes

1. **Impulse Zone score denominator changed from /6 to /11.** The UI now correctly reflects the actual maximum possible score (fibScore 4 + htfConfluence 5 + S/R 1 + LTF 1 = 11). Previously, scores above 6 appeared as "7/6" which was confusing and incorrect.

2. **Open positions now show real-time prices on every dashboard poll.** The paper-trading `status` endpoint now calls `fetchLivePrice()` (TwelveData `/price` quote) for each unique symbol in open positions, updating `current_price` in-memory before PnL calculation. This means:
   - Individual position PnL (`+$X.XX`) updates every poll cycle (~5s) instead of every scanner cycle (~5min)
   - UNREALIZED total in the header updates accordingly
   - Prices are also persisted to DB in a fire-and-forget pattern so subsequent polls are fast even if TwelveData is temporarily slow

## Files modified

| File | Change |
|------|--------|
| `src/components/ImpulseZonePanel.tsx` | Changed hardcoded `/6` denominator to `/11` in score badge display |
| `supabase/functions/paper-trading/index.ts` | Added unconditional live price refresh block before `processEngine` check in the `status` action handler |
| `supabase/functions/paper-trading/livePriceStatus.test.ts` | New test file (6 tests) |

### Extra caution note: paper-trading/index.ts

The change adds a new block (lines 782–809) that runs BEFORE the existing `processEngine` check. It:
1. Deduplicates symbols from open positions
2. Calls `fetchLivePrice()` (already existed in this file) for each symbol
3. Updates `p.current_price` in-memory on the position objects
4. Persists to DB in fire-and-forget (non-blocking)

The existing `processEngine=true` path (SL/TP/trail/BE logic) is untouched and still runs its own `updatePositionPrices()` call when triggered. No trade execution, no broker mirroring, no gate logic affected.

## Tests added

| Test | Assertion |
|------|-----------|
| `status handler fetches live prices unconditionally for open positions` | Live price refresh block exists BEFORE processEngine check |
| `live price refresh calls fetchLivePrice for each unique symbol` | Deduplicates symbols, calls fetchLivePrice, updates in-memory, persists to DB |
| `posArr PnL uses current_price (now live) not entry_price` | calcPnl receives both entry_price and current_price |
| `unrealizedPnl is sum of posArr.pnl (derived from live prices)` | unrealizedPnl = posArr.reduce(s + p.pnl) |
| `equity returned as balance + unrealizedPnl` | Response includes equity: balance + unrealizedPnl |
| `ImpulseZonePanel uses correct max score denominator of 11` | Panel source contains `/11`, not `/6` |

## Tests run

```
$ deno test --no-check --allow-read
ok | 519 passed | 4 failed (4s)
```

All 4 failures are **pre-existing** (confirmed by running same suite on main):
- `src/test/example.test.ts` — boilerplate/environment test
- 2x candleSource failover tests — require API keys not set in sandbox
- `findImpulseLeg ETH-like` — flaky impulse zone edge case

## Regression check

1. Stashed changes → ran full suite → 7 failures (4 pre-existing + 3 from our new tests correctly failing without the fix)
2. Applied changes → ran full suite → 4 failures (all pre-existing)
3. Net: 6 new tests pass, 0 existing tests broken
4. The live price refresh is additive — it runs before the existing `processEngine` block and does not alter the engine processing path

## Open questions

1. **TwelveData rate limits:** The status endpoint is polled every ~5 seconds. With 3 open positions across 2 symbols, that's 2 API calls per poll = ~24 calls/minute. TwelveData free tier allows 8 calls/minute. If you're on a paid plan this is fine; otherwise we may need to add a 30-second TTL cache to avoid hitting rate limits.

2. **Redundant `updatePositionPrices` in processEngine block:** Now that we refresh prices unconditionally, the `updatePositionPrices()` call inside the `processEngine=true` block is redundant. Should I remove it, or leave it as a safety net?

## Suggested PR title and description

**Title:** `[impulse-score-live-price] Fix live price display + correct impulse zone score denominator`

**Description:**
Fixes two UI bugs:

1. **Impulse Zone score showed X/6 when max is actually 11** — the denominator was hardcoded from before HTF confluence scoring was added. Now correctly shows X/11.

2. **Open positions showed $0.00 PnL** — the `status` endpoint was read-only (only fetched DB values). Between scanner cycles (every 5 min), `current_price` stayed at entry price. Now fetches live quotes from TwelveData on every dashboard poll, giving real-time PnL updates.

No changes to gate logic, scoring, or trade execution paths.
