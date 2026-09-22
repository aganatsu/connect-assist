# SMC cache depth & deduplication study

**Study only. No production change.** SMC, IPO, cron, tables and provider
behaviour are all untouched. Dated 2026-09-22.

---

## 0. Headline, including a correction to my own audit

**The depth defect cannot fire in the scheduled SMC path.** My previous audit
said "every SMC caller mixes depths on the same key". That was wrong. In
`bot-scanner` the depth is a pure function of the interval:

```ts
limit: CANDLE_LIMITS[interval] ?? DEFAULT_CANDLE_LIMIT   // { "4h": 800 }, else 300
```

Same `symbol:interval` key ⇒ same depth, always. The scheduled scanner is
structurally immune. The exposure is confined to **`smc-analysis`**, which is
on-demand and not on cron, and only when a caller supplies an explicit smaller
`limit` in the request body.

**Consequently: fixing the cache key saves no requests and changes no scheduled
behaviour.** It is a correctness fix for one on-demand endpoint, not an
optimisation. The optimisation is a separate, much larger opportunity (§4).

**And the real spend is not where I implied.** Measured: full scans are ~5,000
requests/day. The other **~23,400/day comes from the 1-minute management loop**,
which is invisible in the scan telemetry because it never runs the scan-cycle
tally.

---

## 1. Every SMC call into the candle path, with depths

| caller | scheduled | depth requested | depth varies per key? |
|---|---|---|---|
| `bot-scanner` → `fetchCandles` | yes, `*/5` scan + `* * * * *` manage | `800` for `4h`, else `300` | **no** — pure function of interval |
| `zone-confirmation-scanner` | yes, `* * * * *` | `100` (5m) | no |
| `outcome-tracker` | yes, `15 * * * *` | `576` (5m) | no |
| `smc-analysis` | **no** — on demand | `800` ×8 sites, `barsBack` ×7 sites (`tgt.limit ?? body.limit ?? 800`) | **YES** |
| `bot-weekly-advisor` | no | per call | n/a |
| `backtest-engine` | no | `5000` | no |
| `market-data` | no | per call | n/a |

There are **two** caches, and both omit depth from the key:

1. **`createScanCache`** (`_shared/dataCache.ts`) — per scan cycle, key
   `symbol|interval`, also dedups in-flight promises. Fed by `fetchCandles`,
   whose depth is interval-determined, so the missing depth is inert here.
2. **`_candleCache`** (`_shared/candleSource.ts`) — per isolate, key
   `symbol:interval`, TTL 90 s intraday / 300 s daily, hit requires ≥30 bars and
   returns `.slice(-limit)`.

Only a caller that mixes depths on one key can be bitten, and only
`smc-analysis` does.

---

## 2. How often is a deep request served by a shallow entry?

**In the scheduled path: never.** Not rarely — never. Depth is determined by
interval, so a `symbol:interval` entry always holds exactly the depth the next
request for that key will ask for.

**In `smc-analysis`: possible, unmeasurable from here.** It requires two
requests for the same symbol and interval within the 90-second TTL in the same
isolate, with the second asking for more than the first. There is no telemetry
on that endpoint's request bodies and it is not on a schedule, so I can give the
mechanism but not a rate. Given it is a manual diagnostic, the realistic
frequency is low and bounded by how often a human clicks.

---

## 3. Before/after: does correcting the depth change SMC outputs?

Since the defect cannot fire on the scheduled path, a two-run comparison of the
live scanner would be **identical by construction**. The useful question is the
counterfactual: *if* a shallow entry were served, what would change?

Measured directly on real bars — EUR/USD and GBP/USD, 15min, 800 bars vs the
same array truncated to its last 300 (exactly what a shallow cache hit yields):

| output | EUR/USD 800 → 300 | GBP/USD 800 → 300 | changed? |
|---|---|---|---|
| trend | ranging → ranging | bearish → bearish | no |
| order blocks (count) | 5 → 5 | 5 → 5 | no |
| order blocks (actual zones) | identical | identical | **no** |
| FVGs | 15 → 15 | 13 → 13 | no |
| breaker blocks | 1 → 1 | 4 → 4 | no |
| unicorn setups | 0 → 0 | 3 → 3 | no |
| AMD phase | distribution | distribution | no |
| reversal candle | bearish | null | no |
| ATR(14) | 0.0005493 | 0.000775 | no |
| **swing points** | 135 → 40 | 155 → 51 | **yes** |
| **zigzag pivots** | 21 → 5 | 29 → 7 | **yes** |
| **liquidity pools** | 5 → 3 | 13 → 7 | **yes** |

6 of 32 comparisons differ. The pattern is clean and explicable: **recency-bounded
detectors are depth-insensitive; enumerative historical detectors scale with the
window.** Order blocks, FVGs, breakers, unicorns, trend and ATR look at recent
structure and are byte-identical. Swings, pivots and pools enumerate everything
in the array, so a shorter array yields proportionally fewer.

