# IPO-CET-v2 Experiment 3 — unseen validation of the HTF-OPPOSED filter

**Research only. No production behaviour changed: no SMC rule, no IPO rule, no
exit change, no schema, no cron, no deployment, no database write, no live flag.**
Branch `research/ipo-v2-htf-opposed-unseen`. Dated 2026-09-24.

---

## 1. Verdict

```
HTF_OPPOSED_FAILS_VALIDATION
```

The pre-registered hypothesis does not survive on unseen data.

| true filtered replay, unseen | n | ret% | win% | BE% | gap | avgW | avgL | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A_BASELINE** | 662 | 100 | 66.9 | 62.0 | +4.9 | 1.53 | −2.49 | **+0.197** | **1.24** | **+130.3** | 32.4 |
| **B_HTF_OPPOSED** | 191 | 29 | 63.4 | 58.6 | +4.7 | 1.60 | −2.26 | **+0.182** | 1.22 | +34.8 | **22.3** |
| C_HTF_ALIGNED *(diagnostic)* | 260 | 39 | 70.8 | 63.2 | +7.5 | 1.49 | −2.57 | **+0.306** | **1.41** | +79.5 | 34.1 |
| D_RANGING | 230 | 35 | 64.3 | 63.2 | +1.1 | 1.52 | −2.62 | +0.046 | 1.05 | +10.5 | 16.4 |
| E_UNKNOWN | 0 | — | — | — | — | — | — | — | — | — | — |

H3 says opposed should beat aligned. **Aligned beats opposed by +0.124R**, and
opposed does not even beat doing nothing (−0.015R against baseline) while
discarding 71% of the trades. The discovery contrast was **+0.44R** in favour of
opposed; unseen it is **−0.124R** against.

The sign of the discovered effect inverted. I have not called this
`HTF_OPPOSED_REVERSES`, because the inversion is not clean: opposed still beats
aligned in **3 of 4 windows** and on EUR/USD (§14, §15). The pooled reversal is
produced by a single window. That is a failure to validate, not a demonstrated
opposite law.

---

## 2. Pre-registered hypothesis (H3), fixed before the run

> The IPO strategy has higher expectancy when the IPO direction is OPPOSITE
> Daily market structure.

```
LONG  IPO + Daily BEARISH  -> take     (OPPOSED)
SHORT IPO + Daily BULLISH  -> take     (OPPOSED)
LONG  IPO + Daily BULLISH  -> reject   (ALIGNED)
SHORT IPO + Daily BEARISH  -> reject   (ALIGNED)
Daily RANGING              -> reject, reported separately
Daily UNKNOWN              -> reject, reported separately
```

The sign was fixed in `local-runner/v2-exp3-htf-opposed.ts` before the unseen
data existed on disk and has not been changed, softened or re-cut.

---

## 3. Discovery reference — evidence of nothing

Experiment 2 found this **post-hoc**, on data already studied by v1, Stage 1–3
and Experiment 1: BOTH_OPPOSED +0.397R, PF 1.57, maxDD 15.8R, positive on all
three instruments, better in 4 of 5 windows. Those figures are **discovery**.
They appear here only in §17 and carry no validation weight.

---

## 4. Periods already consumed by prior IPO research

Assembled from `IPO_CET_V1_POSTMORTEM §15`, every period named in
`IPO_RESEARCH_FREEZE.md`, and every window key in the Stage 3 HTF cache. Each
`A..B` period is expanded to its full span, and **every ambiguity is resolved
toward CONSUMED**.

