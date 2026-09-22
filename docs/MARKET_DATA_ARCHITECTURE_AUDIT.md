# Market-data architecture audit — SMC and IPO

**Audit only. No code, cron, table, provider or strategy behaviour was changed.**
Dated 2026-09-22. Measurements are from the live project
`rvouzhacxqlbetwcttoe` unless marked as inferred.

---

## 0. The three findings that matter most

**1. There is no cross-strategy duplicate fetch to eliminate.** SMC and IPO do
not share a single `(symbol, timeframe)` pair today. The overlap matrix in §3 is
empty in its last column. Any WebSocket case must therefore be argued on
duplication *within* SMC, on latency, or on rate-limit headroom — not on
SMC/IPO overlap, which is the intuition worth discarding early.

**2. The duplication that exists is inside SMC, and it is large.** Measured
**19.8 TwelveData requests/minute sustained, ~28,500/day**, against a 50/min
enforced cap. IPO is 0.2/min. SMC is 99% of provider spend.

**3. Two latent defects found while tracing, neither introduced by IPO:**

- The candle cache key is `symbol:interval` and **excludes the requested
  depth**. A cached 300-bar entry satisfies an 800-bar request and returns 300
  bars silently (§4.1). ~~Every SMC caller mixes depths on the same key.~~
  **CORRECTED 2026-09-22 — that last sentence was wrong.** `bot-scanner` derives
  depth from the interval (`CANDLE_LIMITS[interval] ?? 300`), so the scheduled
  path can never hit a shallower entry than it asked for. Only `smc-analysis`,
  which is on-demand and not scheduled, mixes depths on one key. See
  `docs/SMC_CACHE_DEPTH_STUDY.md`.
- **`POLYGON_API_KEY` is not configured.** The documented three-provider
  failover is two, and for any caller that passes `skipBroker` or no broker
  connection — which is SMC's scanner and all of IPO — it is TwelveData with
  **no fallback at all** (§4.4).

Neither is in scope to fix here. Both change what any WebSocket design has to
account for.

---

## 1. SMC data path

### Scheduler

| job | cadence | target |
|---|---|---|
| `bot-scanner-every-5min` | `*/5 * * * *` | `bot-scanner` (`action: scan`) |
| `manage-positions-1min` | `* * * * *` | `bot-scanner` (`action: manage`) |
| `zone-confirmation-scanner-every-minute` | `* * * * *` | `zone-confirmation-scanner` |
| `outcome-tracker-hourly` | `15 * * * *` | `outcome-tracker` |

So **36 `bot-scanner` invocations per 30 minutes** (6 scans + 30 manages).

### Fetch path

```
bot-scanner/index.ts  fetchCandles(symbol, interval)
  └─ fetchCandlesWithFallback({ limit: CANDLE_LIMITS[interval] ?? 300,
                                brokerConn: _scanBrokerConn,
                                skipBroker: true })
       └─ _shared/candleSource.ts
            in-memory cache → [MetaAPI skipped: skipBroker] → TwelveData → [Polygon: unconfigured]
```

- **Endpoint:** `GET https://api.twelvedata.com/time_series` with
  `symbol, interval, outputsize=<limit>, order=ASC, timezone=UTC`.
  `timezone=UTC` is load-bearing — `mapTwelveDataValues` appends `Z`
  unconditionally, so dropping it would mislabel every bar.
- **Depth:** `CANDLE_LIMITS = { "4h": 800 }`, otherwise **300**.
  `smc-analysis` (not on cron) uses **800** and a variable `barsBack`.
- **`skipBroker: true`** — the scanner deliberately bypasses MetaAPI because
  region probing exceeds the runtime budget. The consequence is that its only
  provider is TwelveData.

### Symbols and timeframes

Live `bot_configs.config_json`:

