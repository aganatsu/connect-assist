# IPO Research — Frozen Handoff State

**Frozen 2026-09-20. Production was never modified at any point in this programme.**

This is the canonical state of the IPO / contraction research. Anyone resuming
should read this before touching any `ipo*` module. Everything below is frozen:
change it only with a deliberate decision recorded here, not as a side effect.

---

## 1. The frozen IPO teaching rule

> **bullish expansion → the last BEARISH candle before the move**
> **bearish expansion → the last BULLISH candle before the move**

Sourced directly, and repeated more than any other statement in the material:

- *"There's an IPO at last candle up before the down move"* — Trade with no Contraction, 08:55
- *"this is the last candle down before this expansion to the upside. So this is automatically an IPO"* — 11:46
- repeated verbatim at 12:04, 12:19, 32:18, 38:31, 45:41, 46:58, 51:02, 52:53, 54:18
- *"Last Bullish before the big drop"* / *"last bearish candle before the big push up"* — Smart money part 1, on-screen

**The candle rule is not in question. The unresolved variable is "the move".**

### Geometry (frozen, independently confirmed)

Zone = the proximal HALF of a single candle; distal = midpoint of the FULL WICK
range; extent = far wick, invalidation only.

Confirmed from Ezzy's own chart: a fib anchored across one candle with `0.5`
drawn in red and captioned `PREVIOUS IPO 50%`, measured at y=466.0 against
level-1 y=380.5 and level-0 y=551.5 — the exact midpoint. Also stated verbally:
*"right here 50 of the candle that's where the market will reverse"* (05:17).

---

## 2. Admissible Ezzy corpus

| row | tier | role | admissible for rule selection |
|---|---|---|---|
| BTC/USD 1d 2020-04-20 demand | TIER_1 | **STANDALONE_ORIGIN** | **yes** |
| BTC/USD 4h 2020-05-08 16:00 supply | TIER_1 | **STANDALONE_ORIGIN** | **yes** |
| BTC/USD 1d 2020-05-11 demand | TIER_1 | HTF_PARENT_ANCHOR | separate analysis |
| BTC/USD 4h 2020-05-11 16:00 demand | TIER_1 | REFINEMENT_CHILD | separate analysis |
| BTC/USD 1d 2020-03-27 demand | TIER_3 | unassignable | **no** |
| BTC/USD 1d 2020-04-08 supply | TIER_3 | unassignable | **no** (no containing leg) |

Plus one labelled but span-only IPO: BTC/USD 1h BITSTAMP ~2020-07-02 10:00-13:00
(supply), from the `IPO` caption in Manipulation Exposed. Not resolved to a bar.

**Primary validation set = n = 2.**

Tier and source family are persisted as real columns (`confidence_tier`,
`source_family`) by migration `20260920200000`. They were previously recoverable
only from a chat transcript.

### The three roles (frozen)

- **STANDALONE_ORIGIN** — last opposite candle before the terminal break-producing move
- **HTF_PARENT_ANCHOR** — HTF POI marking where the whole move originated; contains the refined child
- **REFINEMENT_CHILD** — the LTF bar that produced the parent's extreme; geometry re-derived from the child

Separating these dissolved a contradiction that blocked the origin work for
several rounds: an HTF parent marks the FIRST displacement out of a swing, a
standalone marks the TERMINAL one — opposite ends of the same leg.

**The refinement child has no qualifying move at all** (1 bar, −0.34 ATR, no FVG,
no break). Do not require one for that role.

---

## 3. Frozen contraction model

```
E1_STRUCTURE_STALL → W2_ALTERNATION_RISE → S_AFTER_STALL → B0 band init → FULL_WICK → X_BODY_EXPANSION
```

| stage | definition |
|---|---|
| E1_STRUCTURE_STALL | from `confirmedSwings`: the first swing that fails to extend a running HH+HL (or LL+LH) progression |
| W2_ALTERNATION_RISE | close-direction reversal fraction after the stall exceeds the pre-stall fraction |
| S_AFTER_STALL | box starts at stall + 1 |
| B0 | band initialised over seed → sideways confirmation |
| FULL_WICK | band = highest high / lowest low (beats body and close envelopes: 0.69/0.76 vs 0.40/0.37) |
| X_BODY_EXPANSION | exit on a close outside the band whose body exceeds the mean body inside |

**Primary objective is functional PRICE-region agreement, not time-IoU.** Every
one of Ezzy's six references to a contraction box uses price — the 50% level,
stops above/below it, liquidity below it. **None refers to where the box starts
or ends in time.**

Performance: vertical IoU 0.69 all / 0.76 on EXACT-confidence labels; marked 50%
recovered inside the detected band 5/5 on EXACT labels; OOS coverage ~26%.

Directly taught and recorded as `DIRECT_TEACHING` in `ipoProvenance.ts`:
progression stops (07:15) · equal highs/lows inside (07:15, 17:34) · low volume,
"more like a sideway move" (17:34) · **IPOs are NOT taken from inside a
contraction** (15:52) · uncleared contraction stays a target (15:41, 57:43) ·
50% of the box is a reversal level (55:37) · contraction near a trend line
signals the break (36:11) · stop beyond the whole box (39:03) · box sits between
two IPOs (19:15) · session gating (48:49).

---

## 4. Frozen move-detection research

**Onset candidate: `O4_FIRST_FVG_SEQ`** — the move begins at the first bar of the
three-bar sequence forming the first aligned imbalance of the departure.

It produced 2/2 standalone exact under three independent move families, which is
why onset — not the move family — is treated as the decisive variable.

**Pre-registered triggers** (frozen in `ipoMoveDetection.ts` as `PREREGISTERED`,
snapshot sha1 `6dbb64512b1cde73fb2d0d305e9f8147710624b6`):

| id | move family | onset | candidate density (1d/4h) |
|---|---|---|---|
| **R1_PRECISION** | M1_STRUCTURAL_BREAK | O4 | 3.5% / 3.2% |
| **R2_BROAD** | M2_DISPLACEMENT | O4 | 7.2% / 5.3% |

Both recover both admissible standalone IPOs EXACTLY.

### THE UNRESOLVED QUESTION

**Is a structural break part of Ezzy's IPO definition, or only a density filter?**

R2 uses no BOS and still gets 2/2. R1 adds BOS and gets the same 2/2 at half the
candidate density. On the available evidence BOS looks like a *precision filter*,
not part of the definition — but two examples cannot separate them. **Do not
assume BOS is required.** Nothing in the teaching mentions it.

Refuted along the way: M5_CONTRACTION_EXPANSION (0/2, −98 to −119 bars —
contraction exit is useless as a move detector, which independently confirms it
cannot be mandatory); M6_STRUCTURE+DISPLACEMENT (1/2); M3_DIRECTIONAL_RUN (0–1/2
— path efficiency finds contraction, not departure); O3_SUSTAINED_RUN_START.

---

## 5. Excluded evidence — do not reintroduce

