# IPO-CET-v2 Experiment 2 — SMC direction verdict and HTF structure as IPO context

**Research only. No production behaviour changed: no SMC rule, no IPO rule, no
schema, no cron, no deployment, no database write, no live flag, no UI default.**
Branch `research/ipo-v2-smc-context`. Dated 2026-09-24.

---

## 1. Verdict

```
NO_CONTEXT_EDGE
```

Neither existing SMC feature improves IPO selection as an **alignment** filter.

| true filtered replay | n | ret% | win% | BE% | gap | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| **FILTER_0_BASELINE** | 957 | 100 | 61.4 | 58.2 | +3.2 | **+0.125** | **1.14** | **+119.7** | **46.7** |
| FILTER_1_DIRECTION_ONLY | 510 | 53 | 63.3 | 59.0 | +4.4 | +0.168 | 1.20 | +85.8 | 52.9 |
| FILTER_2_HTF_STRUCTURE_ONLY | 324 | 34 | 60.2 | 60.8 | −0.6 | −0.024 | 0.98 | −7.7 | 42.2 |
| FILTER_3_BOTH_ALIGNED | 207 | 22 | 59.4 | 61.5 | −2.0 | −0.087 | 0.92 | −18.0 | 50.5 |
| FILTER_4_EITHER_ALIGNED | 610 | 64 | 63.0 | 59.1 | +3.8 | +0.149 | 1.17 | +90.7 | 48.3 |

Requiring **HTF structure agreement makes the strategy worse** and requiring
**both** is worst of all. Requiring **direction agreement** lifts expectancy by
+0.043R — but it costs 47% of the trades, **increases** max drawdown 46.7R →
52.9R, and §14/§16 show the whole of that profit is one instrument in one window.

**The one genuine separation runs the other way** (§15). HTF structure carries
information with the sign inverted: IPO setups that **oppose** the daily
structure earn **+0.262R** against **+0.007R** for aligned ones. Reported, not
adopted — see §17 and §19.

---

## 2. The question

The IPO engine is direction-aware per setup — demand → long, supply → short —
but never asks whether the broader market agrees. SMC already computes two such
opinions on every scan. Do they separate stronger IPO setups from weaker ones?

Nothing was designed for this experiment. No new trend system, no new
timeframe, no new threshold, no scoring weights, no sweeps.

---

## 3. The two existing features, located in the live source

| feature | source module | source function | possible values | timeframe | causal at IPO time? | reconstructable? | notes |
|---|---|---|---|---|---|---|---|
| **SMC direction verdict** | `_shared/directionVerdict.ts` | `computeDirectionVerdict()` | `long` / `short` / `neutral`, plus `confidence` 0-100 and `shouldBlock` | composite (below) | yes | yes | Gate 1 in bot-scanner: "Direction OK" / "Direction CONFLICT" |
| **HTF structure** | `_shared/smcAnalysis.ts` | `analyzeMarketStructure(dailyCandles).trend` | `bullish` / `bearish` / `ranging` | Daily | yes | yes | called `htfStructure` / `htfTrend` at `bot-scanner/index.ts:1412`; legacy Gate 1 |

### The verdict's own inputs, as bot-scanner feeds them

| input | source | timeframe | causally reconstructable |
|---|---|---|---|
| `simpleDirection` (the spine) | `directionEngine.determineDirection()` | Daily bias → 4H structure → 1H confirm | yes |
| `confirmedTrend` (context) | `directionEngine.confirmedTrend()`, fib 0.25, swing 5 | the style's bias TF = Daily | yes |
| `regime` (context) | `smcAnalysis.classifyInstrumentRegime()` | Daily | yes |
| `weeklyBias` (context) | `weeklyBiasDOL.analyzeWeeklyBiasAndDOL()` | Weekly | yes |
| `gamePlanBias` (advisory) | `gamePlan.ts`, **LLM premarket output** | daily, generated live | **NO** — see §5 |

The spine decides direction; context can only move confidence; Game Plan is
advisory and can never flip the verdict. `analyzeMarketStructure` derives `trend`
by walking BOS/CHoCH events chronologically, so **yes, BOS/CHoCH is involved** in
the HTF structure value.

All nine of these source claims are asserted in the runner against the live file
text before any number is produced; the run aborts if the source has moved.

