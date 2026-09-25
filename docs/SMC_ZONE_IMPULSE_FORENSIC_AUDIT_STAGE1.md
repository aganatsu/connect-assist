# SMC Zone / Impulse — Stage 1 forensic audit

**Measurement only. No production behaviour changed, no strategy rule altered,
no filter added or removed, no database write, no migration, no cron change, no
deployment.** Branch `research/smc-zone-impulse-stage1`, from `8530eef4`.
Dated 2026-09-25.

Companion control document: `SMC_ZONE_IMPULSE_BASELINE_SPEC.md`.

---

## 0. Verdict

```
PARTIAL_REDERIVATION — 3,185 / 3,850  (82.7%)
```

**Stage 1 stops here, as instructed.** The determinism gate did not pass, so no
performance snapshot is produced and no statement about the strategy's edge is
made. Two blockers, in order of severity:

1. **A true determinism test is impossible with the evidence that exists.**
   `scan_candle_snapshots` — the table built to persist each scan's input
   candles — contains **zero rows**. The bars production actually saw were never
   recorded, so they cannot be replayed.
2. **The weaker test that is possible re-derives only 82.7%** of production's
   zone geometry from the same provider at the same instants. 665 observations
   differ, and with no stored inputs a mismatch cannot be attributed to the
   harness or to different bars.

Separately, and independently of the above, the audit found **one confirmed
lookahead** in the impulse acceptance rule that would invalidate any whole-series
backtest of this engine (§H1).

---

## 1. What the brief assumed, and what the code says

The brief listed candidate rules and warned not to trust them. It was right not to.

| assumed rule | actual status |
|---|---|
| minimum 20 closed candles | **true** — `findImpulseLeg` L307 |
| BOS / CHoCH structural leg | **true** — same-direction breaks only, newest first |
| origin swing | **true** — nearest swing of the opposite extreme before the BOS, **first 5 candidates only** |
| reject if a later candle closes beyond origin | **true, and it is the ONLY acceptance test** — L598 |
| close-confirmed structural break | **true** — inherited from `analyzeMarketStructure` |
| rank intact legs / continuation BOS preference | **false as a rule.** `sequence.position` is recorded; nothing reads it |
| ATR displacement | **false.** Displacement is measured against a 20-bar body/range baseline, never ATR, and **cannot reject** |
| directional candle ratio | **false as a gate.** `measureLegCandles` records it; no threshold |
| body dominance | partially — `bodyRatio >= 0.7` is one of three *labelling* conditions inside `measureLegDisplacement`, not a gate |
| path efficiency | **not implemented** anywhere on the live path |
| overlap threshold | **not implemented** for impulses. Overlap exists only as the Daily-bounds filter (`dailyZoneBounds`), unused by the scalper path |
| accepted FVG / OB inside impulse | **true** — `mapImpulsePOIs` |
| POI validation | **true, and it is a Fib-band filter**: 0.5 → 0.786 |
| max age | **does not exist** |
| 50% internal pullback rule | **removed**, and the code says so at L631 |

**Net:** the impulse engine is far less filtered than described. Exactly **two**
conditions can reject a leg — the 3-bar minimum span and the origin-not-broken
test. Everything else is metadata.

---

## 2. Timeframe finding

Production runs **`scalper`**, not `day_trader`. Read from `scan_logs.activeStyle`
across the window, not assumed. The zone slots are therefore **1H / 15m / 5m**
with a **5m entry** — the Daily/4H/1H mapping in the brief belongs to a
configuration that is not running.

This matters for everything downstream: the impulse is detected on 5-minute and
15-minute structure, and the "HTF" slot is one hour.

---

## 3. Closed-candle / lookahead audit (Stage 1H)

