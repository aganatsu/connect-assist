# IPO 1-minute intrabar resolution — stage 2

**Research only. No strategy logic changed. No baseline replaced. No deployment.
No database mutation.** Continues stage 1 (`db156a87`), which is not rewritten.
Dated 2026-09-23.

---

## 0. Headline

Twelve Data is **conclusively** the historical provider — 96.5% of stored bars
are exact four-field matches — so 86 of 87 same-bar trades resolve as genuinely
`SOURCE_MATCHED`, not as a cross-feed guess.

On those trades the recorded edge does not survive:

| | n | HTF recorded | corrected |
|---|---|---|---|
| same-bar, resolved at 1m | **58** | **+63.72R** | **−45.29R** |
| same-bar, unresolved at 1m | 29 | +33.00R | *unknown* |
| multi-bar (unaffected) | 77 | −21.65R | −21.65R |

**Portfolio as recorded +75.07R; corrected −66.94R**, excluding the 29 trades
that 1-minute data still cannot order. The direction of the correction is not
marginal and it is not rescued by the unresolved remainder — even if all 29 were
full 2R wins they would add about +50R, leaving the portfolio negative.

This is reported as a **PROVISIONAL RESEARCH RESULT**. It is not a corrected
baseline and the locked 1,039-trade table is untouched.

---

## 1. Twelve Data attribution methodology (Part A)

The production fetch was MetaAPI → Twelve Data → Polygon and the runner
discarded which answered. Attribution is therefore recovered by **evidence**:
fetch Twelve Data's own history for the stored timestamps and compare field by
field. A tape that reproduces all four of a bar's numbers exactly is the tape
that produced it.

Classes, tightest first, with no tolerance widening:

| class | definition |
|---|---|
| `TWELVE_EXACT_MATCH` | `stored === twelve` on O, H, L **and** C. Allows only serialization differences — Twelve Data returns strings, so `Number()` makes `"85940.32"` and `85940.32` equal. **No tolerance on the value.** |
| `TWELVE_NORMALIZED_MATCH` | equal after rounding to the instrument's own quote precision (5dp FX, 3dp JPY, 2dp BTC). For float artefacts only. Reported separately, never merged into exact. |
| `TWELVE_CLOSE_MATCH_BUT_NOT_PROVEN` | max field divergence ≤ 0.05%. **Not an attribution** — two venues quoting a liquid market agree closely, so "small" says nothing about identity. |
| `TWELVE_MISMATCH` | beyond that |
| `TWELVE_NO_DATA` / `TWELVE_API_ERROR` | no comparison possible |

**Only `TWELVE_EXACT_MATCH` earns `SOURCE_MATCHED`.** A test asserts the gate.

**Absence of a match rules down Twelve Data only.** MetaAPI is also in the chain
and no Polygon credential is held, so a mismatch does not identify the
alternative. Those bars stay unattributed; nothing concludes "therefore Polygon".

### Attribution counts — all 3,764 stored bars

| instrument | exact | normalized | close-not-proven | mismatch | no data |
|---|---|---|---|---|---|
| EUR/USD | 1208 | 0 | 32 | 0 | 0 |
| USD/JPY | 1216 | 4 | 63 | 0 | 0 |
| BTC/USD | 1208 | 0 | 26 | 7 | 0 |
| **portfolio** | **3632** | **4** | **121** | **7** | **0** |

**96.5% exact.** Divergence on the non-exact remainder: EUR/USD max 0.0175%,
USD/JPY max 0.0398%, BTC/USD max 0.0910% — consistent with those bars having
been served by a different link in the fallback chain, which is exactly what a
fallback chain does.

### Attribution of the 87 same-bar entry bars

| instrument | trades | exact | close-not-proven |
|---|---|---|---|
| EUR/USD | 40 | 40 | 0 |
| USD/JPY | 33 | 33 | 0 |
| BTC/USD | 14 | 13 | 1 |