---

## 4. Timeframe mapping — SMC has one, and it is not per-instrument

The brief asked what "higher timeframe" means for EUR/USD 1h, USD/JPY 30min and
BTC/USD 1h. **In SMC it means the same thing for all three**, because the mapping
is keyed on trading STYLE, not on instrument or on the strategy's own timeframe:

```
STYLE_TF_LABELS = {
  scalper:      bias 1H,     structure 15m,   confirm 5m
  day_trader:   bias Daily,  structure 4H,    confirm 1H
  swing_trader: bias Weekly, structure Daily, confirm 4H
}
bot-scanner/index.ts:2314   const resolvedStyle = config.tradingStyle?.mode || "day_trader"
```

`resolveStyleMode` and `configMapper`'s RUNTIME_DEFAULTS both default to
`day_trader`, so the reconstruction uses **bias Daily / structure 4H / confirm
1H** for every instrument. The IPO setup timeframes (1h, 30min) play no part —
SMC never consults them. This is reuse of a defined mapping, not a chosen one.

**Series depth is part of the mapping and is not cosmetic.** `confirmedTrend` and
`analyzeMarketStructure` read the whole array they are handed, so a deeper series
gives a different trend. The reconstruction slices to exactly what bot-scanner
fetches:

```
CANDLE_LIMITS = { "4h": 800 }   DEFAULT_CANDLE_LIMIT = 300   LEGACY_H4_WINDOW = 300
daily 300 · 4H 300 (legacy slice) · 1H 300 · weekly 300
```

---

## 5. Causal availability audit

**Decision instant: the IPO entry bar's OPEN.** Only SMC candles that had *fully
closed* at or before that instant are visible. Nothing from the entry bar itself
is read — not even its close — so no context value can be informed by the price
action that produced the fill.

| | |
|---|---|
| population | 1,021 |
| context available | **1,021 (100%)** |
| `CONTEXT_UNAVAILABLE` | **0** |
| depths actually used | daily 300 · weekly 300 · 4H 300 · 1H 300 |
| distinct SMC states computed | 1,721 |

This is **stricter than production**, which sees an in-progress daily bar at scan
time. The reconstruction is deliberately one bar behind.

**One input could not be reconstructed: `gamePlanBias`.** It is an LLM premarket
output generated on the day and never stored for 2021–2026. It is passed as
`null`. Its bound is known exactly from the source: it contributes
`±5 × confidence/100` to confidence and **cannot flip direction**, so its absence
can move confidence by at most 5 points and can never change a BULLISH into a
BEARISH. That is a real but bounded gap, recorded here rather than papered over.

---

## 6. Baseline and population

The Experiment 1 **reconstructed HTF control** — the causally-corrected v1
population with the target detected on the 1-minute tape — as the brief
specified.

```
population 1,021 · resolved 957 · TICK_REQUIRED 63 · STILL_OPEN 1
BTC 2023-06..08 (p3-BTCUSD) excluded, as in every stage since Stage 3
```

Baseline: **957 trades, 61.4% win, BE 58.2%, +0.125R, PF 1.14, +119.7R, maxDD
46.7R** — reproduced exactly from Experiment 1, which validates the pipeline
before any filter is applied. The 64 unresolved are excluded identically from
every cohort, so no comparison is affected.

---

## 7. Fixed-population cohorts

Same trades, same outcomes, grouped by tag. No sequencing change.