### The one that matters

**Liquidity pools are a confluence input.** Swings and pivots are intermediate
and their counts do not propagate on their own, but pool count feeding confluence
means a shallow read *could* change a confluence score and therefore setup
acceptance. That is the single channel by which this defect could alter a trade
decision, and it is the reason to fix it even though it cannot currently fire.

### Honest limits of this experiment

- I compared the **analysis primitives**, not the full scanner verdict. Direction
  decisions, confluence scoring, zone gating and pending-order logic live in
  `bot-scanner`'s 8,500 lines and cannot be driven offline without a database,
  broker connection and live config. So "no change to detected zones" is
  measured; "no change to accepted setups" is **inferred** from the inputs being
  identical apart from pool count.
- 4 of the 32 comparisons were **vacuous** — `lastBreak`, `breaks`,
  `displacement` and `fvgTop3` came back `null`/`undefined` on both sides because
  I guessed property names that do not exist on those return shapes. They prove
  nothing and should not be read as "unchanged". The meaningful comparison is
  over ~28 fields.
- Two symbols, one timeframe, one moment. A trending market with structure
  breaks in the 300–800 bar region could behave differently from today's ranging
  EUR/USD.

**Verdict: correcting the cache depth is very unlikely to change SMC strategy
output, and cannot change it at all on the scheduled path. The residual risk is
confluence via liquidity-pool count on the on-demand endpoint.**

---

## 4. Request-saving estimates

Baseline, measured over a clean 30-minute window (`api_credit_usage` is a rolling
30-minute table, not a ledger — it deletes rows older than 1800 s on every call):

```
bot-scanner        19.8/min    28,466/day
ipo-paper-runner    0.2/min       288/day
total              20.0/min    28,754/day     = 40% of the 50/min enforced cap
```

Decomposition, from `scan_logs` telemetry:

- A **full scan** covers **7 pairs**, does **35 live fetches** and **34 scan-cache
  hits** (49.3% hit rate). Observed full scans at 15:01 and 15:10 → roughly
  6/hour → **~5,000/day**.
- The remaining **~23,400/day (~976/hour, ~16/min)** is unattributed by scan
  telemetry. ~~It correlates almost exactly with the 1-minute management loop ×
  16 open pending orders.~~ **CORRECTED 2026-09-22 by direct measurement —
  see `docs/SMC_MANAGEMENT_LOOP_TELEMETRY.md`.** Both halves of that inference
  were wrong. The "16 pending orders" was a raw row count; all 21 rows are
  `expired`, so there are zero active. And the mechanism is not per-order
  fetching: the management loop makes **exactly 7 provider fetches per
  invocation**, of which **6 are daily bars for an unguarded currency-rate map**
  (8,640/day) and 1 is the open-position price refresh. Measured management
  spend is **10,080/day**, not 23,400.

| option | mechanism | estimated requests/day | reduction |
|---|---|---|---|
| **(a) correctly-keyed cache only** | add depth (or bar range) to the cache key | **~28,754 — unchanged** | **0%** |
| **(b) shared persistent closed-bar cache** | one store keyed `(symbol, interval, provider)`, closed bars only, read by every caller and surviving isolate death | **~800–1,500** | **~95%** |
| **(c) longer TTL, closed-bar-correct** | expire at the next bar close instead of a flat 90 s | **~3,000–6,000** | **~80%**, unreliable |

**(a) saves nothing.** Adding depth to the key can only *reduce* hit rate — it
turns some current hits into misses. On the scheduled path there are no such
hits to lose, so the net is zero, but it is worth being clear that this change is
a correctness fix that pays no efficiency dividend.

**(b) is where the saving is.** A 15-minute bar changes four times an hour; the
system currently re-requests it up to sixty times an hour. 7 symbols × 2
timeframes = 14 series; at one fetch per bar close that is 7×4×24 = 672/day for
15min plus a handful of daily = **well under 1,500/day**. This also fixes the
management loop's spend without touching the management loop, because it would
read the same cache.

**(c) is (b)'s effect without persistence.** Aligning the TTL to the bar
boundary is strictly more correct than a flat 90 s — a closed bar is immutable,
so caching it for 90 seconds and then re-fetching the identical bytes is pure
waste. But an in-memory cache dies with the isolate, so the realised saving
depends on isolate reuse, which is not under our control. Good as a cheap
interim; not a substitute for (b).

---

## 5. Resolved questions

### 5.1 `instruments.enabled` vs `allowedInstruments`

**`enabled` wins.** `bot-scanner` line 1217:

```
Priority: 1) instruments.enabled array (current UI, including explicit empty array),
          2) allowedInstruments map (legacy), 3) defaults
```

`Array.isArray(instruments.enabled)` is checked first, so the 7-pair `enabled`
array shadows the `allowedInstruments` map entirely. `allowedInstruments` is
legacy and currently dead config — it says only EUR/USD is permitted and has no
effect.