| # | site | finding | class |
|---|---|---|---|
| **H1** | `validateImpulseFromBOS` L598–610 | Origin-broken test scans `for (j = endIdx+1; j < candles.length; j++)` — **to the end of the array**. Live the array ends at now, so this is causal. In a whole-series replay it reads the future: a leg valid at time T is rejected because of a bar at T+n. | **CONFIRMED_LOOKAHEAD in replay · CAUSAL in production** |
| H2 | `findImpulseLeg` L309 | `analyzeMarketStructure` runs over the whole array; swing detection needs `lookback` bars *after* a pivot, so recent pivots are unconfirmed. This is lag, not lookahead — but it means the newest bars cannot produce swings. | CAUSAL |
| H3 | `analyzeMarketStructure` `derivedSR.broken` | Scans forward from each break to the array end. Not read by the zone path; `trend` does not depend on it. | POTENTIAL_LOOKAHEAD (unused) |
| H4 | `mapImpulsePOIs` L670 | OB state is evaluated on `slice(obStart, endIndex+1)` only, so mitigation **after** the impulse is never applied. Under-reads later information — the opposite failure to H1. | CAUSAL, but stale |
| H5 | forming candle | The scanner fetches the provider's latest bar, which **may be the currently forming one**. `closedBarsOnly` exists in `ipoObservation.ts` and is used by the IPO runner; the **SMC zone path does not call it**. | **NEEDS_INTRABAR_RESOLUTION** |
| H6 | `analysis.lastPrice` | Last close of the entry series — the forming 5m bar's running close if H5 applies. Drives `priceAtZone`, `priceAtZoneStrict` and therefore the state machine. | NEEDS_INTRABAR_RESOLUTION |
| H7 | zone geometry | Impulse high/low are wick extremes over `[start, end]`, all of which precede the decision. | CAUSAL |
| H8 | fib band | Anchored to impulse wicks, no forward reference. | CAUSAL |

**H1 is the one that would destroy a backtest.** A whole-series replay keeps only
legs whose origin survived to the end of the data — survivorship selection on the
single condition that decides acceptance. Any historical result produced by
handing this engine a full series is measuring the subset of impulses that
happened to still be intact at the end of the file.

H5/H6 together mean the engine's *state* can flip within a bar: `priceAtZone` is
evaluated against a price that is still moving.

---

## 4. Intrabar audit (Stage 1I)

The IPO programme's failure mode was OHLC being unable to order two events inside
one bar. The Zone engine is exposed to the same class, and in one respect worse:

| scenario | exposure |
|---|---|
| entry + SL in one bar | **Unmeasurable today.** Entry is a resting level inside a zone; SL sits half a zone-width beyond. On a 5m entry bar both can be touched. Nothing records which came first. |
| entry + TP in one bar | Same. TP is the BOS level, frequently within one 5m bar of the entry. |
| zone touch + invalidation in one bar | **Structurally invisible.** The engine is stateless (§spec 4); a zone touched and invalidated between two scans leaves no record at all. |
| confirmation + entry in one bar | `evaluateConfirmation` reads the 15m/5m series; `priceAtZoneStrict` reads the last price. Both are evaluated at the same instant with no ordering. |
| target-side extreme before entry | **Not detectable.** This is the exact IPO defect and the zone path has no equivalent of IPO's `ipoCausalOrdering`. |

**No trade in this engine can currently be classified `HTF_UNAMBIGUOUS` with
confidence**, because there is no persisted entry timestamp to order against. A
Stage-2 causal replay will need 1-minute resolution from the outset — the IPO
programme learned this at Stage 3 and it cost a full re-measurement.

---

## 5. Determinism / oracle (Stage 1M)

### 5.1 Why the specified test could not be run

| table | rows | use |
|---|---|---|
| `scan_candle_snapshots` | **0** | would have held the exact input candles. Never written. |
| `scan_logs` | 2,997 | holds the **output** `unifiedZone` payload for 3,850 zone observations |

The harness therefore runs a **re-derivation**, not a determinism test: re-fetch
the same provider's candles for the same instant, re-run the unmodified
production `findUnifiedZone`, compare geometry.

Two facts make it meaningful: the provider is identical
(`sourceBreakdown` = twelvedata N, metaapi 0, polygon 0 in every scan), and the
harness calls production functions rather than reimplementing them.

### 5.2 Result

```
compared     3,850      skipped 0
FULL MATCH   3,185      82.7%
state agreement (independent of geometry)   3,594 / 3,850   93.4%
```