| cohort | n | ret% | win% | BE% | gap | avgW | avgL | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A BASELINE** | 957 | 100 | 61.4 | 58.2 | +3.2 | 1.63 | −2.27 | **+0.125** | 1.14 | +119.7 | 46.7 |
| B DIRECTION_ALIGNED | 467 | 49 | 62.5 | 58.6 | +4.0 | 1.61 | −2.28 | +0.154 | 1.18 | +71.8 | 50.9 |
| C DIRECTION_OPPOSED | 490 | 51 | 60.4 | 57.9 | +2.5 | 1.64 | −2.26 | +0.098 | 1.11 | +48.0 | 28.1 |
| D HTF_STRUCTURE_ALIGNED | 298 | 31 | 60.1 | 59.9 | +0.2 | 1.64 | −2.45 | **+0.007** | 1.01 | +1.9 | 35.9 |
| E HTF_STRUCTURE_OPPOSED | 255 | 27 | 64.3 | 57.4 | +6.9 | 1.61 | −2.17 | **+0.262** | 1.34 | +66.8 | 29.5 |
| F BOTH_ALIGNED | 186 | 19 | 59.1 | 60.2 | −1.1 | 1.63 | −2.47 | **−0.043** | 0.96 | −8.1 | 50.2 |
| G DIRECTION_ONLY_ALIGNED | 281 | 29 | 64.8 | 57.1 | +7.6 | 1.60 | −2.13 | +0.284 | 1.38 | +79.8 | 39.9 |
| H HTF_ONLY_ALIGNED | 112 | 12 | 61.6 | 59.4 | +2.2 | 1.65 | −2.41 | +0.089 | 1.10 | +10.0 | 20.2 |
| I BOTH_OPPOSED | 172 | 18 | 66.3 | 55.6 | +10.7 | 1.65 | −2.06 | **+0.397** | 1.57 | +68.2 | 15.8 |
| J ANY_NEUTRAL_OR_UNKNOWN | 404 | 42 | 60.6 | 57.3 | +3.3 | 1.63 | −2.19 | +0.126 | 1.15 | +51.0 | 51.2 |

Cohort J is entirely HTF `ranging`; the direction verdict is never neutral on
this corpus (§13). Both tags partition the population exactly — asserted in the
runner, 467+490 = 298+404+255 = 957, no duplicate trade ids.

The ordering is already legible here: **D < A < E** and **F < A < I**. Alignment
is the losing side of both features.

---

## 8. Cross-table — are the two features redundant?

Cell = n / expectancy R, over the 957 resolved.

| | HTF BULLISH | HTF BEARISH | HTF NEUTRAL | row total |
|---|---|---|---|---|
| **SMC BULLISH** | 246 / +0.10 | 126 / +0.07 | 238 / +0.11 | 610 |
| **SMC BEARISH** | 69 / −0.01 | 112 / +0.32 | 166 / +0.15 | 347 |
| **SMC NEUTRAL** | 0 | 0 | 0 | 0 |

They are **not** redundant — SMC BULLISH occurs against HTF BEARISH 126 times and
SMC BEARISH against HTF BULLISH 69 times — but they are not independent either:
the verdict's spine, its `confirmedTrend` context and its regime context are all
computed on the same daily series that produces the HTF structure value.

Split by IPO direction, where the inversion is visible:

| | HTF BULL | HTF BEAR | HTF NEUT |
|---|---|---|---|
| LONG, SMC BULL | 137 / **−0.16** | 53 / +0.05 | 118 / +0.32 |
| LONG, SMC BEAR | 39 / +0.08 | 63 / **+0.35** | 86 / −0.21 |
| SHORT, SMC BULL | 109 / **+0.43** | 73 / +0.09 | 120 / −0.10 |
| SHORT, SMC BEAR | 30 / −0.14 | 49 / **+0.29** | 80 / +0.55 |

The two best-populated fully-aligned cells — LONG into bullish structure (137,
−0.16) and SHORT into bearish structure (49, +0.29) — do not agree with each
other, while the two clean counter-structure cells (LONG/HTF BEAR 63, +0.35;
SHORT/HTF BULL 109, +0.43) both do well.

---

## 9. True filtered replay — method

Analysis 1 filters a fixed list. Analysis 2 has to re-run the engine, because a
refused IPO leaves the one-position-per-instrument slot free and a later IPO the
baseline never saw becomes eligible.

Re-running `ipoLiveEngine.replay` per filter costs ~46 min each, because the
engine re-runs the frozen lifecycle over a growing prefix on every bar. That
computation depends only on the prefix — not on whether a position is open, and
not on any filter — so it was done **once**, for **every** bar, into a candidate
table (63.7 min, no API). The sequencer then replays any filter from the table in
milliseconds.

**The sequencer is validated, not asserted.** With the gate wired permanently
open it reproduces `ipoLiveEngine.replay()` **field-for-field on all 1,042 trades
across all 15 windows** — entry index, exit index, ipo index, direction,
volatility bucket, entry, stop, target, risk, costR and realised R. Every rule it
uses is imported from the frozen modules; the one thing it adds is the gate, and
a gate refusal does not consume the slot.

