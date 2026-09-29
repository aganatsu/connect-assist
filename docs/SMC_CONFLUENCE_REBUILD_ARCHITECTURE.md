# SMC CONFLUENCE REBUILD — ARCHITECTURE V1

Design only. No production change, no deployment, no threshold chosen.

Every classification below cites a measurement from the completed audits. Where
evidence is absent, the entry says so rather than guessing.

---

## 1. CURRENT MODEL MAP

`runConfluenceAnalysis(candles, daily, config, hourly, atMs)` —
`_shared/confluenceScoring.ts:274`, called once at `bot-scanner:4984`.

27 factors emitted (25 in `DEFAULT_FACTOR_WEIGHTS` + 4 zero-weight), **32.5 raw
points**, output as a **percentage**: `score = rawScore / enabledMax × 100`.

**Weights are dynamic.** Production flips a weight negative for opposing
evidence — *"Reversal Candle OPPOSES short — penalty, w −1.5"*, *"Market
Structure w −0.1"*. A `present=true` factor can subtract.

Gate: `minConfluence = 40` (live). It is **one of four unrelated scores**, which
the existing code does not distinguish clearly:

| score | scale | gate |
|---|---|---|
| Confluence | **%** of 32.5 | `minConfluence 40` |
| Zone Score | **/9** | `minZoneScore 4` |
| Zone Story | **/14** | none — display only |
| Direction | verdict + confidence % | Gate 1 |

Confluence is a **soft score** feeding `effectiveScore`; the only hard gates in
the entry path are direction, zone existence, Zone Score ≥ 4, and the Route 1
arming flags.

## 2. RESEARCH CONSTRAINTS (locked, not re-litigated)

Confluence is not predictive; threshold 40 is inert portfolio-wide
(−0.1836 → −0.1872, Δ **−0.0036**); most factors are unstable across time and
instrument; heavy duplication; the entry feature screen returned **one** Tier-A
feature; displacement failed instrument stability; exit management cut losses
without creating positive expectancy; Route 1 remains negative; telemetry is now
fixed for forward verification.

## 3. FACTOR DISPOSITION — evidence-backed

From `u8_factor_stability.csv` (35,187 armed+resolved, 8 instruments, H1/H2):

| factor | H1 | H2 | +/− | disposition |
|---|---|---|---|---|
| **Session Quality** | +0.061 | +0.101 | **6/0** | **KEEP_CANDIDATE** — the only ROBUST_POSITIVE |
| Market Structure | +0.021 | +0.190 | 6/2 | OBSERVATIONAL_ONLY (context-dependent) |
| Order Block | −0.000 | −0.089 | 1/6 | OBSERVATIONAL_ONLY |
| Displacement | +0.041 | +0.083 | 4/2 | OBSERVATIONAL_ONLY |
| Breaker Block | −0.028 | −0.036 | 2/4 | DROP |
| Power of 3 Combo | +0.069 | +0.037 | 3/4 | DROP |
| Premium/Discount & Fib | −0.008 | −0.011 | 2/4 | DROP |
| Judas Swing | −0.055 | +0.034 | 4/4 | DROP (was "stable" on 3 instruments; collapsed on 8) |
| Reversal Candle | +0.022 | +0.011 | 4/2 | DROP |
| Liquidity Sweep | +0.013 | +0.000 | 3/4 | DROP |
| Volume Profile | −0.164 | −0.018 | 3/5 | **DUPLICATE** (0.836 with Daily Bias) |
| AMD Phase | +0.088 | −0.059 | 4/3 | DROP |
| Daily Bias | −0.064 | +0.035 | 2/4 | **DUPLICATE** |
| Pullback Health | −0.017 | +0.019 | 4/2 | DROP |
| HTF POI Alignment | −0.060 | +0.015 | 5/3 | DROP |
| HTF Fib + PD + Liquidity | −0.095 | −0.002 | 3/4 | **DUPLICATE** |
| Session Affinity | −0.070 | +0.239 | 3/4 | DROP |
| PD/PW Levels | — | — | — | **DUPLICATE** (0.830 with Market Structure) |
| Fair Value Gap, Unicorn Model | — | — | — | DROP (insufficient: <2% present) |
| SMT, Currency Strength, GP Key Level, GP Bias Confidence | — | — | — | **UNREPLAYABLE** |
| Regime Alignment, Spread Quality | — | — | — | DROP (never fire; config-off / info-only) |

