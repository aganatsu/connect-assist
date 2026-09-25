# SMC Zone / Impulse — Stage 2: causal replay contract

**Measurement only. No production behaviour changed on this branch: no strategy
rule, threshold, filter, timeframe, entry, stop, target, cron, migration, DB
write or deployment.** Branch `research/smc-zone-impulse-stage2` from
`6d0cf7d5`. Dated 2026-09-25. No performance figure is produced (§2H).

Companions: `SMC_ZONE_IMPULSE_BASELINE_SPEC.md` (control),
`SMC_ZONE_IMPULSE_FORENSIC_AUDIT_STAGE1.md` (Stage 1).

---

## 0. Headline

```
A whole-history replay of this engine cannot see 54.9% of the impulses
that actually existed, and the ones it does see are selected precisely
on having survived.
```

| measure | result |
|---|---|
| decisions compared (2 treatments × 11 pairs × both directions) | **59,942** |
| impulse geometry differs between treatments | **58,825 — 98.1%** |
| zone geometry differs | 58,385 — 97.4% |
| `UnifiedState` differs | 35,036 — 58.4% |
| **causal impulses whose origin broke LATER** *(unconfounded)* | **30,801 of 56,136 — 54.9%** |
| …of those, had already produced a zone | **30,801 — 100%** |
| median bars from decision to origin break | **33** |

The Stage 1 lookahead (H1) is not a marginal effect. It is the dominant fact
about any historical measurement of this engine.

---

## 2A. The contract

A research harness, `local-runner/zone-stage2-causal.ts`, calls the **production**
`findUnifiedZone` unmodified. It contains no copy of any rule.

At each decision bar *k* the causal treatment supplies, for every slot, only
bars whose **close instant is at or before k**, sliced to production's
`DEFAULT_CANDLE_LIMIT = 300`:

```
decision instant = close of 5m bar k
1H  slot  closedBy(series, 3_600_000, k).slice(-300)
15m slot  closedBy(series,   900_000, k).slice(-300)
5m  slot  closedBy(series,   300_000, k).slice(-300)
```

Nothing after *k* is reachable by `findImpulseLeg`, `validateImpulseFromBOS`,
zone selection, FVG/OB discovery, state derivation, `priceAtZone` or
confirmation, because no such bar is in the array.

Scalper slots (1H / 15m / 5m, 5m entry) are used throughout, as Stage 1
established. They were not re-chosen here.

---

## 2B. Whole-series vs causal prefix

Both treatments receive the same instrument, provider, config, thresholds and
**the same current price** — `close[k]`. The only difference is whether bars
after *k* are visible.

| treatment | candles handed to the engine |
|---|---|
| **A LEGACY_WHOLE_SERIES** | the entire cached series — what a naive backtest does |
| **B CAUSAL_PREFIX** | closed bars ≤ *k*, at 300-bar depth |

Window 2026-09-15 → 2026-09-24, 11 pairs, both directions at every 5m bar.

### Per pair

| pair | decisions | impulse changed | zone changed | state changed | impulse only in LEGACY | only in CAUSAL |
|---|---|---|---|---|---|---|
| AUD/USD | 5,450 | 96.8% | 96.8% | 73.7% | 30 | **2,548** |
| BTC/USD | 5,446 | 95.6% | 90.3% | 56.3% | 349 | 0 |
| EUR/GBP | 5,450 | 93.6% | 93.6% | 46.2% | 140 | 0 |
| EUR/USD | 5,450 | 96.9% | 97.0% | 55.4% | 417 | 0 |
| NZD/USD | 5,450 | 100.0% | 100.0% | 70.8% | 307 | 0 |
| USD/CAD | 5,450 | 100.0% | 100.0% | 54.0% | 711 | 0 |
| *(remaining 5 pairs in `/tmp/zone-stage2-causal.json`)* | | | | | | |
| **TOTAL** | **59,942** | **98.1%** | **97.4%** | **58.4%** | 3,629 (6.1%) | 2,548 (4.3%) |

Field tally: `impulse.bosPrice` 97.7% · `zone.high` 97.4% · `impulse.low` 97.1% ·
`impulse.high` 97.0% · `state` 58.4% · `zone.type` 54.9% · `selectedTF` 54.5%.

### Reading it honestly

**This comparison is confounded and must not be quoted as the lookahead figure.**
Treatment A also receives a *longer* array (thousands of bars against 300), so
98.1% bundles future-origin-break with a much larger structure window. Both are
faults of a naive replay, but they are two faults.