| excluded | reason |
|---|---|
| **TubePull** `SMC_Entry_Confirmation` | `TUBEPULL_UNKNOWN_SOURCE` — not shown to be the same teacher; must never be pooled with EZZY |
| **USER_INDEPENDENT** rows | the user's own trading judgments; must not be reclassified as Ezzy demonstrations |
| **TIER_3** rows (1d 2020-03-27, 1d 2020-04-08) | no source file exists on disk; cannot be re-verified |
| **Cursor-only labels** | the crosshair reports mouse position, not the candle being described |
| **Heikin Ashi charts** | synthetic OHLC; cannot be compared with ordinary candle geometry |
| `FINAL_BASE_EXIT`, `PERMANENT_BASE_EXIT` | `DEGENERATE_FOR_RESEARCH` — exact duplicates of `LAST_OPPOSITE_BEFORE_BREAK` (4/4) |

---

## 6. Why further validation is blocked

**No additional persistent, candle-resolving Ezzy annotation exists in the
current source set.**

All 13 IPO identifications in "Trade with no Contraction" were classified:
0 class A, 1 class B (a freehand ellipse around ~10 candles, resolving no single
candle), the rest class C/D. In that video Ezzy marks **prices** with horizontal
zone lines and lets a third-party indicator draw the boxes; he never draws a
rectangle on an IPO candle.

Smart money parts 1–3 are schematic drawings or zone-drawing lessons with no IPO
labels. "Manipulation Exposed" supplied the labelled IPO and the four Tier-1
rows and is exhausted.

One near miss worth knowing: identification I02/I03 is **BTC/USD 4h BITSTAMP,
July 2019** — the only non-2020 example found anywhere. It fails on annotation
class, not on relevance.

**The bottleneck is source availability, not algorithm development.**

---

## 7. What would unblock this

In priority order:

1. **An Ezzy video with a persistent IPO box or line tied to a specific candle** — the "Manipulation Exposed" format (screen-share, drawn boxes, on-screen captions) is the one that yields admissible evidence. Apply that as a filter before investing in frame extraction.
2. **A different year or market regime.** Everything admissible is BTC/USD in a six-week window of 2020.
3. **A no-BOS standalone IPO**, persistently marked. This is the single most valuable example available: it would separate R1 from R2 in one observation.

---

## 8. Known defects and degeneracies (recorded, not fixed)

- **Long-episode swallowing.** Contraction episodes can merge contraction → expansion → trend → new contraction. 13 episodes over 25 bars in 5,909 OOS bars, max 86. Five segmentation rules and four band initialisations all failed to fix it without material cost. UNRESOLVED.
- **EG-2** (EUR/GBP 30m 2020-08-17) is not body-compressed under any context length (1.26–2.07). Four hypotheses tested and refuted. Its only contraction-like property is directional efficiency 0.01 vs 0.38. UNRESOLVED.
- **Low volume is untestable** — TwelveData returns `volume = 0` for FX.
- **"Trend progression stops" at 3/7** is `SUPERSEDED_OPERATIONALISATION`, not a live contradiction: the later `E1_STRUCTURE_STALL` localises 13/13 marked starts.
- **Statistical caution.** The 0.11% / 0.38% chance figures are DESCRIPTIVE ONLY. Candidate density multiplied over two examples is not an inference — the observations are not independent, both come from related 2020 material, and candidate occurrence is temporally clustered.

---

## 9. File inventory

All research-only. None is imported by production; a test in
`supabase/tests/_shared/ipoZones.test.ts` enforces that and must be updated
consciously when a new shadow module is added.

| file | role |
|---|---|
| `ipoZones.ts` | zone geometry, corpus validation, inventory, coverage |
| `ipoProvenance.ts` | rule provenance; 23 `DIRECT_TEACHING` entries with verbatim quotes and timestamps; tier and source-family types |
| `ipoCorpusPlan.ts` | corpus insert planning, refinement-chain waves |
| `ipoContraction.ts` | contraction measurement, frozen feature families, degeneracy detection |
| `ipoContractionDetector.ts` | discovery, session-aware context, base rates, IoU evaluation |
| `ipoContractionSeeds.ts` | E1–E6 entry seeds |
| `ipoContractionTwoStage.ts` | the frozen two-stage contraction model |
| `ipoMoveDetection.ts` | M1–M6 move families, O1–O6 onsets, `PREREGISTERED` R1/R2 |
| `ipoOriginExperiments.ts` | pipeline probe, alternative origin definitions |
| `ipoDisplacementOnset.ts`, `ipoOriginAnchor.ts`, `ipoAnchorDiscriminator.ts`, `ipoTeachingSpec.ts`, `ipoOnsetVariants.ts` | earlier frozen origin experiments |

Full running research log, including every refuted hypothesis:
`~/ipo-frames/MODE_A_CANDIDATES.md`.

Transcripts on disk:
`~/Downloads/Forex & Crypto Manipulation Exposed … .txt` and
`~/Downloads/TradewithnoContraction_transcript.docx`.

---

## 10. Raw profitability backtest (2026-09-21)

Harness: `ipoRawBacktest.ts` + `ipoRawBacktest.test.ts`. 2 entries x 2 stops x
5 targets, pre-registered, over the valid IPO population from `runLifecycle`.
No detector tuning, no confluence, no ranking. **Production changed: NO.**

**Data caveat.** The specification asked for EUR/USD 1H 2021, BTC/USD 1H 2021 and
USD/JPY 30m 2022. What exists on disk is the frozen OOS set: three ~2-3 month
windows (2021-03..06, 2021-05..08, 2022-02..04), 5,909 bars total. These are
quarters, not years. Every figure below is quarter-scale.

### Headline

**49 of 60 instrument x model cells lose money net of costs.** The only coherent
positive family is `E2_50_PERCENT + S2_CLOSE_INVALIDATION`: +0.373R (EUR/USD),
+0.381R (USD/JPY), **-0.043R (BTC/USD)** at 2R.

Costs flip 23 cells from gross-positive to net-negative. E2's cost drag is double
E1's (0.33-0.47R vs 0.15-0.22R) because its R unit is half the candle range.

`T_STRUCTURAL` is the worst target in all 12 cells it appears in (-0.165 to
-1.057R). Treat as refuted, not merely unpromising.

### The placebo controls — the important result

All arms: E2+S2+T_2R, net. Net expectancy R:

| arm | EUR/USD | BTC/USD | USD/JPY |
|---|---|---|---|
| **A** valid IPO (lifecycle) | **+0.373** | **-0.043** | **+0.381** |
| **B** candidates the promotion gate REFUSED | -0.231 | -0.920 | -0.496 |
| **C** candidates suppressed inside a contraction | +0.057 | +0.050 | +0.240 |
| **D** random bar, same geometry | -0.049 | -0.143 | +0.015 |
| **E** every 7th candle, same geometry | +0.128 | -0.200 | +0.073 |

