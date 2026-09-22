# IPO Fibonacci / Confluence Study — descriptive

**2026-09-21. Measurement only.** No strategy rule changed. The official causal
baseline (§11 of `IPO_FORWARD_TRADING_SPEC.md`) is untouched: E2 entry, A1 FVG
requirement, S2 invalidation, T_2R, volatility rule and sequential handling are
all exactly as frozen.

Module: `ipoFibConfluence.ts` (+13 tests). Own ratio constants; production
`smcAnalysis.RETRACE_RATIOS` is unmodified and a test asserts it.

---

## The two "50%" are kept separate

| | what it is | used for |
|---|---|---|
| **IPO candle geometry** | `distal = (high + low) / 2` of ONE candle | the frozen E2 entry. **Not Fibonacci.** Not renamed here |
| **Swing Fibonacci** | retracement of the prior completed leg | confluence measurement only, this study |

Ratios measured: **0.500, 0.618, 0.710, 0.786, 0.886, 1.000** — 0.710 not 0.705;
0.886 and 1.000 added as IPO-only measurement features.

Stored per level: `INSIDE_ZONE`/`OUTSIDE_ZONE`, raw distance to the nearest zone
edge, and that distance normalised by **zone width** and by **ATR(14)**. No
proximity threshold exists in the detector.

**Sample: 9,527 causal valid-IPO touches** across 15 untouched windows, three
instruments. 99.9% had a completed swing reference. Baseline for all
comparisons: **n=9,527, win 63.9%, expR +0.187, PF 1.23.**

> *Basis caveat:* the IPO population is the batch lifecycle, which carries the
> known `hasFvg` +10-bar lookahead (§19). Every feature is computed causally on
> the prefix. Read these as **relative** feature comparisons on a common
> population, not as absolute expectancy.

---

## 1. Frequency inside IPO zones

| level | inside n | % of rows |
|---|---|---|
| 50.0 | 1,078 | 11.3% |
| 61.8 | 1,076 | 11.3% |
| 71.0 | 1,072 | 11.3% |
| 78.6 | 1,049 | 11.0% |
| 88.6 | 767 | 8.1% |
| 100.0 | 610 | 6.4% |

---

## 2. Outcome by individual level — **every level is negative**

| level | inside n | win% | expR inside | expR outside | spread |
|---|---|---|---|---|---|
| 50.0 | 1,078 | 55.2 | +0.006 | +0.210 | **−0.204** |
| 61.8 | 1,076 | 53.3 | −0.156 | +0.230 | **−0.386** |
| 71.0 | 1,072 | 56.8 | −0.097 | +0.223 | **−0.320** |
| 78.6 | 1,049 | 57.8 | −0.073 | +0.219 | **−0.292** |
| 88.6 | 767 | 57.4 | −0.181 | +0.219 | **−0.400** |
| 100.0 | 610 | 55.9 | −0.123 | +0.208 | **−0.330** |

No level shows positive separation. No ordering among them: the deepest levels
are not superior, and neither are the shallow ones.

## 3. Cluster count

| levels inside | n | win% | expR | vs baseline |
|---|---|---|---|---|
| 0 | 5,779 | 65.3 | +0.242 | +0.056 |
| **1** | **2,529** | **67.9** | **+0.297** | **+0.111** |
| 2 | 827 | 51.6 | −0.208 | −0.395 |
| 3 | 223 | 54.7 | −0.145 | −0.331 |
| 4 | 80 | 45.0 | −0.314 | −0.500 |
| 5 | 54 | 20.4 | −1.983 | −2.170 |
| 6 | 35 | 14.3 | −1.097 | −1.284 |

Exactly one level inside is the best cell. Two or more is progressively worse.

### The likely mechanism — and why the label matters

Adjacent IPO ratios are 0.118, 0.092, 0.076, 0.100 and 0.114 of the swing range
apart. **A zone can only span two levels if its width exceeds ~0.09 × swing
range.** So `cluster ≥ 2` is, by construction, largely a statement that *the IPO
candle is large relative to the prior leg* — a size ratio, not a Fibonacci
phenomenon.

The effect survives stratification, so it is real:

