# H5 Pre-Registered Test — cost-to-risk admission

**2026-09-21. VERDICT: NOT VALIDATED on the pre-registered criteria — mechanism
confirmed, primary claim untestable on this sample.**

Measurement only. Lifecycle, FVG A1 admission, E2 geometry, S2, T_2R, volatility
rules and first-touch sequencing all unchanged. Nothing wired to production.

---

## Method

`costR = roundTripCost / nominalRisk = 2 × perSide / risk`, using the frozen cost
model. Note `risk == zoneWidth` exactly: E2 enters at the candle midpoint and
stops at the far extreme, so risk is half the candle range, which is the zone
width.

Four candidate policies, pre-registered as separate discrete options, not tuned:
**costR ≤ 0.25 / 0.50 / 0.75 / 1.00**.

### Sample independence

H5 was discovered from the sub-pip USD/JPY cluster inside the H1-OOS set.
**Testing it there would be circular**, so this test uses four genuinely fresh
windows and treats the H1-OOS set as the discovery sample:

> 2021-01..03 · 2023-08..09 · 2025-06-15..08-01 · 2026-08-01..09-20
> × EUR/USD 1H, USD/JPY 30M, BTC/USD 1H. Causal population **n = 2,492**.

---

## Results — fresh sample

Unfiltered: n=2,492, win 69.2%, expR **+0.457**, PF 1.72, totalR +1,139.9,
maxDD 114.3, 408.5 trades/month.

costR distribution: median 0.314 · p75 0.523 · p90 0.888 · p95 1.715 · max 4.57.
**costR > 1 before filtering: 8.5%.** costR > 2: 3.7%.

| policy | n | %kept | win% | expR | PF | totalR | maxDD | t/mo | medL | p90 | p95 | worst |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| UNFILTERED | 2492 | 100.0 | 69.2 | +0.457 | 1.72 | +1139.9 | 114.3 | 408.5 | −1.728 | −3.099 | −4.240 | **−10.82** |
| costR ≤ 0.25 | 981 | 39.4 | 60.0 | **+0.318** | 1.41 | +311.7 | 136.9 | 160.8 | −1.674 | −2.769 | −3.341 | **−10.82** |
| costR ≤ 0.50 | 1845 | 74.0 | 68.6 | +0.530 | 1.81 | +977.3 | 119.7 | 302.5 | −1.727 | −2.946 | −4.650 | **−10.82** |
| costR ≤ 0.75 | 2139 | 85.8 | 70.3 | **+0.540** | 1.85 | +1155.6 | 113.1 | 350.7 | −1.787 | −3.099 | −4.714 | **−10.82** |
| costR ≤ 1.00 | 2280 | 91.5 | 71.0 | +0.534 | 1.85 | +1217.5 | 110.2 | 373.8 | −1.817 | −3.099 | −4.671 | **−10.82** |

Trades removed: 60.6% / 26.0% / 14.2% / 8.5%.

**Surviving trades whose 2R target is below round-trip cost: 0.00% at every
threshold** (by construction — that condition is costR > 2).

### Why the primary claim could not be tested

The worst three trades are USD/JPY at −10.82R with **costR = 0.178** — not
cost-dominated at all. **No policy removes them**, which is why `worst` is
identical down every row and p95 actually degrades slightly at 0.50–1.00.

Only 3 trades in 2,492 exceed |10R|. **The fresh sample contains no
cost-dominated catastrophe to remove.** The claim "materially reduces S2 tail
losses" is therefore not refuted here — it is untestable here.

## Stability

| instrument | unfiltered | ≤0.25 | ≤0.50 | ≤0.75 | ≤1.00 |
|---|---|---|---|---|---|
| EUR/USD | +0.512 | +0.149 | +0.404 | +0.509 | +0.523 |
| USD/JPY | +0.527 | +0.402 | +0.597 | +0.596 | +0.604 |
| **BTC/USD** | −0.118 | +0.186 (n=32) | **+0.596 (n=81)** | **+0.147 (n=123)** | +0.046 (n=176) |

| window | unfiltered | ≤0.25 | ≤0.50 | ≤0.75 | ≤1.00 |
|---|---|---|---|---|---|
| 2021-01..03 | +0.328 | **−0.073** | +0.316 | +0.302 | +0.333 |
| 2023-08..09 | +0.403 | **−0.005** | +0.492 | +0.459 | +0.481 |
| 2025-06..08 | +0.785 | +0.681 | +0.830 | +0.823 | +0.802 |
| 2026-08..09 | +0.373 | +0.325 | +0.464 | +0.548 | +0.525 |