**A beats D on all three and beats B by 0.60-0.88R on all three, including BTC
where A itself loses.** The opposite-side clearance gate is separating winners
from losers even where the system is unprofitable. That is the strongest
evidence yet that the trader-defined lifecycle encodes something real, and it is
independent of whether the raw system is tradable.

**C is mildly POSITIVE on all three.** The contraction-suppression rule is
discarding roughly break-even trades, not bad ones. It is the weakest-earning
component. Recorded, not changed — the rule is trader-specified and frozen.

### Hidden risk in the one profitable cell

S2 tolerates unlimited adverse wicking, so nominal R understates realized risk:

| | median MAE | p90 MAE | max MAE | % trades > 2R adverse |
|---|---|---|---|---|
| EUR/USD | 1.25R | 2.75R | 12.0R | 21.3% |
| BTC/USD | 1.29R | 2.85R | 12.0R | 27.2% |
| USD/JPY | 1.14R | 2.60R | 17.8R | 21.6% |

The median trade travels further against the position than its own nominal stop
distance. +0.37R expectancy is not free.

### Concurrency

Untradeable as raw output: 470-1026 setups/month; max 114 simultaneous positions
(BTC, E1+S1), avg 13.1. Under E2+S2 it falls to 18-22 max, avg 2.0-2.5.

**One trade per instrument at a time improves every cell** and turns BTC
positive: +0.416 / +0.140 / +0.488 R at 2R (EUR / BTC / JPY), 245-320 trades.
Arrival-order selection is causal, so this is a legitimate variant.

### Strongest descriptive splits (descriptive only, NOT filters)

- **FVG present vs absent** is the largest split found: +0.462 vs -0.330 R under
  E2+S2; -0.126 vs -0.523 R under E1+S1. Consistent in sign and size in both.
- **First touch** is best under E2+S2 (+0.457 vs +0.106 / +0.093) and *worst*
  under E1+S1 (-0.362 vs -0.167 / -0.206). The effect interacts with the model;
  it is not a standalone property of the touch.
- `afterContraction` is degenerate here: every setup had a prior episode.

---

## 11. Independent confluence measurement (2026-09-21)

`ipoConfluenceFeatures.ts` + `ipoConfluenceFeatures.test.ts`. Annotation only —
no weights, no score, no threshold, no combinations, nothing dropped for
performing badly. Evaluated under the frozen `E2_50_PERCENT + S2_CLOSE_INVALIDATION
+ T_2R` model, net of costs. **Production changed: NO.**

Every feature is computed from `series.slice(0, touchIndex + 1)` only; a test
asserts each one is unchanged when future bars are removed.

### Definitions — all delegate to existing code, none invented

| feature | existing definition used |
|---|---|
| FVG | the frozen lifecycle's own `hasFvg` — not recomputed |
| TREND_ALIGNED | last **external** break from `directionalEvents`, strictly before the touch |
| HTF_PARENT | the frozen `runLifecycle` re-run on a 4h resample of the same series |
| FIB_50_100 | `detectZigZagPivots` + `computeFibLevels`; entry retracement in 50-100% |
| SR_OVERLAP | `detectLiquidityPools` equal-high/low cluster inside the IPO zone |
| INSTITUTIONAL_IPDA | `calculateIPDARanges` + `ipdaRangesToKeyLevels` on a daily resample |
| INSTITUTIONAL_VOLUME_PROFILE | **NOT_YET_MACHINE_DEFINED** |

Volume-profile POC/HVN is unresolved on every row, deliberately: the logic exists
only inline inside `runConfluenceAnalysis`, not as an extractable primitive, and
TwelveData returns volume = 0 for FX (BTC has volume; EUR/USD and USD/JPY do not).
Not approximated by anything else.

Tri-state where it matters: `NO_TREND_REFERENCE` is not `counter-trend`, and
`NO_PARENT` is not `CONFLICTING_PARENT`.

### Baseline

Pooled, unrestricted: **2,970 trades, 64.4% win, +0.212R, PF 1.27, avg MAE 1.45R,
avg cost 0.404R.**

### Separation, pooled (expectancy R)

| feature | present | absent | spread |
|---|---|---|---|
| **FVG** | **+0.462** (2033) | **-0.330** (937) | **0.79** |
| **SR_OVERLAP** | **+0.532** (430) | +0.158 (2540) | **0.37** |
| HTF_PARENT aligned | +0.280 (516) | +0.221 no-parent / +0.222 conflicting | 0.06 |
| TREND_ALIGNED | +0.163 (1935) | +0.303 (1035) | **-0.14 (inverted)** |
| FIB_50_100 | +0.073 (1142) | +0.299 (1828) | **-0.23 (inverted)** |
| INSTITUTIONAL_IPDA | +0.105 (123) | +0.152 (2167) | -0.05 |
| touch 1st vs 3rd+ | +0.457 (955) | +0.093 (1562) | 0.36 |

### Which separations are STABLE across instruments

**FVG is the only feature that separates in the same direction on all three**,
and it reproduces the earlier pooled split exactly (+0.462 / -0.330):

| | absent | present | spread |
|---|---|---|---|
| EUR/USD | -0.028 | +0.578 | 0.61 |
| BTC/USD | -0.678 | +0.192 | 0.87 |
| USD/JPY | -0.248 | +0.718 | 0.97 |

FVG-absent loses on all three; FVG-present wins on all three, **including BTC**,
where the raw population is unprofitable overall (-0.043R).

**SR_OVERLAP separates on two of three.** BTC -0.110 -> +0.462 and USD/JPY
+0.313 -> +0.685, but **EUR/USD shows none at all** (+0.374 absent vs +0.362
present). Reported, not averaged away.

### Features that do NOT separate

- **TREND_ALIGNED is inverted or flat everywhere.** Counter-trend is never worse:
  EUR/USD +0.590 counter vs +0.231 aligned; BTC -0.030 vs -0.051; USD/JPY +0.456
  vs +0.348. Before reading this as "fade the trend", note that an IPO touch is
  by construction a retracement entry, so "counter to the last external break"
  may be labelling the pullback rather than the position. A different trend
  reference would be needed to separate those. Recorded as measured.
- **FIB_50_100 is inconsistent in sign**: inverted on EUR/USD (+0.487 -> +0.178)
  and BTC (+0.143 -> -0.314), normal on USD/JPY (+0.321 -> +0.485). No stable
  separation.
- **INSTITUTIONAL_IPDA is effectively untested.** Only 123 of 2,970 rows resolve
  PRESENT, and the windows hold just 52-92 daily bars, so the 60-day range is
  rarely available. No conclusion either way.

### HTF parent

Aligned parent barely beats no parent (+0.280 vs +0.221 pooled), and a
*conflicting* parent is not worse (+0.222). The one signal is **PARENT_BOTH_SIDES**
— the entry price inside both a bullish and a bearish live HTF zone — which is
negative on all three (EUR -1.516 n=12, BTC -0.129 n=85, JPY -1.050 n=6), pooled
-0.344 over n=103. Small samples; flagged, not concluded.