| cluster | FVG=N | FVG=Y | EUR/USD | USD/JPY | BTC/USD |
|---|---|---|---|---|---|
| 0 | −0.413 | +0.612 | +0.270 | +0.294 | −0.122 |
| 1 | −0.443 | +0.728 | +0.602 | +0.277 | −0.242 |
| 2 | −0.577 | −0.025 | +0.083 | −0.303 | −0.274 |
| 3 | −0.219 | −0.086 | −0.180 | −0.095 | −1.595 (n=5) |

But it should be **named for what it measures**. If it is carried forward it
should be re-derived directly as `zoneWidth / swingRange`, which is cleaner,
continuous, and does not imply Fibonacci is doing the work.

## 4. Interactions

| | n | expR |
|---|---|---|
| fib=N FVG=N | 2,084 | −0.413 |
| **fib=N FVG=Y** | **3,695** | **+0.612** |
| fib=Y FVG=N | 1,368 | −0.528 |
| fib=Y FVG=Y | 2,380 | +0.461 |

**FVG dominates, and fib presence subtracts from it** (+0.612 → +0.461).

S/R: fib=N S/R=Y +0.294 (n=813) vs fib=Y S/R=Y **−0.151** (n=771) — the S/R
benefit is erased when a fib level is also present.
HTF: no coherent pattern (−0.093 to +0.084).
Institutional: n=131/152 present — too thin to read.

## 5. Total confluence count (fib-any + FVG + S/R + HTF + INST)

| count | n | win% | expR |
|---|---|---|---|
| 0 | 1,539 | 51.1 | −0.349 |
| 1 | 3,869 | 65.7 | +0.216 |
| **2** | **2,906** | **68.2** | **+0.382** |
| 3 | 1,023 | 67.3 | +0.368 |
| 4 | 182 | 47.8 | −0.028 |
| 5 | 8 | 62.5 | −0.505 |

**Not monotone.** Peaks at 2–3 and reverses. "More confluence is better" is not
supported.

## 6. Simultaneous valid IPOs

- decision bars: 6,458 · **contested (>1 valid IPO): 1,966 (30.4%)**
- IPOs in contests: 5,035 · max at one bar: **28**
- group sizes: 2×1,373 · 3×382 · 4×108 · 5×60 · rest ≤28

**Selection policy, mean realized R over the 1,966 contested bars:**

| policy | mean R |
|---|---|
| first-touch / arrival order | **+0.281** |
| highest confluence | +0.248 (**−0.033**) |
| lowest confluence | +0.245 |
| take all | +0.264 |

**Paired within-bar tests** (removes the bar/market-state effect):

| comparison | n pairs | higher side won |
|---|---|---|
| higher vs lower confluence count | 1,120 | 622 (55.5%) |
| cluster ≤1 vs cluster ≥2 | 364 | low-cluster 147 (**40.4%**) |
| **FVG=Y vs FVG=N** | 671 | **340 (50.7%)** |

**This is the most important result in the study.** FVG separates by more than
1.0R in aggregate, yet **within a contested bar it is a coin flip (50.7%)**. The
same is true of the cluster effect, which reverses sign under pairing.

That means the aggregate feature effects are substantially **market-state**
effects — *which bars are favourable* — not **IPO-quality** effects — *which of
several simultaneous IPOs to pick*. A ranking layer needs the second, and this
study finds little of it.

## 7. Continuous distance (bands are analysis-time, not detector thresholds)

| nearest level, distance / zone width | n | expR |
|---|---|---|
| inside (0) | — | see §3 |
| 0 – 0.25 | 670 | +0.361 |
| 0.25 – 0.5 | 453 | +0.286 |
| 0.5 – 1 | 627 | +0.021 |
| 1 – 2 | 811 | +0.095 |
| > 2 | 3,212 | +0.295 |

Non-monotone in both normalisations. No distance band is a clean discriminator,
and no "near" threshold is suggested by the data.

---

## 8. Findings

1. **No individual Fibonacci level shows positive separation.** All six are
   negative, between −0.204 and −0.400. Depth does not order them.
2. **One level inside is the best cell; two or more is materially worse** — and
   that is probably a candle-size-to-swing ratio wearing a Fibonacci label.
3. **Fib presence does not add to FVG; it subtracts from it**, and it erases the
   S/R benefit.
4. **Confluence count is not monotone** — it peaks at 2–3 and reverses.
5. **Confluence-based selection did not beat first-come-first-served** on
   contested bars (+0.248 vs +0.281), and the paired tests are near coin-flip.