Outcomes come from the 1-minute tape under the Experiment 1 control semantics.
The exit **bar** is the same under HTF and 1m resolution — if a minute inside bar
*j* reaches target then bar *j*'s high reaches it too, and an S2 close is a bar
event either way — so 1m resolution changes the outcome, never the bar that frees
the slot. Sequencing is therefore unaffected.

### Accounting

| variant | taken | refused | resolved | freed-slot admissions | baseline dropped | unresolved |
|---|---|---|---|---|---|---|
| FILTER_0_BASELINE | 1,021 | 0 | 957 | **0** | **0** | TICK_REQUIRED 63, STILL_OPEN 1 |
| FILTER_1_DIRECTION_ONLY | 545 | 889 | 510 | 47 | 523 | TICK_REQUIRED 35 |
| FILTER_2_HTF_STRUCTURE_ONLY | 348 | 1,339 | 324 | 28 | 701 | TICK_REQUIRED 24 |
| FILTER_3_BOTH_ALIGNED | 223 | 1,571 | 207 | 22 | 820 | TICK_REQUIRED 16 |
| FILTER_4_EITHER_ALIGNED | 652 | 680 | 610 | 35 | 404 | TICK_REQUIRED 42 |

`taken + refused = candidate population` and `resolved + unresolved = taken` are
asserted per variant and pass. FILTER_0 reproducing the baseline population with
**0 new and 0 dropped** is the second validation of the harness.

**132 freed-slot admissions in total** — the entire difference between
FIXED_POPULATION and TRUE_FILTERED_REPLAY. They matter: FILTER_1 goes from 467
resolved (fixed) to 510 (true), and the 47 extra trades move expectancy from
+0.154 to +0.168.

---

## 10. Direction-only result

| | fixed | true replay |
|---|---|---|
| n | 467 | 510 |
| expR | +0.154 | **+0.168** |
| PF | 1.18 | 1.20 |
| total R | +71.8 | +85.8 |
| maxDD | 50.9 | **52.9** |
| retained | 49% | 53% |

Against a baseline of +0.125R / PF 1.14 / +119.7R / maxDD 46.7R.

**+0.043R per trade, for 47% fewer trades, 34R less profit and 6R more
drawdown.** The brief's own standard — "treat +0.02R improvements as noise unless
very consistent" — is barely cleared on expectancy and failed on drawdown. §14
and §16 then remove what is left.

---

## 11. HTF-structure-only result

| | fixed | true replay |
|---|---|---|
| n | 298 | 324 |
| expR | **+0.007** | **−0.024** |
| PF | 1.01 | 0.98 |
| total R | +1.9 | −7.7 |
| maxDD | 35.9 | 42.2 |

Requiring the IPO to agree with daily structure takes a +0.125R strategy to zero
and, once freed slots are admitted, slightly below it. Drawdown improves versus
baseline in the fixed population only.

---

## 12. Both-aligned result

| | fixed | true replay |
|---|---|---|
| n | 186 | 207 |
| expR | **−0.043** | **−0.087** |
| PF | 0.96 | 0.92 |
| total R | −8.1 | −18.0 |
| maxDD | 50.2 | 50.5 |

The most selective filter is the worst performer, keeps 22% of the trades and
does not improve drawdown. `FILTER_4_EITHER_ALIGNED` (+0.149R, PF 1.17) lands
between direction-only and baseline and adds nothing either.

---

## 13. Per instrument

True filtered replay. No instrument is hidden.