| mismatching field | n | share |
|---|---|---|
| zone.high / zone.low | 660 | 17.1% |
| zone.type | 431 | 11.2% |
| impulse.low | 223 | 5.8% |
| impulse.high | 195 | 5.1% |
| impulse.bosPrice | 190 | 4.9% |
| selectedTF | 126 | 3.3% |

| by production slot | compared | match | |
|---|---|---|---|
| 1H | 3,184 | 2,621 | 82.3% |
| 15m | 355 | 271 | 76.3% |
| 5m | 308 | 293 | **95.1%** |
| D | 3 | 0 | 0% *(leftover day_trader config)* |

| by pair | compared | match | |
|---|---|---|---|
| EUR/GBP | 244 | 233 | 95.5% |
| USD/JPY | 410 | 385 | 93.9% |
| EUR/USD | 496 | 465 | 93.8% |
| NZD/USD | 398 | 369 | 92.7% |
| USD/CAD | 490 | 446 | 91.0% |
| GBP/USD | 550 | 455 | 82.7% |
| USD/CHF | 338 | 274 | 81.1% |
| BTC/USD | 299 | 234 | 78.3% |
| ETH/USD | 240 | 181 | 75.4% |
| **AUD/USD** | 383 | **143** | **37.3%** |

### 5.3 Reading it honestly

- **The impulse re-derives better than the zone does.** Impulse fields miss ~5%;
  zone geometry misses 17%. So the leg is usually agreed and the *selected POI*
  differs — consistent with POI ranking being sensitive to a one-bar difference
  in the OB detection window, where a single extra candle changes the OB set and
  therefore which zone wins on score.
- **AUD/USD at 37.3% is an outlier that needs its own explanation** and is the
  single most informative anomaly in this stage. A systematic cause (symbol
  mapping, a different fetch depth, a stale cache entry in production) is far
  more likely than the engine behaving differently for one pair.
- **93.4% state agreement against 82.7% geometry agreement** means most geometry
  differences are small enough not to move the state machine — which is
  reassuring about the *behaviour* and says nothing about reproducibility.

**This is not determinism, and Stage 1 therefore stops.** No `PRE-CAUSAL-AUDIT
BASELINE` performance figure is produced.

### 5.4 Two harness faults found and fixed, both worth recording

1. **Timestamp parse.** Postgres renders `2026-09-15 02:06:25.910988+00`;
   `Date.parse` returns NaN for a bare `+00` offset. The first run compared
   **nothing** and reported every row as "skipped". A silent zero.
2. **Verdict on an empty set.** That first run printed `DETERMINISM_MATCH` for
   `0/0` — the most dangerous output an oracle can produce. Now
   `NO_COMPARISON_POSSIBLE`.
3. **Warmup.** A flat 12-day fetch gave 289 1H bars against production's 300, on
   the slot carrying 3,184 of 3,850 observations. Per-timeframe warmup now
   reaches full depth before the window opens, and any window short of 300 bars
   is skipped rather than compared.

---

## 6. Data inventory (Stage 1K)

### 6.1 What the IPO programme left, and why almost none of it helps

| cache | contents | usable for Zone research? |
|---|---|---|
| `/tmp/td-1m-corpus.json` (195 MB) | 1m, EUR/USD · USD/JPY · BTC/USD, 315 days across 5 windows 2021–2026 | **Partly.** Only 3 of 12 pairs, and none of the dates overlap the scanner's live window |
| `/tmp/td-htf-windows.json` (4.9 MB) | 1h/30min, same 3 instruments, 26 window keys | no — wrong pairs, wrong dates |
| `/tmp/v2-exp2-context-series.json` (6.1 MB) | daily/weekly/4H/1H, same 3 instruments | daily and weekly are reusable as *context* only |
| `/tmp/v2-exp3-daily.json` | daily 2019→2026, 3 instruments | reusable |
| `/tmp/v2-exp3-htf.json` | 1h/30min, 4 unseen windows | no |

**The IPO cache is largely unusable for this programme.** It covers 3 instruments;
the SMC scanner trades 12. It contains no 5m and no 15m data at all — the two
timeframes the scalper path actually detects impulses on.

### 6.2 What this stage fetched

Genuinely missing, and the minimum needed for the oracle:

| | |
|---|---|
| new requests | **33** — 11 pairs × {5m, 15m, 1h} |
| coverage | 5m from 2026-09-11, 15m from 2026-09-07, 1h from 2026-08-14, all to 2026-09-25 |
| bars per pair | ~4,033 · 1,729 · 1,009 |
| provider | Twelve Data (matching production) |
| 429s / errors | 0 / 0 |
| cached at | `/tmp/zone-stage1-candles.json` — not committed |

---

## 7. Funnel (Stage 1O) — from production records, not from the replay

Because it is read from `scan_logs` rather than re-derived, this funnel does not
depend on the determinism result.

```
scan details with a zone verdict          6,049
  no_impulse                              2,166   (35.8%)
  no_zone (leg, but no POI in Fib band)      33   ( 0.5%)
  zone exists                             3,850   (63.6%)
      watching   price never arrived      2,462   (63.9% of zones)
      at_zone    arrived, unconfirmed       949   (24.6%)
      confirmed                             225   ( 5.8%)
      triggered                             214   ( 5.6%)

scanner outcomes over the same window
  watching_zone                           2,458
  skipped_no_impulse_zone                 2,197
  skipped_weak_zone (score < minZoneScore)  367
  trade_placed_at_zone                       17
```

**Where selectivity actually lives:** 36% of evaluations have no impulse at all,
and of the zones that do form, **64% are never reached by price**. The Fib-band
filter rejects almost nothing (33 of 3,883). The zone-score gate rejects 367.
Seventeen trades were placed.

The `no_zone` count being 33 against 3,850 is itself a finding: once a valid
impulse exists, a POI in the 0.5–0.786 band is found essentially always. That
filter is not doing selection work.

---

## 8. Component attribution (Stage 1S)

Prepared, not applied. Every oracle row in
`/tmp/zone-stage1-oracle-result.json` carries the production `selectedTF`,
`state`, zone `type`, `fibLevel`, `srConfirmed`, `htfLayers`, `totalScore`,
`liquidityScore`, `confirmation.type` and `scoreBreakdown`. That is enough to tag
later ablations without re-running anything. **No component was removed or
varied in this stage.**

---

## 9. Blockers, in the order they must be cleared

1. **Turn on `scan_candle_snapshots`.** Until the scanner persists the candles it
   scored, no determinism test of any SMC engine is possible. This is a
   production change and is **not** made here. It is the single highest-value fix
   for the whole programme.
2. **Explain AUD/USD 37.3%** before trusting any aggregate.
3. **Decide the replay contract for H1.** A whole-series replay of
   `validateImpulseFromBOS` is invalid. A causal replay must feed the engine a
   growing prefix, exactly as `ipoLiveEngine` does — that pattern already exists
   in this repository and should be reused rather than reinvented.
4. **Resolve H5/H6** — whether the scanner's last bar is closed or forming. The
   answer changes `priceAtZone`, and therefore the state machine, on every scan.
5. **No cost model exists.** One must be specified before any R figure is quoted.
6. **No strategy version constant.** A baseline that can only be pinned by a git
   commit cannot be attributed later.

---

## 10. What was deliberately NOT done

No threshold changed. No filter added or removed. No ATR, directional-ratio,
overlap, path-efficiency, body-dominance, BOS/CHoCH, FVG, OB, max-age, timeframe,
entry, stop, target, direction, confluence or structure rule touched. No
profitability figure produced — the determinism gate did not pass, and Stage 1Q
is conditional on it. No production module edited; the harness imports
`findUnifiedZone` and `detectLiquidityPools` and contains no copy of any rule.
No database write, no migration, no cron change, no deployment, no secret.

---

## 11. Recommended next stage

**Stage 2 — causal replay contract**, and nothing else yet:

1. Enable `scan_candle_snapshots` in production (small, additive, its own review).
2. Build a prefix-feeding replay for the zone engine on the `ipoLiveEngine`
   pattern, so H1 cannot fire.
3. Re-run the oracle against snapshots once they exist, and only then claim
   determinism.
4. Resolve the AUD/USD anomaly.

Profitability remains out of scope until a replay is proven causal. The IPO
programme measured a +0.585R "edge" that fell to −0.067R under exactly this
correction; the same mistake is available here and H1 is a larger hole than the
one that caused it.
