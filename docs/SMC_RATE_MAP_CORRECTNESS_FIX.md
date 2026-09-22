# SMC rate-map correctness fix

Implements Priority 1 from `SMC_RATE_MAP_SEMANTICS_AUDIT.md`. Dated 2026-09-22.
Not deployed at time of writing.

**Scope held.** No change to lot-sizing formulas, portfolio heat, `effectiveRR`,
commission logic or P&L formulas. No change to `open_position_price_refresh`. No
change to SMC strategy rules, management cadence, provider behaviour or IPO.

---

## 0. What changed, in three lines

1. **Fallback order is now live → last-known-good → static constant.** Before, a
   refused fetch went straight to a hardcoded constant that is up to **9.89%**
   wrong. Now it uses the most recent rate actually observed.
2. **The pair list is derived from config**, not hardcoded. Six pairs became
   three, because three were never read.
3. **Which source was used is recorded**, per pair, with the rate's age.

---

## 1. Files

| file | change |
|---|---|
| `_shared/smcAnalysis.ts` | `QUOTE_CONVERSION` hoisted to module scope and exported. Values unchanged — the same literal in a wider scope, so callers can derive the pairs they need. |
| `_shared/rateMapPolicy.ts` | **new**, pure. Derivation + the fallback ladder. No DB, no network, no clock, no constants. |
| `bot-scanner/index.ts` | rate-map block rewritten to use it; `rateMapHealth` added to scan meta. |
| `supabase/tests/_shared/rateMapPolicy.test.ts` | **new**, 28 tests — the proofs in §5. |

---

## 2. The fallback ladder

```
LIVE             a rate fetched successfully this cycle
CACHED_STALE     the most recent rate previously observed, with its age
STATIC_FALLBACK  no rate has EVER been observed for this pair
```

**The policy never substitutes a constant of its own.** At `STATIC_FALLBACK` it
**omits** the pair from the rate map, and `getQuoteToUSDRate`'s existing
`FALLBACK_RATES` branch fires exactly as it did before. That is deliberate: a
second copy of those constants is a second thing to go stale, and it keeps the
sizing path byte-identical to the pre-change behaviour in the worst case.

**No age cap, deliberately.** A month-old observed rate is far closer to spot
than a constant from a previous currency regime, so refusing it on age would
make sizing worse, not safer. Age is surfaced instead of being enforced.

**The cache is a fallback, not a TTL.** Every required pair is still fetched
every cycle, exactly as before. A TTL here would freeze the conversion rate for
up to 24 hours and *would* change sizing — that is the trap §3 of the telemetry
report flagged, and it is not what this does. A test asserts the live fetch is
still present and that no TTL has crept in.

### Why the cache is the right answer

| | error vs spot | lot-size error on $1,000 risk |
|---|---|---|
| static constant `USD/JPY = 142.0` | **−9.89%** | **$98.93** |
| worst measured 60-minute-old observed rate | **0.149%** | **$1.49** |

66× better, on the path that currently fires whenever a fetch is refused — and
refusals are routine at ~44 per full scan.

---

## 3. Derived pairs

`getQuoteToUSDRate` returns `1.0` **before reading the map** whenever the quote
currency is USD. So the pair set is a function of the enabled instruments:

```
enabled : EUR/USD  GBP/USD  USD/JPY  USD/CAD  NZD/USD  AUD/USD  USD/CHF
required: USD/CAD  USD/CHF  USD/JPY
dropped : GBP/USD  AUD/USD  NZD/USD      ← reachable only via crosses, none enabled
```

Deriving rather than listing means enabling `EUR/GBP` tomorrow starts fetching
`GBP/USD` automatically, and disabling it stops. Tested for all three.

**Open-position symbols are included as well as enabled instruments.** The map
is read for portfolio heat and for P&L at close, and an open position can sit
outside the enabled set — weekend crypto mode narrows `config.instruments` to
crypto while an FX position is still open, and an instrument can be disabled
after entry. Deriving from the enabled list alone would have closed that
position at a static constant. This is the one place the fix does more than the
brief asked for, and it exists to avoid introducing a regression the brief did
not anticipate.

---

## 4. Request volume

Measured baseline: 6 rate-map fetches per `runScanForUser` invocation,
unconditional.

| | before | after | change |
|---|---|---|---|
| per invocation | 6 | 3 | **−50%** |
| management loop (1,440 invocations/day) | **8,640/day** | **4,320/day** | **−4,320/day** |
| per full-scan cycle | 6 | 3 | −3 each |
| weekend crypto mode, no FX position open | 6 | **0** | −6 each |
| total `bot-scanner`, measured 15,794/day | — | **≈11,474/day** | **≈−27%** |

No fetch was added. The three removed pairs were the three whose values nothing
read.

