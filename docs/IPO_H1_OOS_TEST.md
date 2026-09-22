# H1 Out-of-Sample Test — `zone_width / swing_range`

**Pre-registered. 2026-09-21. VERDICT: FAIL.**

Measurement only. IPO lifecycle, FVG A1 admission, E2 candle geometry, S2,
T_2R, volatility rules and first-touch sequencing are all unchanged. H1 was the
only feature tested.

---

## Pre-registration (fixed before fetching)

Buckets, unchanged from development: `<0.05` · `0.05–0.09` · `0.09–0.15` ·
`0.15–0.30` · `>0.30`.

Hypothesis: smaller `wr` → better expectancy and lower S2 loss severity.

| # | criterion | result |
|---|---|---|
| 1 | bucket expectancy non-increasing, no reversal > 0.10R | **FAIL** (+3.949 reversal at the first step) |
| 2 | Spearman ρ(wr, R) < 0, CI excluding zero | **FAIL** (ρ = **+0.159**, CI [+0.123, +0.197]) |
| 3 | extreme spread (b1 − b5) > +0.50R | **FAIL** (**−3.414**) |
| 4 | p95 losing R worse in `>0.30` than `<0.05` | **FAIL** (−2.58 vs **−77.18**) |

**0 of 4 passed.** H1 as specified does not replicate.

---

## Data

Four untouched windows × three instruments, 18,605 bars: **2022-06..08,
2022-12..2023-02, 2023-04..06, 2026-06..08**. 8 corrupt BTC bars dropped by the
median-band check. Causal population (prefix-only `runLifecycle`, A1 filter):
**n = 3,090**, win 69.0%, expR −0.329, PF 0.77.

## Results

| bucket | n | win% | expR | PF | totalR | maxDD | medLoss | p75 | p90 | p95 | worst |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **< 0.05** | 684 | 73.8 | **−3.174** | 0.25 | −2171.3 | **2679.8** | −1.358 | −3.575 | −76.010 | **−77.178** | **−82.230** |
| 0.05–0.09 | 739 | 80.8 | +0.775 | 2.55 | +572.7 | 24.8 | −1.953 | −2.943 | −5.274 | −6.269 | −15.893 |
| 0.09–0.15 | 718 | 68.8 | +0.445 | 1.62 | +319.6 | 40.8 | −1.867 | −2.600 | −4.116 | −4.564 | −9.212 |
| 0.15–0.30 | 618 | 59.4 | +0.297 | 1.39 | +183.8 | 86.6 | −1.611 | −2.075 | −2.814 | −3.496 | −7.800 |
| > 0.30 | 331 | 51.1 | +0.240 | 1.33 | +79.4 | 39.2 | −1.146 | −1.467 | −1.930 | −2.575 | −7.128 |

Bootstrap 95% CIs: `<0.05` [−4.474, −1.931] · `0.05–0.09` [+0.634, +0.907] ·
`0.09–0.15` [+0.304, +0.589] · `0.15–0.30` [+0.145, +0.439] · `>0.30` [+0.047, +0.435].

**Buckets 2–5 ARE monotone** (+0.775 → +0.445 → +0.297 → +0.240) and every CI is
above zero. The failure is entirely the lowest bucket, which development had as
the *best* cell (+0.947, win 86.3%).

## Where the failure lives

| | <0.05 | .05-.09 | .09-.15 | .15-.30 | >0.30 |
|---|---|---|---|---|---|
| EUR/USD | +1.045 | +1.094 | +0.481 | +0.647 | +0.288 |
| **USD/JPY** | **−5.143** | +0.736 | +0.440 | +0.148 | +0.336 |
| BTC/USD | −0.129 | +0.364 | +0.366 | +0.219 | −1.022 |
| 2026-06..08 | **−8.780** | +0.911 | +0.771 | +0.612 | +0.540 |
| LOW_VOL | **−19.225** | +0.768 | +0.003 | +0.287 | +0.136 |
| HIGH_VOL | +0.735 | +0.937 | +0.764 | +0.594 | +0.355 |

Excluding USD/USD/JPY entirely: +0.637 / +0.857 / +0.453 / +0.554 / −0.014 —
broadly flat-to-declining, no catastrophe.

## Diagnosis — cost domination, not strategy failure

The worst trades are USD/JPY IPO candles with `zoneWidth ≈ 0.0048` — **half a
pip** — against a swing range of 0.21. A sub-pip candle gives a sub-pip 1R.

At a 0.8-pip spread the round-trip cost is `2 × 0.008 / 0.004765` = **3.36R**.
Such a trade loses over three R to costs before price moves at all, and S2's
close-beyond-the-extreme rule then measures an ordinary 30-minute move as tens
of R.

`wr < 0.05` is **definitionally** the regime where 1R is smallest in absolute
terms, so it is exactly where cost domination concentrates.

| sample | `<0.05` rows with costR > 1 | costR > 2 | median costR | p90 |
|---|---|---|---|---|
| development (causal) | 11.9% | 3.9% | 0.40 | 1.14 |
| **OOS (this test)** | **24.9%** | **17.1%** | 0.53 | **3.06** |

Development simply did not sample this cluster. OOS did, mostly in one window.

**Diagnostic only, explicitly NOT a passing result:** removing rows with
costR > 1 from the `<0.05` bucket gives **+0.999** on n=534 — almost exactly the
development figure of +0.947. That is a post-hoc subset chosen after seeing the
data. It explains the failure; it does not rescue it.

Damage concentration: the worst 20 of 684 trades account for 71% of the bucket's
−2,171R. Note also that this is the all-touches population, so one disastrous
IPO contributes many rows. Under approximate first-touch sequencing the bucket
improves to −1.083 but stays negative and still carries a −75R worst trade.

---

## Conclusions

1. **H1 FAILS its pre-registered test.** 0 of 4 criteria. It must not be turned
   into a filter, a score, or a threshold. **No second stage.**
2. **The monotonic relationship holds for `wr ≥ 0.05`** and every CI there is
   above zero — but that is 4 of 5 buckets, which is not what was registered.
3. **The failure has a specific, identifiable cause** that is not about
   `wr` at all: sub-pip IPO candles whose 1R is smaller than the spread. This is
   the cost-domination problem already recorded in
   `IPO_FORWARD_TRADING_SPEC.md` §8, now shown to be far more damaging than the
   BTC framing there suggested — on USD/JPY it produced −82R single trades.
4. **The real finding of this phase is a risk defect in the frozen strategy,
   not a feature.** A1 currently admits setups whose entire 2R target is smaller
   than the round-trip cost. No rule change is proposed here.

## What a next pre-registered test should be

State it before any data is seen, and test **one** thing:

> **H5 — minimum risk-to-cost.** Setups where `2 × spread / risk` exceeds a
> pre-declared value are uneconomic by construction. Test as a binary admission
> condition, not a score.

H5 is a cleaner hypothesis than H1 and is mechanically motivated rather than
discovered in a bucket table. If H5 holds, H1 should then be re-tested on the
surviving population — as a **new** pre-registered test, not a revival of this
one.

Carried forward as observations only, untested here: Fib-level filters,
confluence-count ranking, highest-confluence selection, contest-depth exposure.

---

**No strategy rule changed. First-touch sequencing preserved. FVG remains the
validated admission feature.**