### Touch number reverses under the execution constraint

| | 1st | 2nd | 3rd+ |
|---|---|---|---|
| unrestricted | +0.457 | +0.106 | +0.093 |
| one trade at a time | +0.283 | +0.231 | **+0.434** |

Unrestricted, first touch looks much better and the decline is monotone on all
three instruments. Under the causal one-trade-per-instrument constraint the
ordering **inverts**. The sequential filter drops overlapping first touches, so
part of the apparent first-touch advantage is an artefact of counting
simultaneous positions. Do not treat "first touch is better" as established.

### One-trade-at-a-time, pooled

873 trades, 68.5% win, +0.340R, PF 1.47 — better than unrestricted on every
feature level. FVG still separates: +0.556 present vs -0.171 absent.

---

## 12. A+ classifier, variants A1-A4 (2026-09-21)

`ipoAPlusClassifier.ts` + 13 tests. Pure conjunctive membership: no weights, no
score, no thresholds, no tuning. Tests assert that excluded features cannot
influence admission and that no numeric cutoff appears in any admission rule.
Execution frozen at `E2_50_PERCENT + S2_CLOSE_INVALIDATION + T_2R`, net of costs.
**Production changed: NO.**

| variant | rule |
|---|---|
| A1 | valid IPO + FVG |
| A2 | valid IPO + FVG + SR_OVERLAP |
| A3 | valid IPO + FVG + NOT `PARENT_BOTH_SIDES` |
| A4 | valid IPO + FVG + SR_OVERLAP + NOT `PARENT_BOTH_SIDES` |

### Pooled, unrestricted

| arm | n | win% | expR | PF | maxDD | streak | totalR | MAE | maxCon |
|---|---|---|---|---|---|---|---|---|---|
| random-bar control | 2431 | 59.9 | -0.063 | 0.94 | 191.5 | 18 | -152.4 | 1.62 | 42 |
| FVG-absent control | 937 | 50.1 | -0.330 | 0.70 | 347.2 | 17 | -309.0 | 1.68 | 20 |
| baseline raw valid IPO | 2970 | 64.4 | +0.212 | 1.27 | 156.5 | 11 | +629.8 | 1.45 | 29 |
| **A1** | 2033 | 71.1 | **+0.462** | 1.71 | 51.5 | 9 | +938.8 | 1.34 | 26 |
| **A2** | 271 | 79.0 | **+0.836** | 2.89 | 16.0 | 6 | +226.6 | 1.17 | 10 |
| A3 | 1950 | 71.4 | +0.481 | 1.75 | 51.5 | 9 | +937.4 | 1.33 | 26 |
| A4 | 265 | 78.9 | +0.852 | 2.98 | 12.8 | 6 | +225.8 | 1.16 | 10 |

### The control result that reframes FVG

Applying FVG to RANDOM anchors lifts them from -0.063R to **+0.215R** — the same
size of lift it gives IPO anchors (+0.212 -> +0.462). **FVG is a general filter,
not an IPO-specific quality marker.**

It does not, however, substitute for the IPO anchor. The two stack almost
additively, and A1 stays well clear of the filtered control:

| | raw | + FVG | + FVG + SR |
|---|---|---|---|
| random anchors | -0.063 | +0.215 | +0.393 |
| **valid IPO anchors** | **+0.212** | **+0.462** | **+0.836** |

The IPO anchor is worth ~+0.25R on top of FVG, and ~+0.44R on top of FVG+SR.

### Per instrument, unrestricted (A1 / A2)

| | baseline | A1 | A2 | A1 t/mo | A2 t/mo |
|---|---|---|---|---|---|
| EUR/USD | +0.373 | +0.578 | +0.812 | 174.0 | 18.7 |
| BTC/USD | **-0.043** | **+0.192** | **+0.741** | 283.7 | 36.7 |
| USD/JPY | +0.381 | +0.718 | +0.949 | 347.4 | 55.3 |

**A1 turns BTC positive** (-0.043 -> +0.192), which is the instrument the raw
population failed on. A2 improves every instrument again, including EUR/USD
(+0.812) where SR_OVERLAP was NEUTRAL on the unfiltered population — an
interaction, on n = 56, not an independent confirmation.

### One trade at a time (classify, then sequence)

| arm | n | win% | expR | PF | maxDD | streak | MAE |
|---|---|---|---|---|---|---|---|
| baseline | 405 | 66.2 | +0.307 | 1.43 | 28.3 | 8 | 1.37 |
| FVG-absent | 276 | 55.8 | -0.099 | 0.90 | 51.2 | 8 | 1.63 |
| **A1** | 389 | 74.8 | **+0.602** | 2.08 | 20.3 | 5 | 1.23 |
| **A2** | 123 | 80.5 | **+0.840** | 3.00 | 8.7 | 2 | 1.15 |
| A3 | 390 | 74.9 | +0.605 | 2.08 | 20.3 | 5 | 1.23 |
| A4 | 120 | 80.8 | +0.893 | 3.31 | 4.9 | 2 | 1.11 |

Cross-check (sequence the FULL stream first, then ask which were A+ — the
conservative order, since A+ trades get blocked by trades the classifier would
never take): A1 +0.556 over n=614, A2 +0.786 over n=77. Same conclusion.

### Risk and frequency

Drawdown and MAE fall monotonically with selectivity. Pooled unrestricted maxDD
156.5R -> 51.5R (A1) -> 16.0R (A2); MAE 1.45 -> 1.34 -> 1.17; max concurrent
29 -> 26 -> 10. Under one-at-a-time, A2's worst losing streak is 2.

Trade count does NOT collapse: A1 = 174-347/month per instrument unrestricted and
65-133 sequenced; A2 = 19-55/month unrestricted and 11-25 sequenced.

### A3/A4 verdict

`NOT_PARENT_BOTH_SIDES` adds +0.019R over A1 for 83 fewer trades, and +0.016R
over A2 for 6 fewer trades. Real but negligible, on the n=103 sample already
flagged as underpowered. **It does not justify inclusion.**

### FROZEN FOR UNTOUCHED-DATA VALIDATION

**Primary: A1. Secondary: A2.** Both go to the fresh period together; neither is
chosen over the other on this data. A3 and A4 are recorded and dropped.

Validation data must be a different year AND a different regime from
2021-03..08 / 2022-02..04. Pre-registered pass condition, fixed before seeing it:
A1 expectancy > 0 on all three instruments under both execution models, with
FVG-absent still negative. Anything less is a failure, not a prompt to re-tune.

**Do not modify A1 or A2 before that validation runs.**

---

## 13. TRUE UNTOUCHED VALIDATION — A1 FAILED (2026-09-21)

Fresh TwelveData pull, periods declared BEFORE fetching and never previously used
in IPO research. Classifier, lifecycle, confluence logic and execution rules
untouched: the only diff against the development runner is the three file paths
and the month counts. **Production changed: NO.**

