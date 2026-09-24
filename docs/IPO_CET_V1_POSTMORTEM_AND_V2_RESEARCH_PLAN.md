# IPO-CET-v1 post-mortem, and the IPO-CET-v2 research plan

**Research and design only. No strategy logic changed, no production code, no
deployment, no database write, no schema, no cron, no SMC or broker change.**
Dated 2026-09-24. Continues `b26e9485`.

---

## 1. Executive summary

v1's validated edge did not survive causal intrabar correction. The strategy is
not marginally behind — but it is not far behind either, and the distance is
measurable and specific.

**The single most useful number in this document:**

| | avg win | avg loss | break-even win rate | actual | gap |
|---|---|---|---|---|---|
| EUR/USD | +1.68R | −1.92R | 53.3% | 57.2% | **+3.9pp** |
| USD/JPY | +1.71R | −2.29R | 57.3% | 54.9% | **−2.4pp** |
| BTC HIGH_VOL | +1.26R | −2.74R | 68.4% | 55.6% | **−12.8pp** |
| **PORTFOLIO** | **+1.64R** | **−2.22R** | **57.5%** | **55.7%** | **−1.7pp** |

The portfolio fails by **1.7 percentage points of win rate**. It fails because
the bar is at 57.5%, and the bar is at 57.5% because **100% of losses exceed 1R**.

That reframes the problem. v1 is not a strategy with no signal; it is a strategy
whose loss shape sets a hurdle its hit rate cannot clear.

---

## 2. v1 status

```
IPO-CET-v1
STATUS: VALIDATION_FAILED_AFTER_CAUSAL_INTRABAR_CORRECTION
```

**Retained as a CONTROL, not deployable.** Every v2 candidate must be reported
against v1 on the same population, so improvement is measured rather than
asserted.