| | filter | n | win% | BE% | gap | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| **EUR/USD** | baseline | 323 | 62.5 | 54.6 | +7.9 | +0.291 | 1.39 | +94.0 | 20.7 |
| | direction | 176 | 64.2 | 52.7 | +11.6 | **+0.411** | 1.61 | +72.3 | 20.2 |
| | HTF | 97 | 58.8 | 53.4 | +5.4 | +0.190 | 1.25 | +18.4 | 17.9 |
| | both | 67 | 58.2 | 52.6 | +5.6 | +0.194 | 1.26 | +13.0 | 17.9 |
| **USD/JPY** | baseline | 515 | 60.4 | 57.7 | +2.7 | +0.106 | 1.12 | +54.6 | 39.2 |
| | direction | 265 | 63.0 | 60.0 | +3.0 | +0.122 | 1.14 | +32.4 | 33.4 |
| | HTF | 184 | 60.9 | 62.6 | −1.8 | −0.081 | 0.93 | −14.9 | 38.9 |
| | both | 111 | 60.4 | 65.0 | −4.7 | **−0.230** | 0.82 | −25.5 | 37.8 |
| **BTC/USD** | baseline | 119 | 63.0 | 69.0 | −6.0 | −0.242 | 0.76 | −28.8 | 39.2 |
| | direction | 69 | 62.3 | 69.3 | −7.0 | −0.275 | 0.73 | −19.0 | 36.7 |
| | HTF | 43 | 60.5 | 66.9 | −6.4 | −0.262 | 0.76 | −11.3 | 22.8 |
| | both | 29 | 58.6 | 63.8 | −5.2 | −0.189 | 0.80 | −5.5 | 17.1 |

Direction-only helps EUR/USD materially (+0.291 → +0.411) and almost nothing on
USD/JPY (+0.106 → +0.122). **No filter makes BTC positive**; every variant leaves
it below −0.18R with a break-even requirement above 63%. HTF-only and both-aligned
make USD/JPY negative.

---

## 14. Long versus short

True filtered replay.

| filter | side | n | win% | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|
| baseline | LONG | 496 | 60.7 | +0.050 | 1.05 | +24.9 | 62.6 |
| | SHORT | 461 | 62.3 | +0.206 | 1.26 | +94.9 | 26.8 |
| direction | LONG | 333 | 61.6 | +0.079 | 1.09 | +26.4 | 53.8 |
| | SHORT | 177 | 66.7 | **+0.335** | 1.51 | +59.4 | 26.5 |
| HTF | LONG | 192 | 58.3 | **−0.162** | 0.86 | −31.1 | 55.6 |
| | SHORT | 132 | 62.9 | +0.177 | 1.22 | +23.3 | 23.3 |
| both | LONG | 153 | 57.5 | **−0.225** | 0.81 | −34.4 | 55.6 |
| | SHORT | 54 | 64.8 | +0.303 | 1.43 | +16.4 | 8.9 |

The asymmetry earlier IPO research suspected is confirmed and it is **large**:
SHORT is the whole book at baseline (+0.206 vs +0.050), and every filter widens
the gap rather than closing it. Structural alignment is actively harmful on the
LONG side — requiring a demand IPO to agree with bullish daily structure produces
−0.162R over 192 trades.

---

## 15. The one real separation, and it is inverted

This is the finding the experiment actually produced.

| comparison | n aligned | n opposed | Δ win% | **Δ expR** | Δ PF | Δ avgLoss | Δ maxDD |
|---|---|---|---|---|---|---|---|
| direction ALIGNED − OPPOSED | 467 | 490 | +2.1 | **+0.056** | +0.07 | −0.02 | +22.8 |
| HTF ALIGNED − OPPOSED | 298 | 255 | −4.2 | **−0.255** | −0.33 | −0.28 | +6.4 |
| BOTH ALIGNED − BOTH OPPOSED | 186 | 172 | −7.1 | **−0.440** | −0.61 | −0.41 | +34.4 |

HTF structure is **informative**. It simply has the sign the hypothesis assumed
backwards: IPO setups that trade *against* the daily structure outperform those
that trade with it, by a quarter of an R.

And unlike the direction result, it survives being broken apart:

**HTF_STRUCTURE_OPPOSED** — +0.262R, PF 1.34, 255 trades

| | opposed | aligned | delta |
|---|---|---|---|
| EUR/USD | +0.673 (n=89) | +0.230 (n=87) | **+0.443** |
| USD/JPY | +0.151 (n=129) | −0.022 (n=170) | **+0.174** |
| BTC/USD | −0.344 (n=37) | −0.348 (n=41) | +0.005 |

by window: p1 +0.20 · p2 −0.09 · p3 +0.58 · p4 +0.22 · p5 +0.52 → **opposed
better in 4 of 5 windows**

**BOTH_OPPOSED** — +0.397R, PF 1.57, 172 trades, maxDD **15.8R** (the lowest of
any cohort in this report)