6. **There is no evidence that first-touch sequencing is inferior.** On this
   evidence it should not be replaced.

## 9. Candidate hypotheses for a later out-of-sample study

Stated as hypotheses, **not implemented, not weight-fitted**:

- **H1 — zone-width ratio, not Fibonacci.** `zoneWidth / swingRange` above a
  band predicts worse outcomes. Test it directly and continuously; if it holds,
  the fib framing should be dropped entirely.
- **H2 — exactly-one-level.** `cluster == 1` (+0.297 over 2,529) versus 0 and
  ≥2. Plausibly a restatement of H1; H1 should be tested first.
- **H3 — the market-state vs IPO-quality split.** Confirm on fresh data that
  features which separate in aggregate do not separate within a bar. If it
  replicates, confluence belongs in a *when to trade* filter, not a *which IPO*
  ranker.
- **H4 — contest frequency as an exposure signal.** 30.4% of decision bars are
  contested, up to 28 deep. The count itself may carry information independent
  of which one is chosen.

**Not recommended for testing:** individual fib level as a positive filter, and
total confluence count as a monotone score. Both are contradicted here.

---

**No strategy rule was changed. No weights were fitted. Every statistic is
reported with its n.**

---
---

# CAUSAL REPLICATION

**2026-09-21. Measurement only. No strategy rule changed.** IPO detection, E2
candle geometry, the FVG admission rule, volatility rules, S2, T_2R and
sequential handling are all untouched.

**Population source corrected.** The first study drew its IPOs from the batch
lifecycle, which carries the `hasFvg` +10-bar lookahead (§19). This replication
rebuilds the population from the **causal path**: at every bar `k`,
`runLifecycle(prefix[0..k])` filtered to `validAt !== null && hasFvg`, so an IPO
enters only once the frozen rules could actually see it.

**Causal A1 population: n = 3,782** (vs 9,527 all-touch rows before).
**win 69.4%, expR +0.461, PF 1.72.** FVG is constant `Y` here — A1 *is* the
population — so FVG interactions are untestable in this cut by construction.

---

## R1. Individual Fib levels — replicates, and strengthens

| level | inside n | % | win% | expR inside | expR outside | spread |
|---|---|---|---|---|---|---|
| 50.0 | 517 | 13.7 | 55.1 | +0.032 | +0.529 | **−0.497** |
| 61.8 | 537 | 14.2 | 53.3 | −0.097 | +0.553 | **−0.650** |
| 71.0 | 511 | 13.5 | 52.3 | −0.070 | +0.544 | **−0.613** |
| 78.6 | 510 | 13.5 | 57.5 | +0.152 | +0.509 | **−0.358** |
| 88.6 | 364 | 9.6 | 58.5 | +0.141 | +0.495 | **−0.354** |
| 100.0 | 235 | 6.2 | 61.3 | +0.256 | +0.475 | **−0.219** |

All six negative again, and the penalties are **larger** than in the batch study.
A weak gradient now appears — the deepest levels (88.6, 100.0) are the least
harmful, the mid levels (61.8, 71.0) the most. This does **not** support "deeper
is better"; it shows every level is a liability, some less than others.

## R2. Cluster count — replicates

| cluster | n | win% | expR | vs base |
|---|---|---|---|---|
| 0 | 2,149 | 73.5 | +0.585 | +0.124 |
| **1** | **988** | **75.4** | **+0.684** | **+0.223** |
| 2 | 430 | 49.1 | −0.286 | −0.747 |
| 3 | 112 | 47.3 | −0.206 | −0.667 |
| 4 | 52 | 53.8 | +0.089 | −0.372 |
| 5 | 24 | 16.7 | −0.803 | −1.264 |
| 6 | 27 | 18.5 | −1.013 | −1.474 |

Same shape, larger amplitude: exactly one level is best, two or more collapses.

## R3. Interactions — the S/R erasure replicates

| | n | win% | expR |
|---|---|---|---|
| fib=N S/R=N | 1,769 | 74.3 | +0.590 |
| fib=N S/R=Y | 380 | 69.7 | +0.557 |
| fib=Y S/R=N | 1,254 | 67.7 | +0.406 |
| **fib=Y S/R=Y** | **379** | **52.0** | **−0.058** |