**New non-provider cost:** one `kv_cache` select per invocation, and one upsert
when a rate actually changed — roughly 2,880 row operations/day on a single row.
During a provider outage `nextCache` is unchanged and the write is skipped
entirely.

---

## 5. Proofs

All 28 in `supabase/tests/_shared/rateMapPolicy.test.ts`, run against the real
`getQuoteToUSDRate` and the real `computePositionSize` rather than a model of
them.

| requested proof | test |
|---|---|
| identical sizing when the live rate is available | *sizing is identical when the live rate is available* — `computePositionSize().lots` equal through the policy and through the raw fetched map, for USD/JPY, USD/CAD, USD/CHF, EUR/USD |
| cached fallback = the same calculation as that rate used live | *cached fallback produces exactly the calculation of that rate used live* — resolved map and resulting lots identical |
| static fallback only when no prior cached rate | *static fallback occurs ONLY when no prior cached rate exists*, plus *static fallback OMITS the pair so the existing constant branch fires* — asserts equality with the pre-change `getQuoteToUSDRate(symbol, {})` |
| removing unused pairs changes no decision | *dropping … changes no rate for any enabled instrument* and *… changes no LOT SIZE for any enabled instrument*, over all seven enabled symbols |
| SMC semantics unchanged when fetches succeed | *a successful fetch produces the same map the old code produced* — `degraded: false`, every pair `LIVE` |
| IPO untouched | no IPO file is imported or modified; `git show --stat` lists no `ipo*` path |

Additional guards worth naming:

- *the module does not contain the fallback constants* — comments stripped
  before scanning, so prose may name what the code must not do.
- *the policy module is pure* — no client, fetch, env, table or `Date.now()`.
- *a zero, negative, NaN or missing live rate is treated as no rate* — matches
  `getQuoteToUSDRate`'s own `rate > 0` validity test.
- *a corrupt cache entry degrades to static rather than poisoning sizing.*
- *a pair that fell back does not overwrite the cache with the stale value* —
  otherwise the age would reset every cycle and never look stale.
- *open_position_price_refresh is untouched and still fetches live 15m.*
- *the scanner derives its pairs and no longer hardcodes six* — fails if the
  dead pairs are reintroduced.

Suites: **deno 2,822 passed / 0 failed** (1,253 + 1,569), **vitest 70 passed**,
**`deno check` clean on every function**.

---

## 6. Exact fallback behaviour, as deployed

Per cycle, per required pair:

```
fetch ok, close > 0     → rateMap[pair] = close        LIVE          age 0
                        → cache[pair]  = {close, now}
fetch refused/failed/
  empty, cache has it   → rateMap[pair] = cached.rate  CACHED_STALE  age = now − cached.at
                        → cache entry left untouched
neither                 → pair ABSENT from rateMap     STATIC_FALLBACK  age null
                        → getQuoteToUSDRate uses FALLBACK_RATES, unchanged
```

Surfacing:

- Healthy cycle — `[scan …] rateMap built (USD/CAD=LIVE USD/CHF=LIVE USD/JPY=LIVE): {…}`
- Degraded cycle — `console.warn`, e.g. `rateMap DEGRADED: USD/CAD=LIVE USD/CHF=CACHED(90m) USD/JPY=STATIC`
- Full scans additionally carry `__meta.rateMapHealth = { degraded, pairs: [{pair, source, ageMs, rate}] }`.

Management-only cycles return before the scan-meta block, so for those the log
line is the surface. Nothing is written to a trade row; that would change a
table, which is out of scope here.

Failure modes of the mechanism itself:

- **Cache read fails** → warns, then behaves exactly as the pre-change code did
  (static constants). Fails to the old behaviour, never worse.
- **Cache write fails** → warns; this cycle is already correct, only a *later*
  fallback loses freshness.
- **First run after deploy** → the cache is empty, so any pair whose fetch is
  refused reports `STATIC_FALLBACK`. Identical to today's behaviour. From the
  first successful fetch onward it reports `CACHED_STALE` instead.

---

## 7. Not fixed, and deliberately so

**`paper-trading/index.ts:174–221` has its own duplicate copy** — its own
`FALLBACK_RATES`, its own `getQuoteToUSDRate`, and the same hardcoded six pairs.
It is worse than the scanner's old version was: it *seeds* the map with the
stale constants (`{ ...FALLBACK_RATES }`) so a failed fetch is indistinguishable
from a successful one downstream. It is live — the UI's `status`, `place_order`
and `close_position` all route through it.

This fix does not touch it, because the brief was the scanner's rate map and
because touching a second execution path is a second change. **It is the obvious
next candidate**, and until it is done the exposure quantified in §2 of the audit
still exists on the paper-trading path.

Also unaddressed, both previously reported: `backtest-engine:1457` passes no rate
map at all, so every non-USD-quote backtest converts at the constants; and the
per-invocation reuse question for the rate map is untouched — every required pair
is still fetched every cycle by design.