| instrument | window | bars |
|---|---|---|
| EUR/USD 1H | 2023-09-01 -> 2023-12-01 | 1,558 |
| BTC/USD 1H | 2023-09-01 -> 2023-12-01 | 2,180 |
| USD/JPY 30M | 2023-09-01 -> 2023-11-01 | 2,064 |

### VERDICT: **FAILURE**

Pre-registered condition required A1 expectancy > 0 on ALL THREE instruments
under BOTH execution models.

| instrument | A1 unrestricted | A1 one-at-a-time | pass |
|---|---|---|---|
| EUR/USD | +0.808 | +0.841 | yes |
| **BTC/USD** | **-0.543** | **-0.467** | **NO** |
| USD/JPY | +0.774 | +0.830 | yes |

FVG-absent remained negative overall (pooled -0.404). Two of four clauses passed;
the condition is conjunctive, so **A1 fails**. Not retuned.

### Data-integrity finding (found before attributing the failure)

The 2023 BTC feed contained **5 corrupt bars** with lows of ~2.58 against ~26,000
opens (idx 43, 64, 113, 149, 324; closes normal). Zero such bars in the
development BTC file or in either FX validation file.

They inflated BTC MAE from 1.75R to 16.29R and had to be removed before any
conclusion was drawn. Two independent repairs were run:

| BTC feed | A1 expR | baseline expR |
|---|---|---|
| dropped (5 bars removed, primary) | -0.543 | -0.789 |
| repaired (low = min(open, close)) | -0.565 | -0.813 |

Both agree. **The corrupt ticks inflated MAE but did not cause the failure.**

### Full results, primary (dropped) feed

Unrestricted, per instrument:

| arm | EUR/USD | BTC/USD | USD/JPY | pooled |
|---|---|---|---|---|
| random-bar control | +0.172 | -1.189 | +0.159 | -0.294 |
| FVG-absent control | +0.003 | -1.241 | -0.131 | -0.404 |
| baseline raw valid IPO | +0.479 | -0.789 | +0.364 | +0.024 |
| **A1** | **+0.808** | **-0.543** | **+0.774** | **+0.321** |
| A2 | +1.121 | -0.899 | +0.689 | +0.227 |

One-at-a-time pooled: baseline +0.126, A1 **+0.365**, A2 +0.494, FVG-absent -0.057.
Conservative cross-check (sequence first, then classify): A1 +0.433, A2 +0.437.

### What replicated and what did not

**FVG replicated cleanly on all three instruments** — the separation is the same
size as development (0.79 pooled then, 0.73 now):

| | FVG absent | A1 (FVG present) | spread |
|---|---|---|---|
| EUR/USD | +0.003 | +0.808 | 0.81 |
| BTC/USD | -1.241 | -0.543 | 0.70 |
| USD/JPY | -0.131 | +0.774 | 0.91 |

**The IPO anchor replicated.** A1 +0.321 vs random+FVG -0.012 pooled; in
development the same comparison was +0.462 vs +0.215. Both components still add.

**EUR/USD and USD/JPY improved out of sample** (+0.808 vs +0.578 dev; +0.774 vs
+0.718 dev). The system did not decay on the FX pairs.

**BTC broke, and so did everything else on BTC.** The random-bar control on BTC
is -1.189 and the raw baseline -0.789 in a +44.6% trending quarter. Zone-reversion
trading was hostile on that instrument in that regime; A1 still improved on the
baseline by +0.25R, it simply could not cross zero. A1 discriminated; it did not
profit.

### A2

A2 is NOT an improvement and is dropped as a candidate. It beats A1 pooled under
sequencing (+0.494 vs +0.365) and on EUR/USD (+1.121), but it is **worse than A1
on BTC (-0.899 vs -0.543) and worse on USD/JPY (+0.689 vs +0.774)**, and worse
pooled unrestricted (+0.227 vs +0.321). It fails the same BTC clause. The
development-era SR_OVERLAP advantage did not replicate.

### Status

A1 and A2 remain frozen exactly as defined. **No rule was changed in response to
these results, and none may be.** The system is NOT cleared for paper trading.

---

## 14. Regime conditioning — descriptive only (2026-09-21)

`ipoRegimeDescriptors.ts` + 15 tests. Frozen A1, lifecycle, FVG logic, execution
and targets all unchanged; this run only LABELS market state and re-reads the
same trades conditionally. **No filter was created. Production changed: NO.**

### Descriptors, predefined before any data was fetched

- **Trend strength** = path efficiency `|net| / summed travel` — the identical
  formula the frozen S2 contraction exit uses — measured over the current
  structural leg (from the most recent CONFIRMED EXTERNAL swing, so no lookback
  length is chosen).
- **Volatility** = `calculateATR` at period 14 (`DEFAULTS.slATRPeriod`) / price.
- Both bucketed by **distributional thirds** of the instrument's own 2024
  observations. A third is the same division everywhere, encodes no view about
  where a boundary belongs, and consulted no outcome. **Nothing from the failed
  2023 BTC quarter enters any reference distribution.** A test asserts the module
  contains no decimal literal at all.
- RANGING carries no direction: a low-efficiency leg's net sign is noise.

### Data — nine fresh windows, 13,588 bars, none used in prior IPO work

| instrument | A | B | C |
|---|---|---|---|
| BTC/USD 1H | 2024-02..04 **+67.5%** | 2024-06..08 -4.4% | 2024-09..11 +19.1% |
| EUR/USD 1H | 2024-01..03 -2.1% | 2024-06..08 -0.2% | 2024-09..11 -5.0% |
| USD/JPY 30M | 2024-03..05 +5.1% | 2024-07..09 **-9.2%** | 2024-11..12 +3.2% |

Integrity-checked with the median-band test that caught the 2023 BTC glitch:
0 corrupt bars. 3 bars in EUR/USD had a 0.2-pip quote-precision inconsistency
(open quoted to 4dp, low to 5dp) and were widened to contain the quoted open.

### A1 by regime, unrestricted (expectancy R)

| regime | BTC/USD | EUR/USD | USD/JPY |
|---|---|---|---|
| STRONG_BULL | **-0.438** | +0.315 | +0.682 |
| STRONG_BEAR | -0.312 | +0.853 | +0.709 |
| WEAK_BULL | -0.292 | +0.571 | +0.437 |
| WEAK_BEAR | -0.100 | +0.686 | +0.904 |
| RANGING | -0.221 | +0.521 | +0.719 |
| ALL | -0.277 | +0.558 | +0.682 |

**The regime hypothesis is REFUTED on the trend axis. BTC is negative in EVERY
trend regime, including RANGING (-0.221).** Trend strength modulates the damage
(STRONG_BULL -0.438 is the worst, WEAK_BEAR -0.100 the least bad) but nothing
crosses zero. A1 stayed positive in every regime on both FX pairs.

One cross-instrument pattern: the weakest regime on all three instruments is a
BULL one (BTC STRONG_BULL, EUR STRONG_BULL, JPY WEAK_BULL).

### The volatility axis separates far more than trend