HTF: +0.617 / +0.451 / +0.328 / +0.207 — fib presence costs more than HTF adds.
INST: fib=Y INST=Y is −0.312 on n=81 — thin, directionally bad.
TREND: the only feature that helps *within* the fib=Y group (+0.193 → +0.395).

---

## R4. **H1 — `zone_width / swing_range` is the real variable**

Distribution: p10 0.035 · p25 0.056 · **median 0.099** · p75 0.169 · p90 0.295.

Predeclared geometric buckets, not fitted:

| wr bucket | n | win% | expR |
|---|---|---|---|
| **< 0.05** | 790 | **86.3** | **+0.947** |
| 0.05 – 0.09 | 949 | 81.0 | +0.776 |
| 0.09 – 0.15 | 909 | 68.9 | +0.431 |
| 0.15 – 0.30 | 771 | 52.4 | −0.093 |
| **> 0.30** | 361 | **40.2** | **−0.162** |

**Perfectly monotone across all five buckets, spanning 1.11R and 46 points of
win rate.** This is the strongest single effect found anywhere in the IPO
programme, including FVG.

### It partly, but not wholly, explains the Fib cluster penalty

| | cluster ≤1 | cluster ≥2 |
|---|---|---|
| wr < 0.09 | n=1,739 **+0.854** | **n=0 — impossible** |
| wr ≥ 0.09 | n=1,396 +0.322 | n=645 −0.292 |

`cluster ≥ 2` is **geometrically impossible** below wr ≈ 0.09, exactly as
predicted from level spacing. So part of the Fib penalty is the wr effect
wearing a Fibonacci label.

But a residual survives inside narrow wr strata:

| wr band | cluster ≤1 | cluster ≥2 | delta |
|---|---|---|---|
| 0.09–0.13 | n=609 +0.487 | n=39 +0.628 | +0.141 |
| 0.13–0.20 | n=430 +0.350 | n=209 −0.260 | **−0.610** |
| 0.20–0.35 | n=252 +0.018 | n=235 −0.529 | **−0.548** |
| > 0.35 | n=105 −0.018 | n=162 −0.210 | −0.191 |

Negative in three of four bands. Fib clustering is **mostly** a wr proxy but not
entirely.

### H2 — exactly one level inside **survives the wr control**

| wr stratum | cluster=0 | cluster=1 | delta |
|---|---|---|---|
| < 0.09 | n=1,279 +0.834 | n=460 +0.908 | +0.074 |
| 0.09–0.15 | n=453 +0.332 | n=364 +0.519 | +0.187 |
| > 0.15 | n=415 +0.100 | n=164 +0.421 | **+0.321** |

Positive in every stratum and **growing with wr**. Unlike the raw cluster
penalty, H2 is not merely a restatement of H1.

---

## R5. Contested bars — paired, with bootstrap

- decision bars **2,172** · contested **950 (43.7%)** · IPOs in contests 2,560 · max depth **11**

| policy | mean R | median R | win% |
|---|---|---|---|
| first-touch | **+0.475** | +1.556 | 68.1 |
| highest-confluence | +0.429 | +1.570 | 67.4 |
| take-all | +0.526 | — | — |

**Paired (highest-confluence − first-touch), n = 950:**

| | |
|---|---|
| mean | **−0.0459** |
| median | **+0.0000** |
| win-rate difference | −0.74 pp |
| **bootstrap 95% CI** (5,000 resamples) | **[−0.1442, +0.0518]** |
| CI excludes zero? | **NO** |

### The loss-magnitude question, answered

| policy | losers | median | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|
| first-touch | 303 | −1.609 | −2.200 | −2.793 | −3.627 | **−8.811** |
| highest-confluence | 310 | −1.613 | −2.200 | −3.092 | −4.168 | **−18.241** |

Identical medians, **worse tails for confluence selection**: p95 −4.17 vs −3.63,
worst −18.24 vs −8.81. The batch study's paradox — wins more often, earns less —
was indeed **loss-magnitude driven**. In the causal data the frequency advantage
disappears entirely and only the tail penalty remains.

---

## R6. H3 — refuted in its strong form

Does a feature that separates in aggregate also separate *within* a contested bar?