**Retained from 27: one.**

## 5. DUPLICATION CLUSTERS → ONE CANONICAL SIGNAL EACH

Jaccard from `cf_cooccurrence.csv` / the 8-instrument run:

| cluster | members | J | canonical |
|---|---|---|---|
| **HTF structural context** | Market Structure + PD/PW (0.830), PD/PW + Daily Bias (0.806), MS + Daily Bias (0.797), Daily Bias + HTF Fib/PD/Liq (0.797) | 0.80–0.83 | **ONE** `htf_context_aligned` boolean |
| **Session/time** | Session Quality + Market Structure (0.753), Session Affinity | 0.75 | **ONE** `session_window` |
| **Volume/context** | Volume Profile + Daily Bias (0.836) | 0.836 | folded into `htf_context_aligned` |
| **Impulse strength** | displacementCandles + maxRangeMultiple (0.783) | 0.783 | **ONE** `impulse_displacement` |

Five factors carrying **8.5 of 32.5 weight** are one event fired ~80% of the
time together. That alone explains why adding factors raised the score without
raising outcome: the high band differs from the low band mostly by counting the
*same* thing more times (avg factors present 6.12 → 11.88).

## 6. ZONE SCORE — decompose, do not keep as a monolith

`totalScore = fibScore(0–2) + srConfirmed(+1) + ltfRefined(+1) + htfConfluenceScore`,
where `htfConfluenceScore = 4H_OB(+1) + 4H_FVG(+1) + 4H_BREAKER(+1) + HTF/D1_FIB + PD_ALIGNED(+0.5)`.

Band outcomes (`cf_zonescore_bands.csv`):

| band | n | exp | PF |
|---|---|---|---|
| **<2** | 2,061 | **+0.438** | **1.82** |
| 2–2.9 | 8,848 | −0.104 | 0.86 |
| 3–3.9 | 12,961 | −0.104 | 0.86 |
| **4–4.9** | 10,056 | **−0.036** | 0.95 |
| **5+** | 8,724 | **+0.177** | 1.28 |

**The curve is U-shaped, and the gate at 4 admits the worst band and excludes
the best one.** It does discriminate at its own boundary (3.5–3.9 = −0.195 vs
4–4.5 = +0.008), which is why it was the one VALUE_ADD gate in the
counterfactual (survivor exp −0.004 → +0.063, PF 1.09).

**Role: keep as a HARD_GATE for now, but decompose.** Its `htfConfluenceScore`
sub-terms (4H_OB / 4H_FVG / 4H_BREAKER / FIB / PD) are the *same concepts* as
confluence's HTF POI Alignment and HTF Fib+PD+Liquidity factors — so the
duplication is not only inside confluence, it is **across** confluence and Zone
Score. Decomposing lets the new model use `fibScore` and `htfLayerCount`
separately instead of an aggregate whose shape is non-monotonic.

THRESHOLD_REQUIRES_REGISTERED_TEST — including whether a two-sided rule
(`<2 OR ≥5`) beats `≥4`, which the band table hints at but which is exactly the
kind of post-hoc cut that must be pre-registered before it is believed.

## 7. DISPLACEMENT — OBSERVATIONAL, with a specific conceptual home

Direct confirmation test found:

- the tercile split **degenerates** (43.8% zeros → LOW=0, HIGH=≥1, MID empty), so the +0.150 was a **binary presence** effect, never a dose-response
- **non-monotonic above 1**: 0 → −0.269, **1 → −0.077**, 2 → −0.116, 3 → −0.159, 4 → −0.427, 6 → −0.663, 9 → −0.780, 12 → −1.046 (n=51, zero wins)
- HIGH cohort positive on only **2/8** instruments, strongly negative on **4/8**
- but genuinely **independent** of existing filters (agreement 0.44–0.66 vs confluence, zone score, Market Structure) and its marginal delta *grows* after them (+0.066 → +0.099 after Zone Score ≥4)
- interacts with exits: time-stopping helps disp=0 (+0.088) and **hurts** disp≥1 (−0.019)