86 `SOURCE_MATCHED`, 1 `CROSS_FEED_REFERENCE` — and the one exception is the
BTC incident bar itself, 2026-09-23T14:00Z.

---

## 2. 1-minute availability and integrity (Parts B, C)

Twelve Data served 1-minute data for **every** window requested, back to
2026-08-22, for all three instruments. No plan/history limit was hit.

Three layers of evidence before any resolution:

```
1m aggregate  ──vs──  Twelve Data's own HTF bar   (limit 0.05%)
1m aggregate  ──vs──  the stored engine bar        (recorded)
```

Minutes outside the HTF bar are discarded with a half-open window
`t >= start && t < end`; including the boundary minute would be lookahead of a
different flavour. Zero trades were refused for aggregate divergence or absent
minutes.

API usage: **47 requests total** (3 attribution + 44 minute-days), 43 cache
hits on re-run, **0 errors, 0 rate-limit responses**. Minutes are cached per
instrument-day in `/tmp`, market data only, no credential. Nothing is committed.

---

## 3. Resolution results (Parts D, E, G, H)

### Entry-bar outcome at 1m

| | EUR/USD | USD/JPY | BTC/USD | total |
|---|---|---|---|---|
| `TARGET_AFTER_ENTRY` | 7 | 9 | 2 | **18** |
| `S2_CLOSE_AFTER_ENTRY` | 11 | 0 | 3 | **14** |
| `STILL_OPEN_AT_BAR_END` | 5 | 13 | 8 | **26** |
| `UNRESOLVED_AT_1M` | 17 | 11 | 1 | **29** |
| `FEED_DIVERGENT` / `MISSING_DATA` | 0 | 0 | 0 | **0** |

### Forward replay of the 26 that survived their entry bar (Part F)

| | EUR/USD | USD/JPY | BTC/USD | total |
|---|---|---|---|---|
| eventual `TARGET` | 9 | 17 | 3 | **29** |
| eventual `S2_CLOSE` | 14 | 5 | 10 | **29** |
| `AMBIGUOUS_LATER_BAR` | 0 | 0 | 0 | **0** |
| still unresolved | 17 | 11 | 1 | **29** |

No later bar contained both decisive events, so the flag never fired. That is a
measurement, not an assumption — the check exists and reported zero.

### R, per instrument

| instrument | resolved | HTF recorded | corrected | delta |
|---|---|---|---|---|
| EUR/USD | 23 | +33.24 | **−16.13** | −49.37 |
| USD/JPY | 22 | +19.35 | **−3.82** | −23.17 |
| BTC/USD | 13 | +11.13 | **−25.34** | −36.47 |
| **total** | **58** | **+63.72** | **−45.29** | **−109.01** |

Losses exceed 1R routinely because S2 exits are priced at the invalidating
close, which can sit far beyond the level — a known and unchanged property of
the rule, now measured against real minutes instead of an hourly proxy.

### BTC: Twelve Data vs Bitstamp (Part H)

Stage 1 resolved the same 14 BTC trades on Bitstamp. The two feeds agree on
**every** entry-bar classification and every forward outcome. Corrected R:
Bitstamp −23.70R, Twelve Data −25.34R across the 13 resolvable trades.

Provider sensitivity is therefore real but second-order: the residual difference
is feed noise on exit pricing, not a disagreement about what happened. Both
feeds contradict the HTF record on the same 11 trades, including the incident.
Stage 1's Bitstamp rows keep their `VENUE_SPECIFIC` label and are **not**
relabelled.

### Residual ambiguity, and why it is large (Part E)

**29 of 87 same-bar trades — a third — still cannot be ordered at 1 minute.** In
each, the minute that first touched the entry also reached the target. The
reason is structural: IPO risk distances are small, so a 2R target sits close
enough that a single minute can span both. EUR/USD 17, USD/JPY 11, BTC 1 —
heaviest exactly where risk distances are tightest.

These need tick data. No result is invented for them, and the +33.00R they carry
is excluded from the corrected figure rather than assumed either way.