| | HIGH_VOL | MID_VOL | LOW_VOL |
|---|---|---|---|
| BTC/USD | **+0.247** | -0.142 | **-0.955** |
| EUR/USD | +0.733 | +0.657 | +0.356 |
| USD/JPY | +0.956 | +0.732 | +0.247 |

**Monotone on all three instruments**, and the BTC spread is 1.20R against only
0.34R across the whole trend axis. BTC LOW_VOL is catastrophic (PF 0.28, 503R
drawdown) while BTC HIGH_VOL is the one positive BTC slice found anywhere.

This was NOT predicted and was found after the fact. It is a hypothesis, not a
result. Turning it into a filter without its own pre-registered test on new data
would repeat exactly the error that A1's failure exposed.

### FVG separation survives inside every regime

| regime | present | absent | spread |
|---|---|---|---|
| STRONG_BULL | +0.177 | -0.619 | 0.796 |
| STRONG_BEAR | +0.342 | -0.180 | 0.523 |
| WEAK_BULL | +0.229 | -0.669 | 0.899 |
| WEAK_BEAR | +0.497 | -0.462 | 0.959 |
| RANGING | +0.337 | -0.313 | 0.650 |

0.52-0.96R in all five, same sign everywhere. FVG is now replicated on four
independent date ranges and is not a regime artefact.

### Cross-checks

One-trade-at-a-time preserves every sign (BTC -0.222, EUR +0.765, JPY +0.759).
The strictly causal expanding-window variant of the thirds agrees with the
full-period reference on all nine windows.

### Status

Regime conditioning on the TREND axis is **not** strong enough to justify an
instrument/regime-specific strategy: it cannot rescue BTC anywhere. The
volatility axis is a genuinely promising open question and is recorded as such.
No trading filter was created.

---

## 15. Volatility hypothesis — PRE-REGISTERED VALIDATION: **PASSED** (2026-09-21)

Hypothesis registered before fetching: under the unchanged `ATR(14)/price`
descriptor and the same distributional-thirds method, frozen A1 expectancy
satisfies HIGH_VOL > MID_VOL > LOW_VOL, and BTC HIGH_VOL > 0. No descriptor,
threshold, boundary or rule was changed. No instrument-specific boundaries.
**Production changed: NO.** No repo file was modified in this run.

### Data — 12 fresh windows, 18,197 bars, none used anywhere before

BTC/USD 1H and EUR/USD 1H: 2022-04..06, 2025-01..03, 2025-04..06, 2025-08..10.
USD/JPY 30M: 2022-08..10, then the same three 2025 windows.
BTC net moves -29.8% / -11.2% / +24.4% / -1.0%. Integrity: 0 corrupt bars,
3 quote-precision repairs on EUR/USD.

Volatility episodes (contiguous same-bucket runs): BTC 99/197/99,
EUR/USD 115/227/116, USD/JPY 193/369/182. Not one or two regimes.

### Result — every pre-registered clause passed

A1 expectancy, unrestricted / one-trade-at-a-time:

| instrument | HIGH_VOL | MID_VOL | LOW_VOL | monotone | HIGH > 0 |
|---|---|---|---|---|---|
| **BTC/USD** | **+0.319 / +0.504** | -0.055 / -0.125 | -0.966 / -0.944 | **YES / YES** | **YES / YES** |
| EUR/USD | +0.721 / +0.977 | +0.658 / +0.809 | +0.411 / +0.433 | YES / YES | YES / YES |
| USD/JPY | +0.904 / +0.841 | +0.766 / +0.756 | +0.511 / +0.601 | YES / YES | YES / YES |

FVG separation stayed positive in all 9 instrument x bucket cells (+0.368 to
+1.075). That is now five independent date ranges.

### Caveat 1 — the causal cross-check breaks on EUR/USD

Ranking each bar only against its own past instead of the full-period
distribution: BTC +0.275 / -0.014 / -0.942 (monotone), USD/JPY +0.991 / +0.761 /
+0.448 (monotone), **EUR/USD +0.594 / +0.729 / +0.411 (NOT monotone)**. The
EUR/USD ordering partly depends on the full-period reference.

### Caveat 2 — the effect is NOT IPO-specific

HIGH minus LOW expectancy, per arm:

| instrument | baseline | A1 | FVG-absent | random+FVG |
|---|---|---|---|---|
| BTC/USD | 1.055 | 1.285 | 0.600 | **1.165** |
| EUR/USD | 0.283 | 0.310 | 0.249 | 0.235 |
| USD/JPY | 0.369 | 0.393 | 0.188 | 0.121 |

Random anchors with the same geometry show nearly the same volatility gradient as
A1 on BTC. **Volatility conditions zone-reversion trading in general**; it is not
a property the IPO anchor or FVG creates. On BTC, LOW_VOL destroys every arm
alike (baseline -1.066, A1 -0.966, random+FVG -0.944).

### Caveat 3 — THE IPO ANCHOR LOST ITS EDGE ON EUR/USD

Unrestricted expectancy, A1 vs random+FVG:

| bucket | EUR/USD A1 | EUR/USD random+FVG | BTC A1 | BTC rand+FVG | JPY A1 | JPY rand+FVG |
|---|---|---|---|---|---|---|
| HIGH_VOL | +0.721 | **+0.836** | +0.319 | +0.221 | +0.904 | +0.681 |
| MID_VOL | +0.658 | **+0.806** | -0.055 | -0.514 | +0.766 | +0.454 |
| LOW_VOL | +0.411 | **+0.601** | -0.966 | -0.944 | +0.511 | +0.560 |

**On EUR/USD, random anchors beat the IPO anchor in every bucket.** A1 wins
clearly on BTC and USD/JPY. This contradicts section 13, where A1 (+0.321) beat
random+FVG (-0.012) pooled. The IPO anchor's marginal value is therefore
INCONSISTENT ACROSS INSTRUMENTS AND DATE RANGES — the most serious evidence
against the IPO concept produced so far, and it came from a run designed to test
something else.

### Status

The volatility hypothesis is validated as specified and is frozen as a finding,
not implemented as a filter. Three things are now established and should be
carried together, because the first is easy to celebrate without the other two:

1. Volatility state materially conditions A1, monotonically, on all three
   instruments, and it is what makes BTC tradable at all (+0.319 / +0.504).
2. That conditioning is general to zone reversion, not IPO-specific.
3. The IPO anchor itself does not reliably beat a random anchor with the same
   geometry and the same FVG filter.

---

## 16. IPO_ALPHA — does the anchor add value beyond FVG + volatility? (2026-09-21)

`IPO_ALPHA = expectancy(A1) - expectancy(random_anchor + FVG)`, compared strictly
within instrument x volatility bucket. Nothing was modified: A1, lifecycle, FVG
logic, volatility descriptor, entry, stop, target, costs and the random-anchor
construction are all frozen. **Production changed: NO.** No repo file changed.