```
instruments.enabled           EUR/USD GBP/USD USD/JPY USD/CAD NZD/USD AUD/USD USD/CHF   (7)
instruments.allowedInstruments  EUR/USD: true — 11 others explicitly false
activeStyle                   null  →  entryTimeframe "15min", htfTimeframe "1day"
```

**Two lists disagree and I could not resolve which governs *scanning* from
configuration alone.** The measurement settles it by arithmetic: 593 requests /
36 invocations ≈ **16.5 fetches per invocation**, which is consistent with ~7
symbols × ~2 timeframes and inconsistent with 1 symbol. So `enabled` drives the
scan and `allowedInstruments` most likely gates *trading*, not data. Flagged
rather than asserted — it is an SMC config question, not a market-data one.

### Measured spend

Rolling 30-minute window, 2026-09-22 14:34–15:04 UTC:

| caller | rows | per min | per hour | **per day** |
|---|---|---|---|---|
| `bot-scanner` | 593 | 19.8 | 1,186 | **28,466** |
| `ipo-paper-runner` | 6 | 0.2 | 12 | **288** |
| **total** | 599 | 20.0 | 1,198 | **28,754** |

40% of the 50/min enforced cap.

**A trap worth recording:** `api_credit_usage` is **not a ledger**. The
`reserve_api_credit` function deletes rows older than `retention_seconds = 1800`
on every call, so the table is always a 30-minute window. A naïve
`reserved_at >= now() - 24h` query returns the same ~600 rows and reads as
"600 requests/day" — off by ~48×. I made exactly that error before reading the
function.

**Two callers are missing from attribution.** `zone-confirmation-scanner` runs
every minute and fetches 100 bars, and `outcome-tracker` runs hourly and fetches
576 5m bars, yet neither appears in the window. Either they are not currently
running, or they do not call `setCreditCallerContext` and their rows land under
another name. Unresolved; it means the true total may exceed 28.7k/day.

---

## 2. IPO data path

### Scheduler and configuration

`ipo-paper-runner-15min`, `*/15 * * * *`, jobid 10, active. One function, and it
is the **sole** market-data consumer in the IPO stack — `ipo-observation` and
`ipo-paper-state` are pure reads with no candle path at any import depth.

`_shared/ipoInstruments.ts` is the single definition:

| instrument | timeframe | gate | cost model |
|---|---|---|---|
| EUR/USD | 1h | — | `fx_fixed_0.00008` |
| USD/JPY | 30min | — | `jpy_fixed_0.008` |
| BTC/USD | 1h | HIGH_VOL only | `btc_prop_0.0015` |

### Fetch path and overlap page

```
ipo-paper-runner  → restore engine state (kv_cache)   ← no fetch if this fails
                  → fetchCandlesWithFallback({ limit: INCREMENTAL_BARS = 120,
                                               persistSymbolOverrides: false })
                  → continuityCheck: the page must CONTAIN lastProcessedBarTime
                  → feed only bars after it
```

- **120 bars per instrument per run**, regardless of how many are new. The page
  is sized for tolerance: it must overlap the cursor to prove no bar is missing,
  and 120 covers five days of missed schedules.
- **A run with no new bar still makes the request.** The fetch happens after the
  restore and before continuity is evaluated, so the provider call is
  unconditional once state exists. The *write* is skipped, not the fetch.
- **A run with no state makes no request at all** — `BOOTSTRAP_REQUIRED` returns
  before the fetch, deliberately, so a cold instrument cannot burn credits on
  the way to failing.

### Measured

6 requests per 30-minute window = **3 per run × 2 runs**, exactly as designed.
**288/day**, 1.0% of total spend.

### Engine state vs market data

These are different things and the distinction is load-bearing:

- **Engine state** (`ipo_engine_state:ipo_cet:<symbol>` in `kv_cache`, ~330 KB
  each) is *strategy state*: tracked candidates, episodes, the volatility
  reference, sequencing, the open trade. It happens to contain a packed copy of
  the 1,200 bars it was built from, because the frozen whole-series functions
  rescan the full prefix on every bar.