| feature | aggregate spread | paired n | higher side won | paired mean diff |
|---|---|---|---|---|
| **cluster ≤1** | +0.908 | 275 | 48.0% | **+0.752** |
| **wr < 0.09** | +0.727 | 451 | 45.2% | **+0.661** |
| fib any | −0.286 | 422 | 52.4% | −0.256 |
| S/R | −0.264 | 317 | 53.0% | −0.279 |
| HTF | −0.165 | 211 | 43.6% | −0.361 |
| INST | −0.448 | 66 | 59.1% | −0.122 |
| TREND | +0.022 | 320 | 51.9% | +0.116 |

**H3 as stated is refuted for the two geometric features.** `wr` and
`cluster ≤1` carry large paired differences (+0.661, +0.752) — they *do*
discriminate between simultaneous IPOs.

But note the "higher side won" column: **45–52% for every feature.** The
discrimination is entirely in **magnitude**, not hit rate. These features predict
*how badly a loser loses*, not *whether it wins* — which is precisely what one
would expect of S2, whose losses are unbounded.

## R7. H4 — contest depth is a genuine market-state signal

| IPOs at bar | bars | trades | win% | expR |
|---|---|---|---|---|
| 1 | 1,222 | 1,222 | 65.7 | +0.325 |
| 2 | 572 | 1,144 | 68.0 | +0.375 |
| 3 | 225 | 675 | 71.9 | +0.585 |
| 4 | 82 | 328 | 73.2 | +0.666 |
| **≥5** | 71 | 413 | **77.5** | **+0.735** |

**Monotone.** More simultaneous valid IPOs is a *better* environment, not a
crowded one. H4 is supported.

A consequence worth recording: first-touch takes exactly one trade per bar
regardless of depth, so it systematically under-weights the best environments.
Take-all scores +0.461 against first-touch's +0.391 — **not executable** under
one-position-per-instrument, but it shows the gap is an *exposure* effect, not a
selection-quality one.

---

## R8. Batch vs causal — what held

| finding | batch | causal | verdict |
|---|---|---|---|
| all six Fib levels negative | −0.204…−0.400 | −0.219…−0.650 | **REPLICATES**, stronger |
| deeper level is better | no ordering | weak gradient, deepest least harmful | **UNCERTAIN** — still no support for depth |
| cluster = 1 is the best cell | +0.297 | +0.684 | **REPLICATES** |
| cluster ≥ 2 penalty | −0.395 vs base | −0.747 vs base | **REPLICATES**, stronger |
| S/R benefit erased by Fib | +0.294 → −0.151 | +0.557 → −0.058 | **REPLICATES** |
| Fib subtracts from FVG | +0.612 → +0.461 | untestable (FVG constant) | **NOT TESTABLE** |
| highest-confluence ≤ first-touch | −0.033 | −0.046, CI includes 0 | **REPLICATES** |
| higher confluence wins more often | 55.5% | 48.0–52.4% | **DISAPPEARS** |
| paradox is loss-magnitude driven | suspected | **confirmed** (p95 −4.17 vs −3.63) | **CONFIRMED** |
| confluence is market-state only (H3) | suggested | refuted for wr and cluster≤1 | **REVERSES** |
| contest rate | 30.4% | 43.7% | changed |
| max simultaneous IPOs | 28 | 11 | changed |
| **wr monotone (H1)** | not tested | **+0.947 → −0.162, monotone** | **NEW, strongest effect found** |
| **H2 survives wr control** | not tested | +0.074 / +0.187 / +0.321 | **NEW** |
| **H4 contest depth monotone** | not tested | +0.325 → +0.735 | **NEW** |

---

## R9. Decision

**First-touch sequencing is preserved.** The paired bootstrap CI
[−0.144, +0.052] includes zero and the point estimate is negative; confluence
selection also picks materially worse tails. Nothing here justifies replacing it.

**FVG remains the validated admission feature.** Nothing in the causal study
contradicts it; A1 is the population, so it was not re-tested here.

**No rule was changed, no threshold tuned, no weight fitted, no score built.**

### What the next out-of-sample test should carry

1. **`zone_width / swing_range`** — monotone over 3,780 causal trades, 1.11R
   spread, and it makes the Fib framing largely redundant. This is the single
   most promising variable in the programme and deserves its own pre-registered
   test before anything else.
2. **H2, exactly-one-level** — survives the wr control and strengthens with wr.
3. **H4, contest depth** — monotone, and it points at *exposure*, not selection.
4. Individual Fib levels and confluence-count scoring remain **contradicted** and
   should not be carried forward.