| | opposed | aligned | delta |
|---|---|---|---|
| EUR/USD | +0.667 (n=66) | +0.191 (n=58) | +0.476 |
| USD/JPY | +0.221 (n=87) | −0.106 (n=101) | +0.326 |
| BTC/USD | +0.263 (n=19) | −0.314 (n=27) | +0.578 |

by window: p1 −0.20 · p2 +0.72 · p3 +0.54 · p4 +0.01 · p5 +1.35 → **opposed
better in 4 of 5 windows**, and positive on all three instruments including BTC.

Concentration: BOTH_OPPOSED's best subgroup by profit share is EUR/USD SHORT at
10% of n and 34% of profit — no subgroup clears the flag, and its best single
window is 42% of n for 30% of profit. It is the least concentrated positive
result anywhere in this experiment.

Why it is coherent rather than surprising: **IPO is a reversion strategy.** It
buys a demand zone at a discount and sells a supply zone at a premium. Reaching
those zones *requires* the move that flips the daily read against the setup.
Demanding structural agreement is demanding that the pullback which creates the
entry has not happened.

---

## 16. Interaction, and the reason none of it can be trusted yet

```
baseline            +0.125  (n=957, PF 1.14)
direction only      +0.154  (n=467, PF 1.18)
HTF structure only  +0.007  (n=298, PF 1.01)
both aligned        −0.043  (n=186, PF 0.96)

both minus best single feature: −0.197R  ->  WORSE THAN EITHER ALONE
```

Combining is not complementary and not even redundant; it is destructive,
because the two features fail in opposite directions.

### The measurement that undercuts the direction feature

| window-instrument | n decisions | SMC direction states | verdict flips | HTF flips |
|---|---|---|---|---|
| p1-EURUSD | 69 | BEARISH ×69 | **0** | 4 |
| p2-USDJPY | 92 | BULLISH ×92 | **0** | 4 |
| p3-EURUSD | 44 | BULLISH ×44 | **0** | 3 |
| p3-USDJPY | 114 | BULLISH ×114 | **0** | 4 |
| p4-USDJPY | 119 | BULL 96 / BEAR 23 | 1 | 1 |
| p4-EURUSD | 91 | BEAR 78 / BULL 13 | 1 | 3 |
| p1-USDJPY | 107 | BULL 73 / BEAR 34 | 2 | 9 |
| p5-EURUSD | 93 | BULL 49 / BEAR 44 | 2 | 9 |
| *(remaining 6)* | | | 0–2 | 1–6 |

**The verdict flips at most twice in a two-month window, and in four of fourteen
window-instruments it never flips at all.** "Direction aligned" is therefore
close to a relabelling of *"this window's constant SMC direction happens to match
the IPO side"*. Its effective sample size is nearer **14 window-instrument
observations than 467 trades**.

That is exactly what the concentration check finds:

| FILTER_1_DIRECTION_ONLY, +71.8R over 467 trades | share of n | share of profit |
|---|---|---|
| EUR/USD | 34% | **97%** |
| window p1 | 23% | **103%** |
| EUR/USD SHORT | 24% | **91%** |
| SHORT | 34% | 75% |

One instrument, one direction, one window. Everything else nets to approximately
zero. The formal flag (<20% of n for >50% of profit) does not fire only because
the subgroups sit just above 20% of n — the result is concentrated regardless,
and saying otherwise would be hiding behind a threshold.

The HTF feature moves more (1–9 flips per window) which is why §15's separation
holds up better, but it is slow too and the same caution applies with less force.

Also worth recording: **the direction verdict is never neutral** — 0 of 1,021
decisions — and `shouldBlock` fires at 125 of 1,021. Confidence runs min 47,
median 75, max 100. On this corpus Gate 1 is effectively a binary long/short
label, not a three-state one.

---

## 17. Limitations

1. **`gamePlanBias` is missing** (§5). Bounded at ±5 confidence points; cannot
   flip direction. Real, small, declared.
2. **The direction feature barely moves** (§16). Effective n is roughly the
   number of window-instruments, not the number of trades. No conclusion about
   the direction verdict should be drawn from 467 as if it were 467 independent
   observations.
