# SMC management-loop telemetry — findings

**Instrumentation only.** No fetch was added, removed, reordered or
deduplicated. No strategy rule, execution path, cadence, table or IPO component
was changed. Window: 33 management invocations, 2026-09-22 15:48–16:21 UTC.

---

## 0. Headline, and a correction

**The management loop makes exactly 7 provider fetches per minute, every
minute, and 6 of them are daily bars.**

```
provider fetches / invocation    7   (min 7, median 7, max 7 over 33 runs)
cache hits / invocation          0
repeated keys / invocation       0
management actions taken         0   in all 33 runs
projected                    10,080 / day
```

**My earlier inference was wrong.** The study attributed ~23,400/day to "16
pending orders × 60/hour". Two errors: the count was raw table rows — **all 21
`pending_orders` are `expired`, so there are zero active** — and the mechanism
is not per-order fetching at all. The real consumer is a currency-conversion
rate map that nothing guards.

```
reason                          calls    per run    per day
rate_map                          198          6      8,640   ← 86%
open_position_price_refresh        33          1      1,440
```

`rate_map` fetches **1-day bars for six FX pairs on every single invocation**,
inside a bare `try` with no condition of any kind:

```ts
const RATE_PAIRS = ["USD/JPY","GBP/USD","AUD/USD","NZD/USD","USD/CAD","USD/CHF"];
try {
  const rateFetches = await Promise.all(RATE_PAIRS.map(p => cachedFetch(p, "1d", "5d", "rate_map")));
```

A daily bar closes once a day. This refreshes it 1,440 times a day.

---

## 1. The six questions, answered from measurement

**Does each pending order cause its own fetch every minute?**
**Not observable in this window — there were no active pending orders.** All 21
rows are `expired`. Structurally the pending loop calls `cachedFetch` per order,
and that is deduplicated by `symbol|interval` within the invocation, so N orders
on one symbol and timeframe cost one fetch, not N. To confirm empirically the
telemetry needs a window with live pending orders; it is already tagged
(`pending_fill_check`, `pending_thesis_*`, `pending_confirmation`) and will
record it when one occurs.

**Are multiple positions on the same symbol/timeframe independently fetching?**
**No.** `distinctKeys == providerFetches` in all 33 invocations and
`repeatedKeys` was empty in all 33. The per-invocation `scanCache` already
collapses duplicates perfectly. There is no within-invocation waste to remove.

**Are fetches happening even when no management decision can change?**
**Yes — essentially all of them.** `managementActions` was **0 in every one of
the 33 invocations**, while 231 provider fetches were made. The `rate_map` block
in particular is unconditional: it does not consult open positions, pending
orders, or whether a rate is even needed.

The stronger form of this test — invocations with nothing open *and* nothing
pending — did not occur: one position was open throughout, so
`idleInvocations` is 0. The counter exists and will catch that case.

**Can the loop group work by symbol/timeframe without changing behaviour?**
**It already does, within an invocation.** Zero repeats, zero hits, one fetch
per distinct key. The waste is entirely **across** invocations: the same seven
keys, every minute, for 33 minutes.

```
USD/JPY|15m  33      GBP/USD|1d  33      USD/CAD|1d  33
USD/JPY|1d   33      AUD/USD|1d  33      USD/CHF|1d  33
NZD/USD|1d   33
```

**Can management reuse a bar already fetched in the same invocation?**
**It already does**, and there is nothing left to reuse — every key is requested
exactly once per invocation.

**Can it safely act only when a new relevant bar or market condition exists?**
**Yes for the 15m position refresh; for `rate_map` it depends on a question the
telemetry cannot answer — see §3.** That is the one place where the obvious
optimisation may not be behaviour-neutral.

---

## 2. Measured usage, and how the totals moved

Management loop, direct measurement:

| | per invocation | per day (1,440 runs) |
|---|---|---|
| `rate_map` (6 × 1d) | 6 | **8,640** |
| `open_position_price_refresh` (1 × 15m) | 1 | **1,440** |
| pending-order paths | 0 (none active) | 0 in this window |
| **total** | **7** | **10,080** |

Credit ledger over the same 30 minutes, for cross-check:

| caller | /min | /day |
|---|---|---|
| `bot-scanner` | 11.0 | 15,794 |
| `ipo-paper-runner` | 0.2 | 288 |
| `outcome-tracker` | 0.03 | 48 |
| total | 11.2 | 16,130 |

Management is 7.0/min of `bot-scanner`'s 11.0/min; full scans account for the
remaining ~4/min.

**Total spend has fallen from 19.8/min to 11.2/min since the earlier audit**,
without any change by me. The difference is the pending-order paths going quiet
as all 21 orders expired. That implies **the pending loop was costing roughly
8–9 fetches/minute (~12,000/day) when orders were live** — which is real, is not
currently visible, and will return the moment orders are placed again.

So the honest figure is a range: **~16,000/day with no pending orders, ~28,000/day
with a full pending book.**

**Also resolved:** `outcome-tracker` **is** running and does reach the provider —
it appears in the ledger with 1 request. Its absence from the earlier window was
simply that it runs hourly and often has nothing to resolve. That closes one of
the two open questions from the audit; `zone-confirmation-scanner` still has not
appeared.

---

## 3. The one place "obvious" is not safe

`rate_map` builds a currency-conversion table from **the last close of a 1-day
series**. With `outputsize=5` and `order=ASC`, the final element is **today's
still-forming daily bar**, whose `close` is the current price. So this may be
deliberately using the daily bar as a **live price proxy**, not as yesterday's
close.

If that is the intent, then caching it "until the next daily close" would freeze
the conversion rate for up to 24 hours and **would change lot sizing and P&L
conversion** — a real behaviour change wearing the costume of a cache fix.

Two readings, and the telemetry cannot distinguish them:

- *It wants a live rate.* Then the fix is a cheaper live-price source, not a
  longer cache, and the saving is smaller.
- *It wants a daily reference rate.* Then caching to the bar boundary is free
  and saves 8,634 requests/day outright.

**This must be settled by reading `getQuoteToUSDRate`'s intent before anything
is changed.** It is the single highest-value question left, because it governs
86% of management spend.

---

## 4. What the instrumentation is

- `_shared/smcMgmtTelemetry.ts` — pure: summarise, accumulate, parse. A test
  asserts it contains no client, fetch, env access or table reference.
- `bot-scanner` — `cachedFetch` wrapped to record `(symbol, interval, reason,
  cacheHit, bars, ms)`. The wrapper returns `scanCache`'s own promise chain; a
  test forbids it containing any control flow, so it can only observe. Ten
  management-path call sites carry a `reason` tag.
- `candleSource` — new `peekThrottleStats()`. `resetThrottleStats` is
  read-and-clear and is called once per full scan; a cycle that returns early
  must not call it or it silently steals counts the next scan should report.
  `refused` has no non-destructive reader, so management reports it as 0 rather
  than stealing it — the scan log stays the source of truth for refusals.
- Sink: one namespaced `kv_cache` key with a 60-entry ring. The writer never
  throws; the cycle's trading work is already committed by the time it runs.

Two pre-existing tests asserted exact `cachedFetch(...)` call text and broke on
the added tag. They were widened, not deleted — they guard real properties. My
first widening was itself wrong (`[a-z_]+` does not match the digits in
`pending_thesis_m15`).

---

## 5. Proposed next steps — not implemented

In order, each independently verifiable:

1. **Settle §3.** Read `getQuoteToUSDRate` and decide whether `rate_map` needs a
   live rate or a daily reference. Nothing else should be touched first, because
   the answer sizes everything.
2. **Guard `rate_map` on need.** It runs even when no position and no pending
   order exists, and a conversion rate with nothing to convert is pure waste.
   This is behaviour-neutral by inspection — the map is only read by lot sizing
   and P&L conversion — but should be confirmed against its readers.
3. **Bar-aligned reuse for the 15m position refresh.** 1,440/day for a series
   that produces 96 bars/day. Bounded by the open-position symbol set, so the
   saving is small in absolute terms but the risk is near zero.
4. **Re-measure with live pending orders.** The pending paths are tagged but
   unexercised. No decision about them should be made on this window.

**Not proposed:** grouping (already effective within an invocation), TTL changes,
persistent bar storage, cadence changes, WebSocket. Those remain out of scope
per your direction, and §1 shows grouping in particular would buy nothing.