| period | source |
|---|---|
| 2020-03..2020-09 | postmortem §15 "2020-03 to 2020-08" read inclusively; freeze corpus rows + detector files |
| 2021-01..03 · 2021-03..06 · 2021-05..08 · 2021-09..11 | freeze — origin-anchor and untouched-validation studies |
| 2021-11..2022-02 | locked corpus window 1 (+ HTF cache key) |
| 2022-02..04 · 2022-04..07 · 2022-06..08 · 2022-08..10 · 2022-10..12 · 2022-12..2023-02 | freeze A1, volatility validation, locked corpus window 2 |
| 2023-02..04 · 2023-04..06 · 2023-06..08 · 2023-08..09 · 2023-09..12 · 2023-12..2024-02 | freeze anchor studies, locked corpus window 3, spill-over month, cache keys |
| 2024-01..04 · 2024-03..06 · 2024-06..09 · 2024-09..2025-01 | freeze §629-631 OOS grid and §803 A1 |
| 2025-01..04 · 2025-04..07 · 2025-06..08 · 2025-08..10 · 2025-10..12 · 2025-12..2026-01 | cache keys, freeze volatility validation, locked corpus window 4, postmortem inventory |
| 2026-01..03 · 2026-04..06 · 2026-06..08 · 2026-08..10 | freeze A1, locked corpus window 5, postmortem inventory, live IPO paper forward test |

**71 distinct calendar months consumed.** Everything from 2021-09 to 2026-08 is
consumed except two isolated months.

---

## 5. Unseen window selection — mechanical, fixed in code before any replay

The rule is implemented in `v2-exp3-unseen-fetch.ts`, not applied by hand:

1. `CONSUMED` = the union above.
2. `ELIGIBLE` = months not in `CONSUMED`, with provider 1-minute coverage, ending
   before the live forward test (2026-09).
3. Each maximal contiguous run of eligible months is partitioned into consecutive
   2-month end-exclusive windows from the run's start; a residual single month
   becomes a 1-month window.
4. **All** resulting windows are used — no ranking, no scoring, no substitution,
   no dropping. There is nothing to bias because there is no choice.

**The 1-minute boundary was probed, not assumed.** 2016-03, 2017-03, 2018-03,
2019-03, 2020-01-06 and 2020-02-04 all return *no data* for EUR/USD, USD/JPY and
BTC/USD; 2020-04-07 onward returns full days. Everything before 2020-04 is
therefore ineligible regardless of whether research touched it, because the
causal execution model needs minutes. This is why the untouched pre-2020 history
named as "DISCOVERY" in the post-mortem cannot be used here.

**Eligible months (6):** 2020-09, 2020-10, 2020-11, 2020-12, 2021-08, 2026-03.

### The windows

| id | span (end-exclusive) | months |
|---|---|---|
| **u1** | 2020-09-01 .. 2020-11-01 | 2 |
| **u2** | 2020-11-01 .. 2021-01-01 | 2 |
| **u3** | 2021-08-01 .. 2021-09-01 | 1 |
| **u4** | 2026-03-01 .. 2026-04-01 | 1 |

**Four windows, not the five the brief asked for.** Data coverage does not
permit five: six untouched months exist, and two of them are isolated between
consumed neighbours. This shortfall is a pre-existing constraint — the
post-mortem's §15 already warned "the recent history is largely exhausted" — and
it is reported rather than worked around by relaxing the consumed set.

**Independent corroboration that the windows are genuinely unseen:** of the 552
instrument-days these windows require, **0 were present in the 1-minute corpus**
that five prior stages of research filled. Every one had to be fetched.

---

## 6. Frozen strategy rules

Unchanged, and asserted against the live engine source before the run:

```
cost priced at the ENTRY bar = true
same-bar re-entry FORBIDDEN  = true
HTF stop-first on the bar    = true
```

IPO detection, geometry, lifecycle, contraction, FVG requirement, direction
rules, E2 entry, S2 price, HTF close-confirmed S2, 2R target, re-entry
semantics, one-open-position-per-instrument, volatility handling (BTC remains
HIGH_VOL-only, still part of `IPO_INSTRUMENTS`), and the cost model are all as
frozen. Setup timeframes stay EUR/USD 1H, USD/JPY 30m, BTC/USD 1H. No filter was
added beyond the single Daily-structure gate under test.

---

## 7. Causal execution model

The Experiment 1 reconstructed control, unchanged. Entry is the first minute
inside the entry bar that reaches E2. From there the tape is walked forward:
target is tested **every minute**; **S2 is tested only at HTF bar closes** — the
original close-confirmed rule, untouched. No 1m S2, no 5m S2, no hard 1R stop;
this experiment is not about exits.

Where the minute tape cannot order entry and target — both inside the same
minute — the trade is `TICK_REQUIRED` and no guess is made. That happened 32
times in the baseline (4.6%).