**Conceptual home: SETUP QUALITY, and a candidate input to EXIT policy — not an
entry gate.** The last bullet is the interesting one: displacement predicts how
long a setup needs, which is an exit-horizon question, not an admission question.

## 8. SESSION — explicit rule, asset-class-scoped

Only ROBUST_POSITIVE factor (+0.061 / +0.101, 6/0 instruments). But it is
largely time-of-day, and `hourUTC`/`minuteOfDay` were themselves Tier-A on the
feature screen while being **the same variable** (agreement 1.000) and failing
the stratified control (sign held in only 1 of 3 zone timeframes).

**Decision: SOFT_CONTEXT as an explicit session-window condition, scoped by
asset class.** Crypto trades 24/7 and its median hold is 1.26h vs FX 5.82h; a
single session rule across both is not supported. Not a weight — a named
condition, recorded in telemetry, tested separately.

## 9. EXECUTION EFFICIENCY — a separate layer, not a confluence factor

The three largest raw effects in the entire screen are execution mechanics:

| feature | ΔEXP | H1 | H2 |
|---|---|---|---|
| `spreadOverStop` | **−0.416** | −0.379 | −0.458 |
| `costR` | **−0.413** | −0.396 | −0.435 |
| `spreadOverATR` | −0.277 | −0.217 | −0.336 |

They were Tier D (INSUFFICIENT) only because the tercile split left too few
per-instrument samples — **not** because the effect is weak. They are
deterministic: a wide spread relative to the stop subtracts R by arithmetic.

**Design: `EXECUTION_EFFICIENCY` as its own gate, evaluated after geometry and
before order placement.** Reject when expected round-trip cost consumes too much
of initial R, or when the spread-to-stop ratio is pathological. Median live
`costR` is 0.078 with p90 0.274 and a **max of 2.08** — trades exist where cost
exceeds the entire risk. Production already has a precedent for this shape: the
IPO strategy's `COST_R_HARD_LIMIT`.

THRESHOLD_REQUIRES_REGISTERED_TEST.

## 10. CONCEPT SEPARATION (the core architectural change)

Today one score mixes all four. The replacement keeps them apart:

| layer | contents | nature |
|---|---|---|
| **A. SETUP EXISTENCE** | direction verdict, zone exists, structure valid | HARD_GATE — already exists, unchanged |
| **B. ENTRY READINESS** | `priceAtZoneStrict`, `sideOk`, Layer-3, route selection | HARD_GATE — already exists, unchanged |
| **C. SETUP QUALITY** | at most 2 evidence-backed signals | the only place new work belongs |
| **D. RISK / EXECUTION** | cost-in-R, spread-to-stop, stop size | HARD_GATE — new, separate |

Only **C** is genuinely uncertain. A, B and D are either already production or
mechanically justified.

## 11–12. FX vs CRYPTO

9 of 20 measurable factors **disagree in sign** between FX and crypto
(FVG, Judas Swing, Unicorn, P/D & Fib, Liquidity Sweep, AMD, Daily Bias,
Pullback Health, HTF Fib+PD+Liq). Median hold 5.82h FX vs 1.26h crypto.

They may share layers A, B and D. They must **not** share layer C or any
session rule until evidence says they can.

---

## CANDIDATE ARCHITECTURES

All within the 5-decision-variable limit, excluding setup existence, SL/TP and
sizing. No thresholds chosen.

### MODEL A — MINIMAL GATES (3 variables)

```
direction valid  AND  zone exists            [existing, layer A]
  → Zone Score gate                          [1] THRESHOLD_REQUIRES_REGISTERED_TEST
  → Route 1 arming (strict + sideOk + L3)    [2] existing, layer B
  → EXECUTION_EFFICIENCY                     [3] THRESHOLD_REQUIRES_REGISTERED_TEST
  → trade
```

**Confluence is deleted entirely.** Justification: it is inert (Δ −0.0036),
non-monotonic, and 96.5% of its rejections are indiscriminate. This is the
strict null — if the strategy needs an entry-quality layer at all, A should
underperform B.

### MODEL B — STRUCTURE + ONE QUALITY SIGNAL (5 variables)