Two analysis choices, neither a construction change: the control was drawn with
**5 replicates** to cut sampling noise, and a **direction-matched** alpha is
reported beside the raw one (the frozen control draws 50/50 while the lifecycle
does not).

### Pre-registered before fetching

"Consistently positive" required ALL of: positive on all 3 instruments; positive
in >= 7 of 9 cells; positive on all 3 instruments under BOTH execution models;
A1 ahead in > 50% of independent episodes on EACH instrument.

Windows (12, four years, none used before): BTC/USD 1H and EUR/USD 1H
2021-09..11, 2023-02..04, 2024-11..2025-01, 2026-01..03; USD/JPY 30M 2021-09..11,
2023-02..04, 2024-09..11, 2026-01..03. 18,649 bars. 2 corrupt BTC bars caught and
dropped by the median-band check.

### VERDICT: **CONSISTENTLY POSITIVE — all four clauses passed**

IPO_ALPHA, unrestricted (direction-matched in brackets):

| bucket | BTC/USD | EUR/USD | USD/JPY |
|---|---|---|---|
| HIGH_VOL | +0.200 (0.235) | +0.152 (0.166) | +0.205 (0.208) |
| MID_VOL | +0.056 (0.047) | +0.046 (0.040) | +0.258 (0.244) |
| LOW_VOL | +0.112 (0.104) | +0.239 (0.241) | +0.300 (0.302) |
| **all buckets** | **+0.203** | **+0.150** | **+0.275** |

Positive in **9 of 9 cells**. Pooled (secondary) +0.237.

One-trade-at-a-time, per cell: BTC +0.296 / +0.297 / +0.359; EUR +0.174 / +0.100 /
+0.101; JPY +0.236 / +0.174 / +0.404. **Positive in 9 of 9 again.**

### Episode-level (one observation per volatility episode)

| instrument | episodes | usable | mean | median | % A1 ahead |
|---|---|---|---|---|---|
| BTC/USD | 501 | 313 | +0.256 | +0.253 | 60.4% |
| EUR/USD | 357 | 220 | +0.146 | +0.284 | 60.5% |
| USD/JPY | 530 | 379 | +0.198 | +0.252 | 61.2% |

Per bucket the episode win rate ranges 54.4% - 71.1%; every one is above 50%.

### CORRECTION to section 15

Section 15 reported that random+FVG beat A1 in every EUR/USD bucket. That used a
**single** random draw. Re-running the identical windows with 5 replicates:

| EUR/USD, prior windows | HIGH | MID | LOW | all |
|---|---|---|---|---|
| IPO_ALPHA, 1 draw (as reported in 15) | -0.115 | -0.148 | -0.190 | ~-0.15 |
| IPO_ALPHA, 5 draws | +0.036 | +0.031 | -0.042 | **-0.001** |

**The reversal was sampling noise in the control, not a real effect.** The honest
figure for those windows is ~zero alpha on EUR/USD, not negative. BTC +0.192 and
USD/JPY +0.162 on the same re-run, consistent with section 15's direction.

Across both window sets and all three instruments (six instrument x window-set
observations), alpha is clearly positive in five and ~zero in one.

### Caveats

- **The sequenced "ALL BUCKETS" rows are a composition artefact and should be
  ignored** (BTC +0.016, EUR +0.411, JPY +0.089). After sequencing, the two arms
  hold different bucket mixes, so the aggregate is not like-for-like. Every
  sequenced *cell* is positive; those are the valid comparisons.
- **Alpha is NOT concentrated in HIGH_VOL.** It is strongest in LOW_VOL on two of
  three instruments. Anchor value and volatility conditioning appear to be
  separable effects rather than an interaction.
- **Magnitude is modest**: +0.15 to +0.28R. It does not rescue BTC, which remains
  -0.144R overall on these windows even with the anchor's contribution.
- Episode win rate is ~60%, not overwhelming.

---

## 17. FINAL PROFITABILITY CANDIDATE — **PASSED** (2026-09-21)

Candidate, frozen before fetching: EUR/USD 1H and USD/JPY 30M trade A1 in all
volatility states; BTC/USD 1H trades A1 **only in HIGH_VOL**. One position per
instrument at a time, E2_50_PERCENT / S2_CLOSE_INVALIDATION / T_2R, frozen costs.
No A2, no SR / trend / fib / touch-number filter, no new confluence. Nothing was
modified. **Production changed: NO.** No repo file changed.

### Pre-registered pass condition (exactly the five specified, all binding)

EUR/USD expR > 0; USD/JPY expR > 0; BTC HIGH_VOL expR > 0; portfolio expR > 0;
portfolio PF > 1.

### Data — 15 windows, five separated periods, five different years, all untouched

2021-11..2022-01, 2022-10..12, 2023-06..08, 2025-10..12, 2026-04..06 for each of
the three instruments. 24,101 bars. Verified against every prior window set,
including the 2020-06..08 detector-research files.

**Data repair.** BTC 2023-06..08 contained 64 bars (4.6%) with the same
decimal-shift glitch seen in section 13 (`low` = price / 10000). Both treatments
were run. Dropping the bars is PRIMARY: the repair
(`low = min(open, close)`) leaves corrupted zone geometry, producing a window
with avg MAE 35.1R and max 488R against ~1.2R in every other window. Under the
drop treatment that window is in line with the rest. **The verdict is identical
either way** (portfolio expR 0.689 vs 0.685, PF 2.32 vs 2.31).

### Result

| instrument | n | win% | expR | PF | totalR | maxDD | streak | MAE | t/mo |
|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 678 | 77.0 | **+0.793** | 2.68 | +537.9 | 15.0 | 5 | 1.26 | 68.1 |
| USD/JPY | 1151 | 76.2 | **+0.726** | 2.36 | +835.4 | 17.8 | 5 | 1.40 | 115.6 |
| BTC/USD HIGH_VOL | 287 | 76.0 | **+0.297** | 1.50 | +85.3 | 13.3 | 3 | 1.25 | 28.6 |
| **PORTFOLIO** | **2116** | **76.4** | **+0.689** | **2.32** | **+1458.6** | **20.7** | **6** | 1.34 | — |

Max simultaneous portfolio positions: **3** (the cap, as designed).

| | |
|---|---|
| profitable months | **12 / 12** |
| best month | +181.2R |
| worst month | +1.4R |

Two months (2023-08, 2025-12) hold a single spill-over trade each from a window
boundary; the ten substantive months run +77.9R to +181.2R.

### Per-clause verdict

| clause | value | result |
|---|---|---|
| EUR/USD expectancy > 0 | +0.793 | PASS |
| USD/JPY expectancy > 0 | +0.726 | PASS |
| BTC HIGH_VOL expectancy > 0 | +0.297 | PASS |
| portfolio expectancy > 0 | +0.689 | PASS |
| portfolio PF > 1 | 2.32 | PASS |

**OVERALL: PASS.** Nothing was repaired, retuned or re-run against this dataset
after the result was seen.

### Forward-trading caveats, all pre-existing and none resolved here