**Sequencer validated on the unseen data:** with its gate wired open it
reproduces `ipoLiveEngine.replay()` **field-for-field on all 695 trades across
all 12 unseen window-instruments** — entry index, exit index, ipo index,
direction, volatility bucket, entry, stop, target, risk, costR, realised R.

---

## 8. Daily structure reconstruction

`analyzeMarketStructure(dailyCandles).trend` from `smcAnalysis.ts` — the value
bot-scanner calls `htfTrend`. Parameters untouched; detection not redesigned.

Read at the **entry bar's OPEN**, from daily candles that had **fully closed** at
or before that instant, sliced to bot-scanner's `DEFAULT_CANDLE_LIMIT` of 300.
The in-progress daily bar is never included, so nothing the entry bar did can
reach the structure read. This is stricter than production, which sees a partial
daily bar at scan time.

Daily history runs from 2019-01-02, so the 300-bar depth is satisfied at every
decision point in every window: **`UNKNOWN` never occurred** (0 of 695).

### Data quality

All 12 setup-timeframe series and all 3 daily series: **0 duplicates, 0
out-of-order bars, 0 non-UTC timestamps, 0 non-finite values, 0 malformed OHLC,
0 decimal-shift bars** — including BTC, which carries no corruption in these
windows. Maximum gaps are weekend-sized for FX (47–107 bars) and 1 bar for BTC.

Aggregation cross-check, minutes rolled up against the provider's own setup
bars, first 200 bars of every window-instrument: **2,391 of 2,391 agree within 5%
of bar range, worst deviation 0.0%.**

---

## 9. Baseline on unseen data

```
695 trades taken · 662 resolved · 32 TICK_REQUIRED · 1 STILL_OPEN
662 · 66.9% win · BE 62.0% · gap +4.9 · avgW 1.53 · avgL −2.49
+0.197R · PF 1.24 · +130.3R · maxDD 32.4R · longest +14 / −6
```