```
direction valid  AND  zone exists
  → Zone Score gate, DECOMPOSED:
        fibScore                             [1] THRESHOLD_REQUIRES_REGISTERED_TEST
        htfLayerCount                        [2] THRESHOLD_REQUIRES_REGISTERED_TEST
  → impulse_displacement (binary ≥1)         [3] THRESHOLD_REQUIRES_REGISTERED_TEST
  → session_window                           [4] THRESHOLD_REQUIRES_REGISTERED_TEST
  → EXECUTION_EFFICIENCY                     [5] THRESHOLD_REQUIRES_REGISTERED_TEST
  → trade
```

Uses only the two concepts with any stability evidence (Session Quality 6/0,
displacement independent-and-additive) plus the decomposed Zone Score. Each is
one canonical representation of its cluster.

### MODEL C — ASSET-CLASS SPECIFIC (4 FX / 3 crypto)

**FX**
```
direction + zone → Zone Score gate [1]
                 → session_window (London/NY/Overlap)     [2]
                 → impulse_displacement                    [3]
                 → EXECUTION_EFFICIENCY                    [4]
```

**CRYPTO** — no session rule (24/7; median hold 1.26h), and the one arm where
time-stopping showed benefit (+0.081 to +0.129):
```
direction + zone → Zone Score gate [1]
                 → EXECUTION_EFFICIENCY                    [2]
                 → max-hold / time policy                  [3]  (exit-side, see note)
```

Note: C deliberately puts a *time* variable in crypto rather than another entry
filter, because that is where the exit study found asset-class benefit. It is
the only model that acts on the FX/crypto divergence rather than averaging over
it.

---

## 15. TELEMETRY REQUIREMENTS

Every retained decision variable must land in `entry_decision_snapshot`
(shipped in `056a9da6`). Current snapshot already carries `zoneScore`,
`confluenceScore`, `displacementCandles`, `priceAtZoneStrict`, `sideOk`,
`zoneHigh/Low/Type`, `directionVerdict`.

**To add for the models above:** `fibScore`, `htfLayerCount`, `session_window`,
`costR`, `spreadOverStop`, `stopOverATR`, and a `model_id` naming which
architecture approved the trade. Extend `entryDecisionSnapshot()` in
`_shared/smcTradeTelemetry.ts` — the allow-list exists for exactly this.

## 16. FUTURE COMPARISON TEST (do not run yet)

`SMC_CONFLUENCE_MODEL_COMPARISON_V1`. Held constant: the 8-instrument corrected
corpus, 180d with H1/H2 split, FX session gating, crypto 24/7, forming-bar
reconstruction, 5-min cadence, Route 1 geometry, 2R, frozen costs, 1m causal
execution, one-position sequencing.

Arms: CONTROL (current production) vs A vs B vs C, over the **same** armed
population — models may only *subtract* trades, never add.

Report per arm: n, WR, gross and net expectancy, PF, maxDD, **trade retention
%**, H1/H2, per instrument, FX vs crypto. Retention matters as much as
expectancy: a model that reaches positive by keeping 20 trades has not found an
edge.

Pre-register thresholds before running. Any variable marked
THRESHOLD_REQUIRES_REGISTERED_TEST gets a declared value **first**.

## 17. RETIREMENT STANDARD — declared in advance

**ENTRY_SELECTION_REBUILD_FAILED** if no candidate model achieves *all* of:

- net expectancy > 0
- PF > 1
- same-signed expectancy in H1 and H2
- positive on ≥ 5 of 8 instruments, and not dependent on 1–2 symbols
- ≥ 300 retained trades over 180 days

On that outcome: **stop adding entry filters.** Nine audits will have tested
entry selection from every angle and found one stable signal worth ~0.15R
against a −0.18R population. The remaining surfaces would be exit horizon
(displacement-conditional), position sizing, and whether the strategy should run
at all in its current form.

## 18. RECOMMENDED ARCHITECTURE TO TEST FIRST

**MODEL A.**

Not because it is likely best — because it is the **null hypothesis**, and no
other result is interpretable without it. Confluence is measurably inert; A
deletes it and keeps only what the counterfactual showed to be VALUE_ADD (Zone
Score) plus a mechanically-justified cost gate. If A matches or beats CONTROL,
the entire confluence layer is dead weight and B and C are answering a question
that does not exist. If A is clearly worse, that is the first positive evidence
in nine audits that an entry-quality layer earns its place — and B becomes worth
running.

Run A and CONTROL together first. Only then B, then C.