3. **The inverted HTF result was not pre-registered.** It emerged from the
   cohort table. It is measured on the same corpus that produced every earlier
   finding, so it is strong enough to reject the alignment hypothesis and *not*
   strong enough to accept its inverse.
4. **Same-corpus reuse.** Five windows, three instruments, already examined
   repeatedly through Stage 3, Experiment 1 and this run.
5. **BTC rests on four of five windows** — p3-BTCUSD's 1-minute feed carries the
   undocumented whole-bar corruption and stays excluded. Its 4H/1H/daily context
   series also contained decimal-shift bars (69 / 68 / 6), dropped by the same
   documented detector.
6. **The reconstruction is stricter than production** (§5): closed candles only,
   so it is one bar behind what the live scanner sees. That direction of error is
   deliberate.
7. **64 unresolved trades** (63 TICK_REQUIRED, 1 STILL_OPEN) are excluded from
   every cohort. Identical exclusion everywhere, so comparisons are unaffected;
   absolute figures exclude 6% of the population.
8. **The 30min → 1h roll-up for USD/JPY** was validated against native provider
   1h bars: 121 overlapping bars, **121 byte-identical**, worst field delta 0.
9. **maxDD is sequenced window-by-window then chronologically**, matching
   Experiment 1's convention, so the baseline row reproduces its 46.7R exactly.

---

## 18. Answering the question

> Can the SMC direction verdict and higher-timeframe structure improve IPO trade
> selection?

**Not as alignment filters. `NO_CONTEXT_EDGE`.**

- HTF structure alignment: **worse** (+0.125 → −0.024).
- Both aligned: **worst** (−0.087), fewest trades, no drawdown benefit.
- Direction alignment: +0.043R, but with worse drawdown, half the trades, and
  97% of its profit in one instrument and one window.
- Nothing rescues BTC. Nothing closes the long/short asymmetry; every filter
  widens it.

The one informative result is HTF structure with the **opposite sign** — a
reversion strategy is punished for demanding trend agreement, which on reflection
is what a reversion strategy should expect.

---

## 19. Is further unseen validation justified?

**For the direction verdict: no.** §16 shows it is nearly a per-window constant
here. Any test of it needs many more regimes before the trade count means
anything, and there is no reason to spend that on a +0.043R effect that worsens
drawdown.

**For the inverted HTF-structure read: yes, and it is the strongest candidate
this programme has produced.** BOTH_OPPOSED is +0.397R at PF 1.57 with the
lowest drawdown of any cohort (15.8R against the baseline's 46.7R), it is
positive on all three instruments including BTC, it holds in four of five
windows, and no subgroup dominates it.

It must be tested on **windows this analysis has not seen**, as a pre-registered
hypothesis with its sign fixed in advance, before it is anything more than a
suggestive number. It is not adopted here, no production rule is proposed, and
nothing in this document changes what the live system does.

---

## 20. Statement

No SMC logic was modified or reimplemented. No IPO detection, geometry,
lifecycle, contraction, FVG, E2 entry, S2 invalidation, 2R target, re-entry,
sequencing, volatility or cost rule was changed. No threshold was swept, no
timeframe searched, no weighting invented, no confidence cutoff tuned. The
research harness imports the production SMC functions read-only; no IPO code
writes to SMC state and no SMC code writes to IPO state. No production module,
schema, cron, RLS policy, live flag, paper runner, broker path or UI default was
touched, and no database row was read or written. Research artifacts are local;
no market-data cache is committed and no credential appears in any file, log or
diff.

### Data and API accounting

| | |
|---|---|
| HTF window series reused from the Stage 3 / Exp 1 cache | **15 of 15** (0 refetched) |
| 1-minute corpus reused | **945 instrument-days**, 0 fetched |
| 5m / 1m fetches | **0** |
| new requests, SMC context series | **37** — 3 daily, 3 weekly, 15 × 4H, 15 × 1H warmup, 1 validation probe |
| 429s / retries / errors | 0 / 0 / 0 |
| candidate-table pass | 63.7 min, **0 API requests** |
| cache deleted or overwritten | none |

The 1H context is the cached in-window bars spliced onto a freshly fetched
30-day warmup; USD/JPY's in-window bars were rolled up locally from the cached
30-minute series rather than refetched (§17.8).