- **BTC eligibility must be knowable in real time.** Under the strictly causal
  expanding-window thirds instead of the frozen full-window reference, the BTC
  subset is n=217 with expR **+0.46**, PF 1.99 — better, not worse, but a
  DIFFERENT trade set. The causal variant is the one a live system would trade.
- **S2 permits unbounded adverse excursion.** Portfolio avg MAE 1.34R means the
  typical trade travels further against the position than its nominal stop.
  "maxDD 20.7R" is in nominal R units that understate true exposure (section 10).
- **Frequency is high**: ~177 portfolio trades/month, up to 3 concurrent. Every
  fill is assumed at an exact limit price on a 30m/1h bar.
- Twelve months of data across five windows is not twelve months of independent
  market history.

---

## 18. Forward-trading preparation, phases 1-5 (2026-09-21)

Research is closed. Live spec: **`docs/IPO_FORWARD_TRADING_SPEC.md`**.
Two modules added, no frozen rule modified: `ipoLiveVolatility.ts` (8 tests) and
`ipoForwardLedger.ts` (14 tests). Suite 2571 passed, 0 failed.

### Phase 1 — causal volatility

Only the percentile REFERENCE changed, from the full window set to
strictly-earlier bars. Measure, thirds and ATR period untouched; a test asserts
the module contains no decimal literal and re-declares nothing.

Trade-set delta on the section-17 windows: **82 added, 85 removed, 2,031
unchanged.** EUR/USD and USD/JPY are unaffected (not volatility-gated). BTC goes
287 -> 284 trades, expectancy +0.297 -> +0.296. Portfolio +0.689 -> **+0.690**,
PF 2.32 -> 2.33. **The candidate survives the causality fix intact.**

`UNCLASSIFIED` (warmup, < 200 observations) is explicitly NOT eligible.

### Phase 2 — real risk of S2

Median losing trade is **1.75R**, not 1R. **97.2% of losers exceed 1R**, 37.6%
exceed 2R, 3.8% exceed 5R; worst observed 17.33R (USD/JPY). Average MAE 1.34R.
Full tables in the spec, §8. S2 unchanged, as instructed.

### Phase 3 — execution realism

Assumptions declared before running. Portfolio expectancy: ideal +0.690,
spread-aware +0.657, with exit slippage **+0.622**, through-fill +0.660. About
92% of ideal fills survive a spread-aware test. BTC is the most fragile
(+0.296 -> +0.176 under slippage, PF 1.25). **Degradation is modest and the
candidate stays clearly positive under the harshest model tested.**

### Phase 4 — event ledger

16,169 rows generated from the validation windows; `auditLedger()` returns **0
problems**. 2,110 filled / 14,059 not. No-fill reasons: 7,869 position already
open, 3,468 volatility not eligible, 2,720 price never reached the 50% level.

**The audit found a real economic defect while building it.** 32 trades reach the
2R target and still finish net negative: BTC fees are proportional to price while
1R is the candle's wick span. Cost in R terms — BTC median **0.72R**, p90 1.64R,
with **74.6%** of BTC trades costing more than 0.5R and 4.9% costing more than
the entire 2R target. EUR/USD and USD/JPY are far healthier (median 0.27-0.29R).
A minimum risk-to-cost rule would fix it; that is a NEW FILTER and was NOT added.
Recorded as a required pre-live decision in the spec, §8.

### Phase 5 — frozen live specification

`IPO_FORWARD_TRADING_SPEC.md` v1.0: instruments, signal, causal volatility,
entry, stop, target, position management, risk reality, execution assumptions,
ledger schema, expected baseline, standing prohibitions, and six open items.

---

## 19. Live-equivalence engine — the backtest is 43% non-causal (2026-09-21)

`ipoLiveEngine.ts` + 12 tests, on `feature/ipo-live-integration`.

**Design: the engine re-implements no rule.** It re-runs the FROZEN functions
over a growing prefix and acts on what they say about the newest bar. Two copies
of a rule drift; one copy cannot. Causality is structural — `feed()` appends one
closed bar and nothing downstream can see a later bar because none exists yet.

### The finding

Replaying all 15 final-validation windows bar by bar:

| instrument | live n | live R | **live expR** | batch n | batch R | batch expR | kept | delta |
|---|---|---|---|---|---|---|---|---|
| EUR/USD | 368 | +294.7 | **+0.801** | 678 | +537.9 | +0.793 | 54.3% | +0.007 |
| USD/JPY | 595 | +346.5 | **+0.582** | 1151 | +835.5 | +0.726 | 51.7% | **-0.144** |
| BTC/USD | 146 | +45.2 | **+0.310** | 284 | +84.0 | +0.296 | 51.4% | +0.014 |
| **PORTFOLIO** | **1109** | **+686.4** | **+0.619** | 2113 | +1457.4 | +0.690 | **52.5%** | -0.071 |

**A live system reproduces only 52.5% of the backtested trades.** Expectancy
per trade survives almost intact on EUR/USD and BTC and degrades on USD/JPY.
All three stay positive. Zero value-mismatches: on every trade both paths take,
they agree on realized R to 1e-9.

### Cause — isolated, single, and in the frozen rules

Diagnostic over EUR/USD window 1 (142 batch trades): for each trade, the first
prefix length at which the frozen pipeline reveals it.

- known in time (live could have taken it): **81**
- **only known AFTER its own entry bar: 61 (43%)**
- never revealed by any prefix: **0**
- lateness: median 3 bars, **maximum exactly 10**

Maximum lateness of exactly 10 identifies the cause precisely: `runLifecycle`
computes `hasFvg` by scanning `[candidateIndex, candidateIndex + 10]`. When a
touch occurs within 10 bars of the IPO candle — 77 of 142 here — **the backtest
admitted the trade on an FVG that had not formed yet.**

The rules themselves are sound (0 never-revealed). This is purely a timing
defect in how the backtest was evaluated, not a broken rule. The remaining
divergence (live-only trades) is cascade: having skipped an earlier trade, the
live engine's position-occupancy timeline differs, so it takes different later
trades.

### Two bugs the equivalence harness caught in the engine itself

Both were in the new code, not the frozen rules, and both are fixed:

1. **Cost priced off the exit bar** instead of fixed at entry. Invisible on FX
   (constant spread); on BTC's price-proportional fee it produced 8-21 value
   mismatches per window. Now fixed at entry, matching `simulate`. Mismatches: 0.
2. **Same-bar re-entry allowed.** The frozen `sequential()` requires
   `touchIndex > previousExitIndex`; the engine let a new position open on the
   bar the previous one closed. Also an unsupported intrabar-ordering assumption.
   Now refused.

### Status

Not a reason to change any rule — research is closed. It IS a reason to treat
**+0.619R, 1,109 trades** as the forward expectation rather than the +0.690 /
2,113 in section 17 and the spec's §11 baseline.

---

**Production changed: NO** for all research phases; phase 18 added two observability/causality modules only — at every step of this programme.