- **Market data** has **no persisted store anywhere.** There is no OHLC table.
  `scan_candle_snapshots` exists and is empty.

The bars inside IPO engine state are therefore **not** a shareable market-data
cache — reading them would couple SMC to IPO's strategy state, which is exactly
the coupling the whole design forbids.

---

## 3. Overlap matrix

| symbol | timeframe | SMC | IPO | SMC cadence | IPO cadence | duplicate provider fetch? |
|---|---|---|---|---|---|---|
| EUR/USD | 15min | yes | no | 1–5 min | — | no |
| EUR/USD | 1day | yes | no | 1–5 min | — | no |
| EUR/USD | **1h** | no | **yes** | — | 15 min | **no** |
| USD/JPY | 15min | yes | no | 1–5 min | — | no |
| USD/JPY | 1day | yes | no | 1–5 min | — | no |
| USD/JPY | **30min** | no | **yes** | — | 15 min | **no** |
| BTC/USD | **1h** | no | **yes** | — | 15 min | **no** |
| GBP/USD, USD/CAD, NZD/USD, AUD/USD, USD/CHF | 15min, 1day | yes | no | 1–5 min | — | no |

**Zero duplicate `(symbol, timeframe)` pairs.** The symbols overlap; the
timeframes never do. SMC trades 15min/1day; IPO trades 1h/30min.

The duplication is **intra-SMC**: the same `(symbol, 15min)` is requested by up
to 36 invocations per 30 minutes, deduplicated only by a 90-second per-isolate
cache that cannot span invocations reliably.

---

## 4. Shared infrastructure

### 4.1 `candleSource` in-memory cache — and a depth defect

```
key   `${symbol}:${interval}`          ← the requested LIMIT is not part of the key
TTL   90 s intraday, 300 s daily
hit   if entry exists and entry.candles.length >= 30
       → return entry.candles.slice(-limit)
```

Two consequences:

- **It cannot be shared between strategies.** It is a module-level `Map` inside
  one isolate. SMC and IPO are different functions, so they never share one. It
  also does not reliably survive between invocations of the *same* function.
- **A shallow entry silently satisfies a deep request.** A 300-bar fetch
  populates `EUR/USD:15min`; an 800-bar request within 90 s receives **300
  bars** and no warning. Only SMC mixes depths on one key today
  (300 / 800 / variable `barsBack`), so only SMC is exposed. IPO always requests
  120 for all three symbols, so it is self-consistent by accident of uniformity,
  not by design.

The 90-second TTL is itself a measured fix (PR #413: 30 s caused 202–440 refused
reservations per cycle; 90 s took it to zero), so it should not be shortened
casually.

### 4.2 `kv_cache`

Generic string store, used operationally: IPO engine state, IPO paper cursor,
IPO runner heartbeat, and FOTSI/daily-candle entries elsewhere. Swept hourly by
`kv-cache-cleanup-hourly` (`DELETE WHERE expires_at < now()`), which is why every
IPO writer sets a one-year expiry.

### 4.3 Market-data tables

None. No OHLC table, no bar archive. `scan_candle_snapshots` is empty.

### 4.4 Provider fallback — degraded

Documented order is MetaAPI → TwelveData → Polygon. Actual:

- **MetaAPI** requires a `brokerConn`; the SMC scanner passes `skipBroker: true`
  and IPO passes no connection, so neither uses it.
- **TwelveData** serves everything.
- **Polygon is unreachable — `POLYGON_API_KEY` is not among the project
  secrets.** The final fallback silently does not exist.

So for the two scheduled strategies the chain is **single-provider with no
failover**. If TwelveData refuses or errors, the caller gets nothing: SMC logs
"insufficient candles" and skips the pair; IPO's `continuityCheck` sees an empty
page and correctly does nothing.

### 4.5 Rate-limit and credit handling