The unconfounded number is §2C.

---

## 2C. Survivorship attribution — the number that matters

For every impulse the **causal** replay accepted, apply the production origin
rule directly to the bars that came after the decision: bullish is broken by a
close below the impulse low, bearish by a close above the impulse high
(`validateImpulseFromBOS` L598–610). If a later close breaks it, a whole-series
replay would have rejected that leg.

| pair | causal impulses | origin broke later | share |
|---|---|---|---|
| NZD/USD | 5,143 | 3,570 | **69.4%** |
| ETH/USD | 5,161 | 3,438 | 66.6% |
| AUD/USD | 5,243 | 3,298 | 62.9% |
| BTC/USD | 5,097 | 3,050 | 59.8% |
| GBP/JPY | 5,291 | 2,830 | 53.5% |
| USD/CHF | 5,355 | 2,846 | 53.1% |
| EUR/GBP | 5,310 | 2,765 | 52.1% |
| USD/JPY | 5,094 | 2,586 | 50.8% |
| EUR/USD | 5,033 | 2,379 | 47.3% |
| USD/CAD | 4,739 | 2,094 | 44.2% |
| GBP/USD | 4,670 | 1,945 | 41.6% |
| **TOTAL** | **56,136** | **30,801** | **54.9%** |

By slot: 1H 18,213 · 5m 6,792 · 15m 5,796.
**All 30,801 had already produced a zone** — these are not marginal legs, they
are the population the strategy would have acted on.
Median distance from decision to origin break: **33 bars**.

### Classification (2C taxonomy)

| class | n | note |
|---|---|---|
| `FUTURE_ORIGIN_BREAK` | **30,801** | measured directly, unconfounded |
| `FUTURE_ZONE_CHANGE` | ≤ 58,385 | bundled with the window-length confound in §2B; not separable without a production change |
| `FUTURE_FVG_CHANGE` / `FUTURE_OB_CHANGE` | not separable | POI discovery is nested inside the same call; isolating them needs instrumentation inside `mapImpulsePOIs`, which would be a production change |
| `OTHER` | — | |

**What this means for Stage 3.** Any backtest that hands this engine a full
series is measuring a population half the size of the real one, chosen by a
criterion the trader could not have known. That is the same class of error the
IPO programme found — and larger: IPO's intrabar defect moved expectancy from
+0.585R to −0.067R while keeping the population; this changes *which trades
exist at all*.

---

## 2D. The last-bar contract — production uses a FORMING bar

### Code trace

`closedBarsOnly` exists in `_shared/ipoObservation.ts` L220 and is imported by
**exactly one** caller: `ipo-paper-runner/index.ts` L40/L312. The SMC scanner
never calls it. `candleSource` requests
`…&outputsize=${limit}&order=ASC&timezone=UTC` and returns
`mapTwelveDataValues(data.values)` unfiltered — Twelve Data's newest value is the
bar in progress.

### Empirical confirmation

Not inferred from names. For 1,200 production scans, `unifiedZone.price.currentPrice`
was compared against the last closed 5m bar and against the bar then forming:

| where the recorded price sat | n | share |
|---|---|---|
| **strictly inside the forming bar's range** | **734** | **61.2%** |
| equal to the last CLOSED bar's close | 174 | 14.5% |
| equal to the forming bar's eventual close | 33 | 2.8% |
| neither | 259 | 21.6% |

**Verdict: `LIVE_FORMING_BAR`.** In 61% of scans the price driving `priceAtZone`,
`priceAtZoneStrict` and therefore the state machine was a running mid-bar price.

The 21.6% "neither" is a second finding: those scans used a price outside the
forming bar's range entirely, which points at `cachedFetch` serving a stale array
(the range is decorative; only `CANDLE_LIMITS` is honoured). Unexplained, and
recorded as a blocker.

### Treatments for historical replay

- **`CLOSED_BAR_ONLY`** — implemented, and the basis of every figure above.
- **`LIVE_FORMING_BAR_EQUIVALENT`** — **cannot be reconstructed from OHLC.** A
  bar's running close at an arbitrary instant is not recoverable from the bar's
  open/high/low/close. It could be *approximated* from 1-minute data (take the
  1m close at or before the scan instant), which is the recommended Stage 3
  route. It is not attempted here, and no figure is reported for it.