Worth noting before anything else: **the frozen strategy is more profitable on
this unseen data than on the corpus it was built from** (+0.197R vs Experiment
1's +0.125R, PF 1.24 vs 1.14). Win rate is 66.9% against 61.4%. These are
different regimes, and that matters for everything below.

Per instrument: EUR/USD 185 @ +0.193R PF 1.21 · USD/JPY 412 @ +0.152R PF 1.18 ·
**BTC/USD 65 @ +0.492R PF 1.97** — BTC, negative in every prior study, is the
best instrument here.

---

## 10. HTF_OPPOSED result

```
candidates 1,019 · accepted 194 · refused 825 · resolved 191 · TICK_REQUIRED 3
191 · 63.4% win · BE 58.6% · gap +4.7 · avgW 1.60 · avgL −2.26
+0.182R · PF 1.22 · +34.8R · maxDD 22.3R · longest +11 / −4
retention 29% of baseline · 511 baseline trades dropped · 10 freed-slot admissions
```

It is profitable in absolute terms, it lowers the required break-even rate from
62.0% to 58.6%, and it cuts drawdown from 32.4R to 22.3R. It is also **worse per
trade than not filtering at all**, and it forgoes 95.5R of the baseline's 130.3R.

---

## 11. Aligned diagnostic — the side H3 predicted would be weak

```
260 · 70.8% win · BE 63.2% · gap +7.5 · +0.306R · PF 1.41 · +79.5R · maxDD 34.1R
```

The cohort the hypothesis says to throw away is the best-performing cohort in the
experiment: higher win rate, higher expectancy, higher profit factor and more
than twice the total R of the opposed cohort.

---

## 12. Ranging and unknown

| | n | win% | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|
| D_RANGING | 230 | 64.3 | +0.046 | 1.05 | +10.5 | 16.4 |
| E_UNKNOWN | 0 | — | — | — | — | — |

Ranging is a third of the population and is close to flat — the one part of the
picture that behaves as a directional-context story would predict. Nothing was
discarded silently: OPPOSED 187 + ALIGNED 269 + RANGING 239 = 695 baseline
trades, asserted.

---

## 13. Per instrument (true filtered replay)

| | filter | n | win% | BE% | gap | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| **EUR/USD** | baseline | 185 | 64.9 | 60.4 | +4.5 | +0.193 | 1.21 | +35.6 | 19.7 |
| | **opposed** | 56 | 69.6 | 57.1 | +12.5 | **+0.497** | **1.72** | +27.9 | **7.1** |
| | aligned | 87 | 64.4 | 61.5 | +2.9 | +0.127 | 1.13 | +11.1 | 14.9 |
| | ranging | 52 | 59.6 | 61.5 | −1.9 | −0.083 | 0.92 | −4.3 | 18.9 |
| **USD/JPY** | baseline | 412 | 66.0 | 62.2 | +3.9 | +0.152 | 1.18 | +62.7 | 28.1 |
| | **opposed** | 123 | 61.8 | 59.3 | +2.4 | **+0.094** | 1.11 | +11.6 | 26.3 |
| | aligned | 123 | 69.9 | 63.0 | +6.9 | **+0.267** | 1.36 | +32.9 | 21.0 |
| | ranging | 174 | 65.5 | 63.1 | +2.4 | +0.099 | 1.11 | +17.2 | 14.6 |
| **BTC/USD** | baseline | 65 | 78.5 | 64.9 | +13.6 | +0.492 | 1.97 | +32.0 | 5.2 |
| | **opposed** | 12 | 50.0 | 61.7 | −11.7 | **−0.387** | 0.62 | −4.6 | 9.0 |
| | aligned | 50 | 84.0 | 65.4 | +18.6 | **+0.711** | 2.78 | +35.6 | 5.0 |
| | ranging | 4 | 75.0 | 88.0 | −13.0 | −0.599 | 0.41 | −2.4 | 4.1 |

**EUR/USD replicates the discovery cleanly** — opposed +0.497 against aligned
+0.127, a +0.370R contrast where discovery showed +0.443R, with the lowest
drawdown in the table.

**USD/JPY and BTC/USD reverse it.** USD/JPY by −0.173R, BTC by −1.098R. BTC's
opposed cohort is 12 trades against 50 aligned, so its magnitude means little,
but its sign agrees with USD/JPY and disagrees with the hypothesis.

Nothing is hidden: opposed is negative on one of three instruments and below
baseline on two of three.

---

## 14. Long versus short

| filter | side | n | win% | BE% | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|---|
| baseline | LONG | 342 | 67.8 | 61.7 | +0.247 | 1.31 | +84.6 | 32.2 |
| | SHORT | 320 | 65.9 | 62.4 | +0.143 | 1.17 | +45.7 | 25.8 |
| **opposed** | LONG | 100 | 63.0 | 58.2 | **+0.183** | 1.22 | +18.3 | 17.8 |
| | SHORT | 91 | 63.7 | 59.1 | **+0.181** | 1.22 | +16.5 | 15.3 |
| aligned | LONG | 131 | 71.8 | 61.7 | +0.393 | 1.57 | +51.5 | 20.2 |
| | SHORT | 129 | 69.8 | 64.6 | +0.217 | 1.27 | +28.0 | 22.4 |

One genuine positive: **the opposed filter is direction-symmetric** — +0.183 long
versus +0.181 short, the most balanced split in any IPO experiment so far. Both
prior experiments found large long/short asymmetry, and here the baseline still
shows it (+0.247 vs +0.143). But aligned is better on *both* sides, so symmetry
is not worth the expectancy.

Note also that the long/short asymmetry has itself flipped sign against the
corpus: LONG is the stronger side here (+0.247 vs +0.143), where Experiment 2
found SHORT dominant (+0.206 vs +0.050).

---

## 15. Window consistency — and the single window that decides the answer

| window | span | base n | base expR | base PF | base totR | opp n | opp expR | opp PF | opp totR | ali n | ali expR | >base | >ali |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| u1 | 2020-09..11 | 205 | −0.012 | 0.99 | −2.4 | 75 | **+0.172** | 1.21 | +12.9 | 84 | −0.185 | **YES** | **YES** |
| u2 | 2020-11..2021-01 | 236 | +0.253 | 1.32 | +59.7 | 50 | **−0.219** | 0.81 | −11.0 | 97 | **+0.744** | no | no |
| u3 | 2021-08 | 88 | +0.495 | 1.77 | +43.5 | 24 | **+0.650** | 2.24 | +15.6 | 30 | +0.258 | **YES** | **YES** |
| u4 | 2026-03 | 133 | +0.221 | 1.26 | +29.4 | 42 | **+0.411** | 1.64 | +17.3 | 49 | +0.309 | **YES** | **YES** |

**Positive in 3 of 4 windows. Beats baseline in 3 of 4. Beats aligned in 3 of 4.**

And yet it loses pooled, because **u2 alone reverses the total**. In u2 the
aligned cohort earns +0.744R over 97 trades while opposed earns −0.219R over 50,
and the aligned advantage holds on every instrument in that window:

| u2, 2020-11..2021-01 | opposed | aligned |
|---|---|---|
| EUR/USD | +0.292 (n=14) | +0.458 (n=28) |
| USD/JPY | −0.288 (n=29) | +0.795 (n=37) |
| BTC/USD | −0.957 (n=7) | +0.934 (n=32) |

u2 is the November–December 2020 trend: BTC running from ~13k to ~29k, the
dollar falling steadily. In a strongly trending window, trading *with* structure
wins and fading it loses — which is a coherent story, and exactly the kind of
story I must not now adopt as a rule. It was not pre-registered, it rests on one
window, and turning "the sign depends on regime" into a filter would be the
post-hoc rescue this experiment is forbidden to attempt.

The honest reading is narrower: **with four windows, one window determines the
sign of the pooled contrast.** That is a statement about how little unseen data
exists, not about markets.

---

## 16. Concentration

HTF_OPPOSED, +34.8R over 191 trades.

| grouping | best subgroup | share of n | share of profit |
|---|---|---|---|
| instrument | EUR/USD | 29% | **80%** |
| direction | LONG | 52% | 53% |
| window | u4 | 22% | 50% |
| *(finer, not pre-registered)* | **EUR/USD LONG** | **19%** | **59%** — flagged |

Under the pre-registered test — instrument, direction, window — **no subgroup is
under 20% of trades while carrying over 50% of profit**, so criterion 6 passes as
written. I am not widening the test after the fact; I am reporting that the finer
instrument×direction grouping does trip it, because presenting only the narrower
scope would be misleading. EUR/USD LONG is 36 trades carrying +20.5R of +34.8R.

EUR/USD carries 80% of the profit on 29% of the trades, USD/JPY 33% on 64%, and
BTC is −13%.

---

## 17. Discovery versus unseen

| | expR | PF | maxDD |
|---|---|---|---|
| discovery, Exp 2, already-studied data | **+0.397** | **1.57** | 15.8R |
| **unseen validation** | **+0.182** | **1.22** | 22.3R |
| same-run baseline | +0.197 | 1.24 | 32.4R |
| same-run aligned | +0.306 | 1.41 | 34.1R |

```
opposed minus baseline      +0.27R  (discovery)  ->  -0.015R  (unseen)
opposed minus aligned       +0.44R  (discovery)  ->  -0.124R  (unseen)
fraction of discovery expectancy retained: 46%
```

Classification: **effect reversed** on both contrasts, with 46% of the raw
magnitude surviving in absolute terms but none of the *advantage* that made it
interesting.

### Pre-registered success criteria

| # | criterion | result | |
|---|---|---|---|
| 1 | expectancy > +0.15R after costs | +0.182R | PASS |
| 2 | PF ≥ 1.20 | 1.22 | PASS |
| 3 | positive total R | +34.8R | PASS |
| 4 | positive in ≥ 60% of unseen windows | 3/4 | PASS |
| 5 | no catastrophic drawdown increase vs baseline | 22.3R vs 32.4R | PASS |
| 6 | no tiny subgroup explains majority of profit | clean at pre-registered scope | PASS |
| 7 | retained trade count meaningful | 191 (29%) | PASS |
| 8 | at least 2 instruments positive | 2 of 3 | PASS |

**8 of 8 — and the hypothesis still fails.** This is a defect in the criteria, not
a rescue of the rule. Every criterion is an *absolute* threshold; not one of them
asks whether the filter beats not filtering, and H3 is a *comparison*. A filter
that keeps 29% of trades and earns less per trade than the unfiltered strategy
has no reason to exist, whatever absolute bar it clears. Both stronger-evidence
bars are missed as well (PF 1.22 < 1.30; expR +0.182 < +0.200).

I am recording the criteria as passed, because they were pre-registered and they
passed. The verdict is driven by the hypothesis, which they failed to encode.

---

## 18. Limitations

1. **Four windows, not five.** Six untouched months exist in the entire
   1m-covered history; two are isolated singletons. Coverage, not choice.
2. **Six months of unseen data against the corpus's ten.** 695 baseline trades
   versus 1,021, and 191 retained opposed trades. Small.
3. **One window flips the pooled answer** (§15). With n=4 windows the pooled
   contrast is not stable.
4. **The unseen windows are leftovers.** They are the gaps prior research
   skipped. They were not chosen by me for this test and the rule that produced
   them is mechanical, but they are not a random sample of history either.
5. **Regimes are not comparable.** The baseline is *more* profitable here than on
   the corpus (+0.197 vs +0.125), BTC flips from the worst instrument to the
   best (+0.492R, PF 1.97), and the long/short asymmetry reverses. Some of the
   contrast with discovery is regime, not the filter.
6. **Two of four windows are one month long** (u3, u4), giving the volatility
   classifier less warmup and BTC very few HIGH_VOL entries — 2 trades in u3.
7. **BTC's opposed cohort is 12 trades.** Its −0.387R is directionally
   informative at best.
8. **35 trades are unresolved across the baseline** (32 TICK_REQUIRED, 1
   STILL_OPEN), excluded identically from every cohort.
9. **Pre-2020 history is untouched but unusable** — no 1-minute data before
   2020-04, so the causal execution model cannot be applied there. The
   post-mortem's proposed 2017–2019 discovery block is closed off for any
   experiment that needs intrabar ordering.

---

## 19. Answering the question

> Does the HTF-opposed effect survive out of sample?

**No.** `HTF_OPPOSED_FAILS_VALIDATION`.

Pooled on unseen data the filter earns less per trade than the unfiltered
strategy it is supposed to improve, and the cohort H3 says to discard outperforms
the cohort it says to keep. The +0.44R advantage found in discovery came back as
−0.124R.

What did survive is narrower and should not be overstated: opposed beats aligned
in 3 of 4 windows and replicates cleanly on EUR/USD (+0.497 vs +0.127, drawdown
7.1R). That is the same instrument that has carried every positive IPO result
since Stage 3, which makes it a candidate for a *separate* pre-registered
EUR/USD hypothesis — not evidence for this one.

No rule is proposed, nothing is adopted, and nothing about the live system
changes. The Experiment 2 finding is now closed: it was a property of the data it
was discovered on.

---

## 20. Statement

No IPO detection, geometry, lifecycle, contraction, FVG, direction, E2 entry, S2
price, S2 confirmation timeframe, 2R target, re-entry, sequencing, volatility or
cost rule was changed. No exit was modified. The SMC direction verdict was not
used. `analyzeMarketStructure` was called unmodified with default parameters. No
threshold was swept, no timeframe searched, no instrument or window dropped after
seeing results, no session or supply-only filter added, no sign flipped. No
production module, schema, cron, RLS policy, live flag, paper runner, broker path
or UI default was touched, and no database row was read or written. Research
artifacts are local; no market-data cache is committed and no credential appears
in any file, log or diff.

### Data and API accounting

| | |
|---|---|
| setup-timeframe series — cache hits / new | **0 / 12** |
| daily context — cache hits / new | **0 / 3** (the Exp 2 daily series began 2020-06, too late for a 300-bar depth at 2020-09) |
| 1-minute instrument-days — cache hits / new | **0 / 552** |
| new API requests | **207** (12 setup + 3 daily + 192 three-day 1m blocks) |
| new instrument-days fetched | 576 |
| 429s / retries / errors | 0 / 0 / 0 |
| replay + candidate-table pass | 41.1 min, **0 API requests** |
| cache deleted or overwritten | none — the 1m corpus was extended, never rewritten |

Zero cache hits is itself the evidence that these windows are unseen: five prior
stages of IPO research had never fetched a single day of them.