Two layers, and only the second is plan-wide:

1. **Per-isolate** sliding window, `TD_RATE_LIMIT = 50` per 60 s. Comment in the
   source records why it is insufficient alone: several isolates each
   individually compliant reached 371/min against a 55/min plan.
2. **Shared budget** via `reserve_api_credit` RPC — advisory lock, counts rows
   in the window, inserts on grant, returns false on refusal. Waits up to
   `TD_MAX_WAIT_MS = 25 s` for a slot before giving up.

**It fails open.** Missing credentials, HTTP error, non-boolean response or a
2-second timeout all return `granted: true, enforced: false` and the fetch
proceeds **without a ledger row**. So measured spend is a floor, not a total.
`resetThrottleStats` exposes `unenforcedCount` and `gaveUpCount` for exactly this
reason; neither is currently surfaced anywhere a human sees.

### 4.6 Can one strategy consume the other's cached bars?

**Today: no, and nothing tries to.** There is no shared persisted market data.
The only bars either strategy could see are inside IPO's engine state, and
reading those would make SMC depend on IPO strategy state.

**In principle: yes, safely — but only under conditions the current cache does
not meet.** A shared bar store is safe when it is (a) keyed by
`(symbol, interval, provider)` *and depth or a bar range*, (b) restricted to
**closed** bars, which are immutable, and (c) never returns fewer bars than
asked. Condition (c) is the defect in §4.1. None of this touches strategy state:
positions, sequencing, exits, execution and engine state stay per-strategy.

---

## 5. Three options

Assumptions stated because they drive the numbers: current SMC scan shape
(~7 symbols × ~2 timeframes, 36 invocations/30 min), IPO unchanged at 3
instruments × 120 bars every 15 min, TwelveData plan 55/min with 50 enforced.
**TwelveData WebSocket pricing and per-symbol credit cost are NOT verified
against the actual plan and must be confirmed before any of B or C is costed for
real.**

### Option A — current REST, deduplicated

Share immutable closed bars through a real cache keyed by
`(symbol, interval, provider)` with depth honoured, persisted so it spans
invocations.

| | |
|---|---|
| REST calls/day | **~2,000–4,000** (from 28,754). One fetch per symbol/timeframe per bar close, plus a small margin, instead of one per invocation |
| WS connections | none |
| Latency | unchanged — bar available on next poll, ≤1 min for SMC, ≤15 min for IPO |
| Failure modes | stale-cache-serving-shallow-data if depth keying is got wrong again; cache store becomes a dependency for both strategies |
| Complexity | **low**. One module, `candleSource`, plus a small table |
| Strategy-drift risk | **low but not zero**. Identical bars from the same provider, so decisions are unchanged — *provided* the depth bug is fixed first, because fixing it changes what SMC currently receives |
| Migration risk | **low**. Incremental, reversible, testable against recorded fetches |

### Option B — hybrid: REST history + one WebSocket for live prices

REST keeps bootstrap and backfill. A single centralised WS connection supplies
live prices and/or in-progress candle formation. **Strategies still evaluate
only closed bars.**

| | |
|---|---|
| REST calls/day | **~2,000–4,000** (same as A; WS does not remove the need for history) |
| WS | 1 connection, ~7–9 symbol subscriptions |
| Latency | sub-second for price display; **unchanged for decisions**, which remain closed-bar |
| Failure modes | WS disconnect/replay gaps; two sources of truth for the same bar; clock skew between WS-assembled and REST bars |
| Complexity | **medium–high**. Connection lifecycle, reconnect, backfill-on-reconnect, a long-lived process (Edge Functions cannot hold a socket — this needs `local-runner` or similar) |
| Strategy-drift risk | **low IF** WS output is used only for display and REST remains the bar source for decisions. **High the moment a WS-assembled bar reaches an engine** |
| Migration risk | medium. Additive, but introduces a new always-on component |

### Option C — WebSocket-first market-data service