Nothing is deleted or rewritten. The chain stands: the locked baseline
(`IPO_FORWARD_TRADING_SPEC.md` §11), the forensic audit (PR #618), the 1m
resolution work (stages 1–2), the provenance recovery, the determinism replay,
and the causal remeasurement.

---

## 3. Legacy vs causal

| | legacy | causal | delta |
|---|---|---|---|
| EUR/USD | +0.758R, PF 2.60 | +0.142R, PF 1.17 | −0.616R |
| USD/JPY | +0.550R, PF 1.88 | −0.095R, PF 0.91 | −0.645R |
| BTC HIGH_VOL | +0.193R, PF 1.28 | −0.514R, PF 0.58 | −0.707R |
| **PORTFOLIO** | **+0.540R, PF 1.88** | **−0.067R, PF 0.93** | **−0.607R** |
| total R | +512.4 | −63.4 | −575.8 |
| win rate | 70.8% | 55.7% | −15.1pp |
| max DD | 18.4R | 148.5R | ×8 |

Population: 1,042 replayed · 570 multi-bar · 398 1m-resolved · 74 tick-required.
149 of 398 resolved outcomes changed. BTC 2023-06..08 excluded throughout (§9).

---

## 4. Root cause — five, not one

### 4.1 Execution-sequencing artifact (the trigger)

Entry derived from one extreme of an HTF bar, then the target tested against the
whole of that same bar. Quantified: intrabar-sensitive trades carried **+686.9R**
of legacy profit; the multi-bar trades, where ordering was never in question,
carried **−93.7R**.

### 4.2 Loss shape (the structural cause)

S2 is close-confirmed, so a loss is priced at the invalidating close, not at the
level. Causal loss distribution:

| | n | median | mean | p75 | p90 | p95 | p99 | max | >1R | >1.5R | >2R | >3R | >5R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 137 | 1.68 | 1.92 | 2.18 | 2.97 | 3.52 | 4.66 | 5.27 | 100% | 65% | 30% | 9% | 1% |
| USD/JPY | 231 | 1.71 | 2.29 | 2.28 | 3.04 | 5.44 | 12.52 | **28.63** | 100% | 70% | 34% | 11% | 5% |
| BTC | 52 | 2.28 | 2.74 | 3.30 | 4.70 | 6.15 | 8.81 | 8.81 | 96% | 90% | 58% | 33% | 10% |
| **PORT** | **420** | **1.74** | **2.22** | **2.32** | **3.25** | **4.45** | **8.81** | **28.63** | **100%** | **71%** | **36%** | **13%** | **4%** |

This confirms the historical observation (median ≈1.75R, p90 3.38R, p95 4.35R,
p99 8.26R) on causal data: median 1.74R, p90 3.25R, p95 4.45R, p99 8.81R. The
earlier figures were right, and they were not treated as disqualifying.

**"1R" is a label, not a risk.** A 2R target against a 2.22R average loss is not
a 2:1 system; it is roughly 0.74:1.

### 4.3 Trade quality independent of the artifact

Multi-bar trades were already **−0.139R, PF 0.86** causally. Fixing execution
ordering alone does not produce a profitable system.

### 4.4 Instrument heterogeneity

EUR/USD +0.142R; USD/JPY −0.095R; BTC −0.514R. Treating the three as one
portfolio concealed that only one had anything.

### 4.5 Cost/target asymmetry

Wins are capped at 2R by construction; losses are uncapped above 1R. Section 10
quantifies how much upside the cap actually costs.

---

## 5. Same-bar vs multi-bar structure

| | n | win | expR | PF | avg win | avg loss |
|---|---|---|---|---|---|---|
| **EUR/USD** same-bar | 136 | 62.5% | **+0.262** | 1.35 | 1.61 | −1.99 |
| EUR/USD multi-bar | 184 | 53.3% | +0.053 | 1.06 | 1.75 | −1.88 |
| **USD/JPY** same-bar | 197 | 63.5% | +0.097 | 1.10 | 1.65 | −2.59 |
| USD/JPY multi-bar | 315 | 49.5% | **−0.215** | 0.80 | 1.76 | −2.15 |
| **BTC** same-bar | 56 | 55.4% | −0.723 | 0.44 | 1.01 | −2.87 |
| BTC multi-bar | 61 | 55.7% | −0.322 | 0.72 | 1.49 | −2.61 |
| **PORTFOLIO** same-bar | 389 | 62.0% | +0.037 | 1.04 | 1.55 | −2.43 |
| **PORTFOLIO** multi-bar | 560 | 51.4% | **−0.139** | 0.86 | 1.72 | −2.11 |

Same-bar win rate is 62.0% against 51.4% for multi-bar — **10.6pp**. Trades that
reach their level promptly behave differently from trades that come back to it
later.

---

## 6. Entry timing — the most consistent signal found

Expectancy by how many minutes into the HTF bar the entry actually occurred:

| offset | EUR/USD | USD/JPY | BTC |
|---|---|---|---|
| 0–9 min | **+0.790** (n=29, PF 2.89) | **+0.365** (n=73, PF 1.51) | +0.843 (n=7) |
| 10–29 | +0.222 (n=27) | −0.061 (n=124) | −0.861 (n=22) |
| 30–44 | +0.155 (n=34) | — | — |
| 45+ | +0.032 (n=46) | — | — |
| multi-bar | +0.053 (n=184) | −0.215 (n=315) | −0.322 (n=61) |

Monotone decline on EUR/USD, and the same direction on the other two. **It is
the only dimension that points the same way on all three instruments**, which is
what makes it worth a hypothesis rather than a subgroup.

Caveat: this is measurable only because of the 1m work, and the sample thins
quickly (BTC's 0–9 bucket is n=7 — not evidence on its own).

---

## 7. EUR/USD survivor analysis (n=320, +0.142R, PF 1.17)

| dimension | finding |
|---|---|
| direction | supply **+0.335** PF 1.48 (n=168) vs demand **−0.072** PF 0.93 (n=152) |
| volatility | HIGH +0.238, MID +0.237, LOW +0.057, UNCLASSIFIED −0.243 (n=28, warmup) |
| session | london **+0.367** (n=75), ny-late +0.157, overlap +0.137, asia **−0.100** |
| day | Mon +0.478 (n=50), Fri −0.120 (n=56) |
| entry minute | 0–9 **+0.790**, 45+ +0.032 |
| risk %/price | Q3 +0.352, Q2 −0.022 — non-monotone, no clean read |
| costR | Q1 −0.047, Q2 +0.284, Q3 +0.198, Q4 +0.135 — no clean read |
| zone age | 6–20 bars +0.223, 21–60 **−0.248**, 61+ +0.318 — non-monotone |
| bars held | 0 +0.000, 1–3 +0.142, 4–12 +0.150, 13+ +0.239 |

**Only two dimensions look structural**: direction (supply > demand) and entry
timing. The rest are non-monotone, which is the signature of noise across ~100
subgroups rather than of an effect.

---

## 8. USD/JPY failure analysis (n=512, −0.095R, PF 0.91)

Nearly break-even and failing on loss shape, not hit rate. Win 54.9% against a
57.3% requirement.

| vs EUR/USD | |
|---|---|
| average loss | **−2.29R** vs −1.92R |
| p95 loss | **5.44R** vs 3.52R |
| p99 loss | **12.52R** vs 4.66R; max **28.63R** |
| multi-bar expR | **−0.215** vs +0.053 |
| asia session | **−0.386** (n=141) vs −0.100 |

Two differences carry it: a much heavier loss tail, and a multi-bar population
that is both larger (315 of 512) and clearly negative. Its same-bar subset is
positive (+0.097).

Zone age 21–60 bars is +0.369 while 61+ is −0.314 — the opposite ordering to
EUR/USD, which argues against reading either as structural.

---

## 9. BTC failure analysis (n=117, −0.514R, PF 0.58)

**Structural, not data-limited.** The corrupt 2023-06..08 window is excluded and
BTC is still the worst instrument by a wide margin on the remaining four.

- Break-even needs **68.4%**; delivered 55.6%. A **12.8pp** shortfall — an order
  of magnitude worse than the portfolio's 1.7pp.
- Average win **+1.26R**, the lowest of the three, against average loss −2.74R.
- 58% of losses exceed 2R; 33% exceed 3R.
- Negative in every session, both directions, and in both same-bar (−0.723) and
  multi-bar (−0.322).
- HIGH_VOL is the only bucket present, so the volatility filter that made BTC
  viable in legacy research is already applied.

The failure is the cost/loss geometry: BTC's proportional cost model plus wide
S2 excursions leaves a win too small to pay for a loss.

**Data limitation, stated:** the excluded window removes 21 trades, and the
62-vs-64 corrupt-bar discrepancy is still open. Neither rescues a −12.8pp gap.

---

## 10. Target efficiency

Post-entry MFE, same-bar resolved trades only (**MFE was not computed for
multi-bar trades — a gap in the dataset, not a zero**).

**Losers, did they ever get near target?**

| | +0.5R | +1R | +1.5R | +2R |
|---|---|---|---|---|
| EUR/USD (51) | 69% | 37% | 12% | 0% |
| USD/JPY (72) | 78% | 50% | 28% | 1% |
| BTC (25) | 72% | 28% | 12% | 8% |
| **PORT (148)** | **74%** | **42%** | **20%** | **2%** |

**Winners, how far past 2R?**

| | 2.5R | 3R | 4R | 5R+ |
|---|---|---|---|---|
| **PORT (241)** | **35%** | **19%** | **6%** | **4%** |

Two readings, both supported:

- **The target is not the problem for losers.** Only 2% ever touched 2R. They do
  not narrowly miss; they do not get there. Moving the target closer would
  convert some of the 42% that reached +1R — but at the cost of the 65% of
  winners that need the full 2R.
- **The cap does truncate a real minority of winners.** 35% ran to 2.5R, 19% to
  3R. With an average loss of 2.22R, letting a third of winners run is
  materially relevant to the break-even arithmetic.

This is the clearest quantitative case for H8, and equally a warning that a
naive target reduction trades one asymmetry for another.

---

## 11. Entry quality

Measured, not ruled on:

- **Same-bar entries win 62.0% vs 51.4% multi-bar.** The strongest structural
  split in the dataset.
- **Entry timing within the bar** — §6.
- **Zone age** is non-monotone and inconsistent between instruments. No read.
- **Re-entry ordinal, touch depth, FVG size, impulse displacement and contraction
  duration are NOT in the causal dataset.** They were requested and are not
  available; the replay records entry/stop/target/risk/cost/vol and nothing
  about zone geometry. Measuring them needs the engine instrumented to emit
  them, which is a separate task.

---

## 12. Breaker/retest research framework (NOT IMPLEMENTED)

A new track, not a v1 modification, and deliberately unbuilt. The concept:

```
valid demand IPO → close-confirmed invalidation below S2
                 → old demand IPO becomes a bearish breaker candidate
                 → SHORT entry must occur inside the original IPO zone
(mirror for supply)
```

**Rule questions that must be answered before any code:**

*The break* — does one close beyond S2 suffice, or N consecutive? Does break
candle size or displacement matter? Must the break close beyond the zone or
merely beyond S2? Does a break on a gap count?

*The retest* — must it occur within N bars, and if so measured from the break
close or the break bar? Is entry valid anywhere inside the old zone, or only at
a specific level? **Does E2 survive the polarity flip**, or does a flipped zone
need its own entry geometry? Is FVG required on the break leg, the retest, both,
or neither?

*Execution* — immediate entry on touch, or confirmation first? What confirmation?

*Lifecycle* — what invalidates the breaker itself? What is the target — 2R from
the new entry, the origin of the break, or a structural level? Do repeated
retests each generate a signal, or only the first? Does the old zone stay active
indefinitely, or expire? **Can several invalidated IPOs be live breakers at once,
and how does that interact with one-position-per-instrument?**

*Measurement* — what is the control? A breaker result is only meaningful against
the v1 entry on the same zone, otherwise it is a new strategy with no baseline.

This needs its own spec before it needs any code.

---

## 13. Candidate v2 hypotheses

Retained only where §5–§11 provide descriptive support. Each must be
pre-registered before testing.

| | hypothesis | evidence | strength |
|---|---|---|---|
| **H1** | EUR/USD retains a real edge; USD/JPY and BTC do not | +0.142 / −0.095 / −0.514 | moderate — one instrument, one corpus |
| **H2** | Close-confirmed S2 produces a loss distribution that sets an unreachable break-even bar | 100% of losses >1R; portfolio needs 57.5%, gets 55.7% | **strong** |
| **H3** | Entries early in the HTF bar outperform late ones | monotone on EUR/USD, same sign on all three | **strong** (only cross-instrument-consistent signal) |
| **H4** | Multi-bar / delayed-retest entries are structurally weaker | 62.0% vs 51.4% win; −0.139R vs +0.037R | **strong** |
| **H8** | The fixed 2R target truncates a material minority of winners | 35% of winners ran past 2.5R, 19% past 3R | moderate |
| **H9** | Supply setups outperform demand | EUR/USD +0.335 vs −0.072; same sign on JPY and BTC | moderate — may be regime, not structure |

**Dropped for lack of support:** H5 (re-entry ordinal — not in the dataset),
H6 (ATR-normalised zone width — the risk-%-of-price proxy is non-monotone on
both FX pairs). H7 (breaker/retest) is retained as §12's separate track, not as
a v2 hypothesis, because no evidence exists for it yet either way.

---

## 14. Overfitting controls

This document sliced roughly 100 subgroups across three instruments. **Some of
them look good by chance, and I cannot tell you which.** Controls:

1. **Nothing here is a rule.** Every number is descriptive.
2. **Cross-instrument consistency is the filter.** H3 and H4 point the same way
   on all three; that is why they are rated strong and the day-of-week and
   zone-age results are not rated at all.
3. **Minimum samples**, pre-registered: ≥200 trades per instrument and ≥100 per
   subgroup before any subgroup claim.
4. **No threshold sweeping.** A hypothesis specifies its cut before it is run.
5. **No post-hoc window dropping** and no selective reporting: every
   pre-registered clause is reported pass or fail.
6. **EUR/USD-only must be a pre-registered hypothesis (H1)**, justified by the
   loss-shape argument in §7, not the result of deleting two losers and
   renaming the remainder a portfolio.

---

## 15. New train/validation design

**The recent history is largely exhausted.** Periods already used across IPO
research: 2020-03 to 2020-08, 2021-01, 2021-03, 2021-05, 2021-09, 2021-11,
2022-01/02/04/06/07/08/10/12, 2023-02/04/06/08/09/11/12, 2024-01/02/03/06/07/09/11,
2025-01/04/06/08/10/12, 2026-01/04/06/08/09. That is a structural constraint on
v2 and it should be stated rather than worked around.

Proposed, and to be fixed in writing before any run:

| stage | source | purpose |
|---|---|---|
| **DISCOVERY** | 2017-01 → 2019-12, all three instruments | untouched by every prior study; wide enough to form rules |
| **VALIDATION A** | 2024-04..06 and 2023-12..2024-02 | the only recent gaps not obviously consumed |
| **VALIDATION B** | forward, from the pre-registration date onward | genuinely out-of-time, cannot be mined |
| **HOLDOUT** | reserved, undisclosed until A and B both pass | one look only |

Two caveats worth stating now: BTC 2017–2019 is a different market regime and
may not be comparable; and VALIDATION B accrues slowly, at roughly 100 trades a
month portfolio-wide under v1 frequency.

---

## 16. Pre-registration requirements

Before v2 is tested, a document must fix: instruments; timeframes; setup
formation; FVG requirement; entry rule; touch rule; re-entry rule; S2 semantics;
target semantics; cost model; volatility filter; session filter; zone age limit;
maximum touches; breaker/retest inclusion; data provider; **intrabar resolution
method**; and tick fallback policy. No clause may be adjusted after results are
seen.

The intrabar resolution method is now a first-class part of the specification,
not an implementation detail. v1's failure was that this was never specified.

---

## 17. Success criteria — proposed, not adopted

| criterion | proposal | rationale |
|---|---|---|
| expectancy | > +0.15R after costs | above the +0.142R v1's survivor achieved, so v2 must beat the control |
| profit factor | > 1.2 | 1.17 is v1's best; 1.2 is a real margin |
| win rate vs break-even | ≥ +5pp above the observed break-even rate | directly addresses §1; a 1.7pp deficit is what killed v1 |
| max drawdown | < 40R | v1 causal was 148.5R; legacy 18.4R was measured on inflated wins |
| stability | positive in ≥ 4 of 5 validation windows | not carried by one period |
| direction | positive in both, or long/short restriction pre-registered | §13 H9 must be declared, not discovered |
| concentration | no subgroup under 20% of trades contributing over 50% of profit | the v1 failure mode exactly |
| ordering | 100% of outcomes causally resolved or explicitly excluded | tick-required trades reported, never assumed |

These are for discussion. They are deliberately set against v1's *causal*
numbers, not its legacy ones.

---

## 18. Deferred execution work

Not to be built until a causally validated v2 exists: tick streaming, the
1-minute execution service, broker live routing, LIVE_CANARY. Execution
engineering follows strategy validation.

Also still open and unrelated to v2: the production paper runner continues to
book same-bar targets on the live forward test.

---

## 19. Machine-readable output

`/tmp/v1-postmortem-trades.json` and `.csv` — 1,021 enriched trades with
instrument, window, direction, volatility, prices, risk, risk-%-of-price, costR,
legacy and causal R, same-bar flag, classification, entry-bar outcome, forward
outcome, UTC hour, day, session, entry-minute offset, bars held, zone age, MFE
and MAE. BTC 2023-06..08's 21 rows are excluded.

Not committed: research artifacts stay local.

---

## 20. Statement

No IPO detection, lifecycle, contraction, FVG, direction, E2, S2, 2R target,
re-entry, sequencing, volatility or cost rule was changed. No breaker/retest
logic was implemented. No SMC, broker, cron, schema, deployment or production
code was touched. No v2 engine logic was written and no new filter was
backtested. The locked baseline is preserved exactly as written, and v1 is
retained as a control rather than relabelled.