Volatility: HIGH +0.484→+0.645 (≤0.75), MID flat ~+0.61, LOW +0.211→+0.236.

**≤0.25 is harmful**: removes 61% of trades, cuts expectancy to +0.318, and turns
two of four windows negative. **BTC is directionally unstable** — non-monotone
across thresholds on small samples (+0.596 at ≤0.50 vs +0.147 at ≤0.75).

---

## Retrospective on the discovery set — mechanism, not validation

H1-OOS, FX only (BTC omitted: that dump lacks the price needed for a
proportional fee). **Shown to demonstrate the mechanism; this is the sample H5
came from and cannot validate it.**

| policy | n | %kept | win% | expR | p95 loss | worst |
|---|---|---|---|---|---|---|
| UNFILTERED | 2799 | 100.0 | 69.0 | **−0.375** | −7.38 | **−82.23** |
| costR ≤ 0.25 | 1572 | 56.2 | 62.3 | +0.444 | −3.94 | −15.89 |
| costR ≤ 0.50 | 2324 | 83.0 | 68.6 | +0.576 | −4.62 | −15.89 |
| costR ≤ 0.75 | 2576 | 92.0 | 70.9 | +0.626 | −4.62 | −15.89 |
| **costR ≤ 1.00** | **2632** | **94.0** | 71.4 | **+0.629** | −4.62 | **−15.89** |

**Removing 6% of trades moves expectancy −0.375 → +0.629 and caps the worst loss
from −82R to −15.9R.** When the pathology is present the effect is decisive.

costR > 1 share: discovery set 6.0%, fresh sample 8.5% — so the fresh sample has
*more* nominally cost-heavy trades but none of them are the catastrophic kind.
Cost domination is necessary but not sufficient for a −82R outcome; it also
needs a sub-pip candle in a trending low-volatility stretch.

---

## Verdict against the pre-registered hard rule

> *"Must remain directionally stable across instruments and untouched periods
> AND materially reduce pathological cost-dominated losses."*

| requirement | ≤0.25 | ≤0.50 | ≤0.75 | ≤1.00 |
|---|---|---|---|---|
| improves aggregate expectancy | **NO** (+0.318) | yes (+0.530) | yes (+0.540) | yes (+0.534) |
| stable across all 4 windows | **NO** (2 negative) | yes | yes | yes |
| stable across all 3 instruments | no | **NO** (BTC) | **NO** (BTC) | **NO** (BTC) |
| materially reduces tail | **NO** | **NO** | **NO** | **NO** |
| keeps trade frequency | **NO** (−61%) | yes (−26%) | yes (−14%) | yes (−8.5%) |

**No threshold satisfies the rule. H5 is NOT VALIDATED.**

The tail criterion fails for every policy — not because the filter is
ineffective but because **this sample has no pathological tail**. That is a
sampling outcome, not evidence against H5, and it must not be read as one.

---

## The part that needs no validation

**A trade with costR > 2 cannot profit even on a perfect win.** Its 2R target is
smaller than its round-trip cost. That is arithmetic, not a statistical claim,
and it applies to **3.7% of the fresh sample (n=91)** and 6.0% of the discovery
set.

Excluding a trade that is *deductively* unable to make money is a different kind
of decision from excluding one that *empirically tends* to lose. The first needs
no out-of-sample evidence; the second does. **This distinction should be kept
sharp when the operational decision is taken** — and that decision is not taken
here.

## Recommendation for the next phase

1. **Do not adopt any costR threshold as an empirical filter on this evidence.**
2. **`costR ≤ 1.00` is the strongest candidate** — keeps 91.5% of trades, improves
   expectancy in both samples, is stable across all four fresh windows, and is
   transformative when the pathology appears. Its weakness is BTC instability and
   an untested tail claim.
3. **A costR > 2 exclusion could be argued deductively rather than empirically.**
   If proposed, it should be justified on arithmetic and labelled as such, not
   presented as a validated feature.
4. **Any further test needs a sample containing the pathology.** Sampling for it
   deliberately (low-volatility trending FX stretches with sub-pip candles) would
   be legitimate, but the pre-registration must say so in advance or it becomes
   selection on the outcome.

---

**No strategy rule changed. Not wired to production. First-touch sequencing,
FVG admission, S2, T_2R, lifecycle and volatility rules all preserved.**