One connection, centralised candle construction, both strategies consume the
same completed bars.

| | |
|---|---|
| REST calls/day | **~100–500**, gap-fill and cold-start only |
| WS | 1 connection, all subscriptions, must be always-on |
| Latency | sub-second bar availability |
| Failure modes | single point of failure for both strategies; a missed tick produces a *wrong* bar rather than a missing one, which is far worse; reconnect gaps need REST reconciliation anyway; no independent source to verify against |
| Complexity | **high**. A real service: tick ingestion, bar assembly, boundary handling, persistence, reconciliation, monitoring |
| Strategy-drift risk | **HIGH — see §6** |
| Migration risk | **high**. Changes the bar source for a locked strategy mid-forward-test |

---

## 6. What would change trading semantics

Called out explicitly, because this is the part that decides the answer.

**Option A** changes nothing. **CORRECTED:** I wrote that SMC "currently
sometimes analyses 300 bars where it asked for 800" and that fixing it would
change SMC decisions. That is not true of the scheduled scanner, which cannot
reach the defect. It is true only of the on-demand `smc-analysis` endpoint, and
even there a measured 300-vs-800 comparison leaves every decision-bearing
primitive identical — the only deltas are enumerative counts, of which liquidity
pools feed confluence. See `docs/SMC_CACHE_DEPTH_STUDY.md` §3.

**Option B** changes nothing *if and only if* WS output never reaches an engine.
The discipline is easy to state and easy to erode: the first "we already have the
live price, why wait for the bar" is the end of it.

**Option C changes both strategies' inputs.** A WS-assembled bar is not
byte-identical to a provider bar — different open/close boundary handling,
different tick coverage, different timestamp rendering. Specifically for IPO:

- **Identity.** `setupId` and `intentId` are content-addressed over the bar's
  **datetime string**. A different source produces a different string, so the
  same trade mints a different identity. Idempotency, the divergence check and
  the existing `intent_id` unique constraints all key off this.
- **State.** `ipoEngineState` schema 2 stores bar times **verbatim** and the
  restore path validates them. Every persisted state would be invalidated and
  all three instruments would need re-bootstrapping from the new source.
- **Locked rules.** The frozen whole-series functions rescan the full prefix;
  changing the bars changes contractions, episodes, FVG detection and therefore
  which setups exist. That is a strategy change by any reasonable definition,
  regardless of intent.

For SMC the same argument applies without the identity component, and SMC has no
frozen-rule contract to violate — but it does have live paper positions.

---

## 7. Recommendation

**Option A, and not yet.**

The reasoning is arithmetic rather than preference. The stated goal of a
WebSocket is to remove duplicate provider calls; there are no cross-strategy
duplicates to remove, and the intra-SMC duplication — which is the real 28k/day
— is removed just as completely by caching closed bars properly, at a fraction of
the complexity and with no new always-on component. Current draw is 40% of cap,
so there is no pressure forcing the decision.

Options B and C both require a long-lived process, because an Edge Function
cannot hold a socket. That means `local-runner` becomes load-bearing for SMC as
well as for the IPO bootstrap — a material increase in what a single machine's
uptime controls.

And the timing argument is the strongest one: IPO has been in scheduled forward
paper for hours, with one closed trade. Changing its bar source now would
invalidate the engine state, change trade identities, and reset the evidence the
forward test exists to gather. If WebSocket is wanted, the moment for it is after
the forward test has produced a verdict — not during.

**Sequence I would propose, for a separate decision:**

1. Fix the cache depth-key defect (SMC bug, own before/after comparison).
2. Configure `POLYGON_API_KEY` or remove the dead fallback branch, so the
   provider chain is what the code says it is.
3. Surface `unenforcedCount` / `gaveUpCount`, so spend is actually measurable.
4. Then Option A.
5. Revisit B/C only with real WebSocket pricing and only after the IPO forward
   test concludes.