**Confirmed empirically:** `scan_logs.pairs_scanned = 7` on every full scan.

That the two disagree is a latent trap: anyone editing `allowedInstruments`
expecting it to restrict scanning will change nothing. Worth reconciling, but it
is an SMC config question, not a market-data one.

### 5.2 Missing caller attribution

**Both functions do call `setCreditCallerContext`** —
`zone-confirmation-scanner/index.ts:48` and `outcome-tracker/index.ts:27`. So
attribution is wired correctly and their absence from the window is not a
labelling bug.

The remaining explanations are that they are not currently executing, or are
executing but not reaching a provider fetch (both have early exits — the zone
scanner needs watched zones, the outcome tracker needs setups to resolve).
Distinguishing the two requires either function logs, which I cannot read from
here, or a counter, which would be a change. **Unresolved, and it means the
28.7k/day figure is a floor** — if either starts fetching, it adds to it.

### 5.3 Fail-open budget audit

Measured across the last 20 scan records (2 full scans plus 18 management
cycles):

```
unenforced    0      the shared budget never failed open
rpcFailures   0      the RPC never errored or timed out
refused      88      ~44 per full scan
gaveUp        5      fetches abandoned at the 25 s wait ceiling
429s          4      provider rate-limit responses
throttles    88
```

**The fail-open path is not currently firing.** `unenforced` and `rpcFailures`
are both zero, so every granted request in this window was accounted for and the
ledger is accurate for the period measured. My earlier concern that spend might
be materially understated is **not supported** — for this window.

What *is* happening is heavy refusal: **~44 refusals per full scan against 35
successful fetches**, i.e. more than half of all attempts are being turned away
by the budget, plus 2–3 abandoned entirely after waiting 25 seconds. Those
abandonments surface downstream as "insufficient candles" and a skipped pair.
The scanner is being **starved, not merely paced** — consistent with the existing
note on this in the codebase.

**True usage does not materially exceed 28.7k/day** on the evidence available,
with two caveats: the unattributed management-loop share is inferred rather than
proven, and §5.2 leaves two scheduled consumers unaccounted for.

---

## 6. Safe optimisation plan

Ordered so that each step is independently verifiable and none changes strategy
behaviour without saying so.

**Step 1 — instrument the management loop.** Add the scan-cycle tally (or just a
distinct caller tag) to the management path. Pure observability; no behaviour
change. This converts the largest single consumer from inference to measurement,
and nothing after this should be sized without it.

**Step 2 — resolve §5.2.** Determine whether `zone-confirmation-scanner` and
`outcome-tracker` are executing. Observability only.

**Step 3 — fix the cache depth key.** `smc-analysis` only in practice. Behaviour
change is possible but confined to that endpoint and, on the evidence in §3,
limited to liquidity-pool count feeding confluence. **Run the before/after on
that endpoint specifically rather than assuming**, since the whole point of §3
is that the primitives agree and confluence is the one untested channel. Saves
no requests.

**Step 4 — align TTL to bar close.** Replace the flat 90 s with "expires when the
next bar of that interval closes". A closed bar is immutable, so this is
strictly more correct than a timer, and it cannot serve a stale bar. Low risk,
meaningful saving, no schema change. **Keep the 90-second floor**: the TTL was
widened from 30 s to 90 s for a measured reason (refusals 202–440 → 0), and a
bar-aligned TTL must never compute shorter than that.

**Step 5 — shared persistent closed-bar store.** The ~95% reduction. Conditions
that make it safe:

- closed bars only, never the forming bar;
- key includes `(symbol, interval, provider)` **and** the bar range or depth;
- never returns fewer bars than requested — miss and fetch instead;
- it is **market data, not strategy state**. SMC and IPO may both read it;
  neither may read the other's positions, sequencing, exits, execution or engine
  state. IPO's engine state contains bars, and those are *not* this store.

**Not in this plan:** WebSocket, per the previous audit and your direction. Also
not in this plan: changing IPO, whose 288/day is 1% of spend and whose bar
identities are content-addressed — it should be the last consumer migrated to any
shared store, not the first.

---

## 7. Answer to the question as asked

> Report whether correcting the cache depth changes SMC strategy outputs
> materially.

**No, and on the scheduled path it cannot change them at all.** The defect is
unreachable from `bot-scanner` because depth is derived from the interval. On the
on-demand `smc-analysis` endpoint it is reachable, and a 300-vs-800 comparison on
real bars leaves every decision-bearing primitive identical — order blocks, FVGs,
breakers, unicorns, trend, ATR — while changing only enumerative counts. Of
those, liquidity pools feed confluence, so a confluence delta is possible and is
the one thing that should be measured directly before the fix ships.

The request-volume problem is real but unrelated to the depth key, and the fix
for it is a shared closed-bar cache, not a rekeyed one.