Neither treatment was chosen on performance; only one is even constructible.

---

## 2E. AUD/USD — root cause found, and it was mine

```
ROOT CAUSE: CONFIG_MISMATCH  (research-harness input omission, not production)
AUD/USD match  37.3%  →  84.9%    (+47.5pp)
ALL PAIRS      82.7%  →  92.1%    (+9.3pp)
```

### How it was found

Ruled out first, by direct comparison against high-match pairs: the AUD/USD 5m,
15m and 1H series are **structurally identical** to EUR/GBP's and NZD/USD's —
same bar counts (4,033 / 1,729 / 1,009), zero duplicates, zero out-of-order bars,
identical 5-decimal precision, and a continuous 1-step gap profile. So not
`DATA_ALIGNMENT`, not `PROVIDER_DIFFERENCE`, not `WARMUP_DIFFERENCE`.

Then the mismatches themselves:

- in 230 of 240 AUD/USD mismatches the **impulse matched exactly** (median
  `impulse.high` difference 0.000000) — only the winning POI differed;
- `zone.type` flipped in 183 of 240 (FVG ↔ OB inside the same impulse);
- **93.1%** of all mismatches across every pair had a production winning zone
  carrying `htfLayers`, against **69.9%** of matches;
- AUD/USD's mismatches are dominated by multi-layer zones —
  `(4H_OB, 4H_FVG)` 69, `(4H_BREAKER, D1_FIB_61.8)` 41, `(4H_FVG, 4H_BREAKER)` 34.

The Stage 1 harness passed `undefined` for `htfConfluenceData`, the eighth
argument to `findUnifiedZone`. Production builds it from 4H OBs, 4H FVGs, 4H
breakers, 4H and Daily fib levels and the 4H premium/discount read
(`bot-scanner` L5495). It feeds `checkHTFConfluence`, whose bonus enters the zone
score — and the zone score is exactly what `rankAndSelectBestZone` uses to choose
between competing POIs inside the same impulse.

### The fix, and why it is not tuning

`local-runner/zone-stage2-htf-retest.ts` rebuilds that argument by calling the
production detectors on 4H and Daily candles. **No threshold was moved and no
rule was changed — a missing argument was restored.** The before/after is
reported for every pair so it cannot be mistaken for a fit to one symbol:

| pair | n | before | after | delta |
|---|---|---|---|---|
| **AUD/USD** | 383 | 37.3% | **84.9%** | **+47.5pp** |
| USD/CHF | 338 | 81.1% | 96.4% | +15.4pp |
| GBP/USD | 550 | 82.7% | 96.5% | +13.8pp |
| ETH/USD | 240 | 75.4% | 88.3% | +12.9pp |
| BTC/USD | 299 | 78.3% | 83.9% | +5.7pp |
| EUR/GBP | 244 | 95.5% | 96.3% | +0.8pp |
| USD/CAD | 490 | 91.0% | 90.8% | −0.2pp |
| EUR/USD · USD/JPY · NZD/USD | 1,304 | unchanged | unchanged | +0.0pp |
| GBP/JPY | 2 | 0.0% | 0.0% | — |
| **TOTAL** | **3,850** | **82.7%** | **92.1%** | **+9.3pp** |

AUD/USD is **not hidden from totals** and is not excluded from any figure in this
document.

### The residual 7.9%

Still not determinism. The most likely remaining contributor is §2D: production
scored against a forming-bar price in 61% of scans and against an apparently
stale array in 21.6%, while the harness uses the last closed bar. That cannot be
closed without the snapshot (§2F). GBP/JPY (n=2, 0%) is too small to read.

---

## 2F. Production observability — design

Delivered on a **separate branch**, `feat/smc-scan-snapshot-observability`, so a
production deployment is never mixed with research conclusions. **Not deployed.**

### Storage first, because the obvious design is unaffordable

`scan_candle_snapshots` already exists with a `candles jsonb` column and **zero
rows** — it was created and never wired up. Writing one row per (scan, symbol,
timeframe) holding 300 candles:

```
12 pairs x 288 scans/day x 3 timeframes          = 10,368 rows/day
300 candles x ~80 bytes                          = ~24 KB/row
                                                 ≈ 249 MB/day   ≈ 7.5 GB/month
```

That is not acceptable for an observability feature.

### Deduplicated design

The same 300-bar array is re-sent every 5 minutes with one new bar. Store **bars
once**, and a **manifest** per scan naming the range:

```
smc_scan_bars      (symbol, timeframe, bar_time) PK, ohlc, provider, first_seen_at
smc_scan_manifest  scan_cycle_id, symbol, style, slot, timeframe,
                   first_bar_time, last_bar_time, bar_count, provider,
                   last_bar_closed, fetched_at, content_hash
```

```
bars/day     12 x (288 + 96 + 24)     =  4,896 rows   ~0.5 MB
manifest/day 12 x 288 x 3             = 10,368 rows   ~2.0 MB
                                        ≈ 2.5 MB/day  ≈ 75 MB/month
```

**100× cheaper**, and reconstruction is exact: select bars for the symbol and
timeframe between `first_bar_time` and `last_bar_time`, ordered.

`content_hash` over the array makes the reconstruction self-verifying — a replay
that rebuilds a different array is detected rather than trusted.

`last_bar_closed` records the §2D answer per scan instead of leaving it to be
re-derived.

Retention recommendation: **90 days** for manifests, **indefinite** for bars
(they are 0.5 MB/day and are the irreplaceable part). **No automatic deletion is
added** — that needs approval.

### Observability must not change strategy

The write is fail-open: wrapped, logged, and unable to alter any decision. It
happens **after** the zone engine has run and the arrays are fixed, so it cannot
influence what was scored. A failure increments a counter and the scan continues.

---

## 2G. Future determinism hook

`replayScan(scan_cycle_id)`:

1. read the manifest rows for that scan
2. rebuild each array from `smc_scan_bars`, verify `content_hash`
3. read the recorded style and config
4. call the production `findUnifiedZone` with exactly those arrays
5. compare field by field against the recorded `unifiedZone`

Output `FULL_MATCH` / `STATE_MATCH_ONLY` / `MISMATCH` with the differing fields.

**This does not repair old scans.** It establishes determinism from deployment
forward. Until then, 92.1% re-derivation is the ceiling of what can be claimed.

---

## 2I. Costs and versioning

### Where cost actually enters

Traced, not assumed:

- **The zone engine models no cost at all.** No spread, commission or slippage
  appears in `impulseZoneEngine`, `unifiedZoneEngine`, `zoneConfirmation` or
  `zoneLiquidity`. Entry, stop and target are pure price geometry.
- The only cost-shaped quantity on the path is the **stop floor** —
  `effectiveMinSlPips = max(staticFloorPips, ATR × ATR_SL_FLOOR_MULTIPLIER)` —
  which is a risk floor, not a cost.
- Execution sizing (`unifiedPositionSizing`) converts risk to lots; it does not
  subtract spread from the result.
- No comparison between paper and live cost handling can be made, because
  **no cost term exists in either**.

**Nothing is invented here.** Stage 3 must specify a cost model explicitly; there
is none to inherit. Note for scale: the entry TF is 5m and targets are BOS
levels, so spread is a materially larger fraction of R than it was for IPO.

### Proposed control identifier

```
smc-zone-impulse-control-v1
```

A **research label** for the frozen behaviour at commit `8530eef4`. It is not a
claim of validation. It is **not** added to production in this stage; the natural
home is the `contract_version` column the snapshot manifest already carries, so
it costs nothing extra once observability ships.

---

## 2H. No performance test

No PF, expectancy, win rate, drawdown, R result or ranking is produced. The
causal contract now exists (§2A) but determinism does not (§2E residual), and
§2C shows a whole-series population is not the real one. Stage 2 remains
measurement.

---

## Blockers

1. **Deploy the snapshot observability patch.** Until then no SMC replay can
   exceed 92.1% and determinism cannot be claimed. *(Ready, not deployed.)*
2. **`LIVE_FORMING_BAR_EQUIVALENT` is unreconstructable from OHLC** — Stage 3
   needs 1-minute data to approximate the running price, for 12 pairs.
3. **21.6% of scans priced outside the forming bar's range** — probable
   `cachedFetch` staleness, unexplained.
4. **No cost model.**
5. `FUTURE_FVG_CHANGE` / `FUTURE_OB_CHANGE` are not separable without
   instrumenting `mapImpulsePOIs`, which is a production change.

## Next stage

**Stage 3 — causal population, still not profitability.** Deploy observability;
acquire 1m data for the forming-bar treatment; then build the candidate ledger
over the *causal* population (the 56,136, not the 25,335 a whole-series replay
would have shown) and only then specify a cost model and measure.