One ordering assumption is documented and used: **a close is the last event of
its minute**, so a minute reaching target and closing beyond S2 resolves as
target. No ordering is inferred between a high and a low within a minute.

---

## 4. Baseline coverage (Part J)

**The locked table is not edited.** EUR/USD 341 @ +0.758R, USD/JPY 558 @
+0.550R, BTC HIGH_VOL 140 @ +0.301R, portfolio 1,039 @ +0.585R stand as written.

Coverage measured here is over the **164-trade replay of currently persisted
bars**, not over the 1,039 validation trades, whose candle windows are not
stored locally:

| | n | share |
|---|---|---|
| causally unaffected (multi-bar) | 77 | 47.0% |
| source-matched **and** resolved | 57 | 34.8% |
| cross-feed and resolved | 1 | 0.6% |
| source-matched, unresolved at 1m | 29 | 17.7% |
| source unknown | 0 | 0% |
| data unavailable / API-limited | 0 | 0% |

The 1,039 baseline was produced by the same engine over the same instruments, so
the same mechanism applies to it. Extending this measurement to it requires
re-fetching the 15 validation windows — now clearly feasible, since Twelve Data
served every window asked for here.

**No corrected portfolio expectancy is published.** The figure in §0 is a
provisional research result over 164 replayed trades with 17.7% of the affected
population still unresolved.

---

## 5. Provider/venue findings

- Twelve Data is the dominant historical source: **96.5% exact** across all
  stored bars, **98.9%** across same-bar entry bars.
- The fallback chain demonstrably fired: 121 close-but-unproven and 7 mismatched
  bars are bars Twelve Data did not produce. Which link served them is still
  unrecoverable.
- Twelve Data BTC/USD is a **composite**, not a single venue. It agrees with
  Bitstamp on every classification, so for this corpus the venue question is
  measurable and small — but it is not zero and should not be assumed away for
  other instruments or periods.

---

## 6. Forward observability fix — DESIGN ONLY (Part L)

No schema change, no runner change, no migration in this branch.

**Where the value exists and where it dies.** `fetchCandlesWithFallback` returns
`{ candles, source }` (`_shared/candleSource.ts`). `ipo-paper-runner/index.ts:303`
does:

```ts
const { candles } = await fetchCandlesWithFallback({ … });
```

`source` is discarded at that destructure. It is the only place it is lost.

Proposed fields on `ipo_paper_positions` and `ipo_paper_trade_history`, all
nullable so existing rows stay valid:

| field | |
|---|---|
| `market_data_provider` | `metaapi` \| `twelvedata` \| `polygon` |
| `market_data_symbol` | provider's symbol, verbatim |
| `market_data_timeframe` | the interval requested |
| `market_data_venue` | nullable; meaningful only where the provider is single-venue |
| `market_data_bar_time` | the bar that resolved the event |

`execution_data_provider` / `execution_venue` are worth reserving for when
execution stops being synthetic, but have no meaning in paper mode and should
not be added speculatively.

This is deliberately kept out of the research result: it fixes the next year of
data, not this one.

---

## 7. Blockers and what is not answered

- **29 trades need tick data.** 1-minute is insufficient for a third of the
  affected population, and the proportion will be worse on tighter-risk setups.
- **The 1,039 baseline is not re-measured.** Feasible now; not done here.
- **121 + 7 bars remain unattributed.** No Polygon credential, and MetaAPI is in
  the chain, so their source stays unknown.
- **No corrected baseline exists**, by design.

---

## 8. Statement

No IPO detection, lifecycle, contraction, FVG, direction, E2 entry, S2
invalidation, 2R target, re-entry, sequencing, volatility or cost rule was
changed. S2 remains close-confirmed at every resolution. No SMC code, no broker
execution, no LIVE/CANARY behaviour, no cron, no schema, no database row,
nothing deployed. The research module has no importer in application code and a
test enforces that. The locked 1,039-trade baseline is untouched.
