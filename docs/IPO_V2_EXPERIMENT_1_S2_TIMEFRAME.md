# IPO-CET-v2 Experiment 1 — S2 confirmation timeframe

**Research only. One variable changed. No strategy code, no production change,
no deployment, no database write, no schema, no cron, no SMC or broker change.**
Branch `research/ipo-v2-s2-timeframe`. Dated 2026-09-24.

---

## 1. Verdict

```
NO_MATERIAL_IMPROVEMENT
```

**Lower-timeframe S2 confirmation makes the strategy worse, monotonically.**

| version | n | win% | break-even% | gap | expR | PF | total R | maxDD |
|---|---|---|---|---|---|---|---|---|
| **S2_HTF_CONTROL** | 957 | **61.4** | 58.2 | **+3.2** | **+0.125** | **1.14** | **+119.7** | 46.7 |
| S2_5M_CLOSE | 957 | 51.6 | 51.7 | −0.1 | −0.002 | 1.00 | −2.2 | 88.2 |
| S2_1M_CLOSE | 957 | 45.9 | 49.6 | −3.7 | −0.121 | 0.86 | −115.7 | 136.4 |

The hypothesis is **not** rejected on its own terms — the loss tail compresses
exactly as predicted. It is rejected on net: the win rate falls faster than the
loss shrinks.

---

## 2. What changed, and what did not

Frozen to causally-corrected v1: IPO detection, geometry, lifecycle, contraction,
FVG requirement, direction logic, E2 entry, 2R target, **the S2 price itself**,
re-entry semantics, one-position-per-instrument, cost model, volatility handling,
validation windows, provider.

Varied — only this:

| | S2 confirmed when |
|---|---|
| A `S2_HTF_CONTROL` | the setup bar closes beyond S2 (EUR 1h / JPY 30min / BTC 1h) |
| B `S2_5M_CLOSE` | a completed 5m bar closes beyond S2 |
| C `S2_1M_CLOSE` | a completed 1m bar closes beyond S2 |

A wick through S2 is never an exit, at any resolution.

**Target detection is held at 1-minute in all three versions.** That is what
makes this one variable rather than two — and it means version A is a
*reconstructed* control, not a byte-copy of the v1 causal run (§10).

---

## 3. Execution semantics

Entry is the causal one: the first minute inside the entry bar that reaches E2.
No pre-entry extreme may resolve a post-entry trade. From that minute the tape is
walked forward; target is tested every minute; S2 is tested only at the version's
confirmation boundary. Whichever fires first in time ends the trade.

Within one confirmation interval a target beats an S2 close, because the close is
that interval's last event and a high cannot follow it.

**The population is frozen.** An earlier exit in B or C frees the
one-position-per-instrument slot sooner and would, live, admit trades v1 never
took. Those are **not** added — adding them would change the population and break
the isolation. B and C are therefore measured *conservatively*: any benefit from
faster slot recycling is excluded, not counted.

5m candles are built locally from the same 1m tape on UTC boundaries (open =
first 1m open, high = max, low = min, close = last). No second feed.

---

## 4. Data coverage and cache reuse

| | |
|---|---|
| instrument-days required | **915** |
| **reused from the Stage 3 cache** | **566** |
| genuinely missing, fetched | **349** |
| new API requests | **124** (3-day blocks, not 349 calls) |
| 5m fetches | **0** — built from cached 1m |
| 429s / errors | 0 / 0 |

Nothing cached was deleted or overwritten; the fetcher only adds keys.

Population 1,021 · resolved 957 · still-open at window end 1 · `TICK_REQUIRED`
63. BTC 2023-06..08 remains excluded (undocumented whole-bar 1m corruption), and
the corrupt-minute filters from the v1 work are applied to the tape.

**Invariant, asserted per version and passing:** resolved + still-open +
unresolved = 1,021, with no trade counted twice.

---

## 5. The loss tail — the hypothesis was right

| version | losses | median | mean | p75 | p90 | p95 | p99 | max | >1R | >1.5R | >2R | >3R | >5R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HTF control | 369 | 1.77 | 2.27 | 2.47 | 3.37 | 4.66 | 8.81 | **28.63** | 99% | 72% | 39% | 16% | 5% |
| 5m | 463 | 1.55 | 1.74 | 1.90 | 2.40 | 2.84 | 4.34 | **13.77** | 100% | 54% | 21% | 4% | 1% |
| 1m | 518 | 1.44 | 1.61 | 1.72 | 2.14 | 2.65 | 4.03 | **8.30** | 100% | 43% | 12% | 3% | 1% |

Every tail measure improves monotonically. Max loss falls from 28.63R to 8.30R.
Losses beyond 3R fall from 16% to 3%. The required break-even win rate falls from
58.2% to 49.6%.

**And it still does not help**, because:

| | HTF | 5m | 1m |
|---|---|---|---|
| win rate | 61.4% | 51.6% | 45.9% |
| break-even needed | 58.2% | 51.7% | 49.6% |
| **gap** | **+3.2pp** | **−0.1pp** | **−3.7pp** |

Tightening the confirmation lowers the bar by 8.6pp and lowers the hit rate by
15.5pp. The bar falls; the strategy falls further.

---

## 6. Both sides of the trade-off, in R

| | trades better than control | trades worse | net |
|---|---|---|---|
| 5m | 244, **+226.6R** | 172, **−348.5R** | **−121.9R** |
| 1m | 284, **+280.1R** | 207, **−515.5R** | **−235.4R** |

### Tail risk genuinely contained

| control loses worse than | 5m kept it above | 1m kept it above |
|---|---|---|
| −2R | 89 trades | 115 |
| −3R | 48 | 53 |
| −5R | 14 | 15 |

### And recoveries genuinely killed

`EARLY_EXIT_THEN_RECOVERED_TO_TARGET` — stopped by the tighter rule, then the
control went on to reach 2R:

| | n | R forgone |
|---|---|---|
| 5m | **96** (EUR 38, JPY 48, BTC 10) | **323.2R** |
| 1m | **152** (EUR 57, JPY 80, BTC 15) | **502.3R** |

**This is the finding.** S2 is not merely a stop that happens to be wide — the
width is doing work. Roughly a quarter of trades that trade through S2 intrabar
come back and reach target, and the HTF close is what lets them. Confirming
faster converts those winners into losers at about 1.5× the rate it converts big
losers into small ones.

---

## 7. Per instrument

| | version | n | win% | BE% | gap | expR | PF | total R |
|---|---|---|---|---|---|---|---|---|
| **EUR/USD** | HTF | 323 | 62.5 | 54.6 | **+7.9** | **+0.291** | **1.39** | +94.0 |
| | 5m | 323 | 51.1 | 48.7 | +2.4 | +0.079 | 1.10 | +25.4 |
| | 1m | 323 | 45.2 | 47.0 | −1.8 | −0.058 | 0.93 | −18.8 |
| **USD/JPY** | HTF | 515 | 60.4 | 57.7 | +2.7 | +0.106 | 1.12 | +54.6 |
| | 5m | 515 | 51.1 | 51.0 | +0.1 | +0.002 | 1.00 | +1.0 |
| | 1m | 515 | 45.0 | 48.5 | −3.5 | −0.115 | 0.87 | −59.3 |
| **BTC** | HTF | 119 | 63.0 | 69.0 | −6.0 | −0.242 | 0.76 | −28.8 |
| | 5m | 119 | 55.5 | 62.8 | −7.4 | −0.241 | 0.74 | −28.6 |
| | 1m | 119 | 51.3 | 61.3 | −10.0 | −0.316 | 0.66 | −37.6 |

Same ordering on all three: HTF > 5m > 1m. BTC is negative under every version
and its break-even requirement never drops below 61%.

---

## 8. 5m versus 1m

5m is strictly the better of the two — it captures most of the tail containment
(89 of 115 sub-2R rescues, 48 of 53 sub-3R) while killing far fewer recoveries
(96 against 152). Its net cost against the control is −121.9R rather than
−235.4R.

But "better of the two" is not "good": 5m lands at exactly break-even
(−0.002R, PF 1.00). **Neither is preferable to the control**, so the secondary
question resolves to: if a faster confirmation is ever wanted for a different
reason, use 5m, not 1m.

---

## 9. An unexpected result worth more than the experiment

**The reconstructed control is positive: +0.125R, PF 1.14** — where the v1 causal
figure was **−0.067R, PF 0.93**.

The only difference is where the target is detected. v1 evaluated target and S2
on the HTF bar and resolved ties stop-first by convention. This control detects
the target on the 1m tape, so when price genuinely reached 2R before the bar
closed beyond S2, that order is used instead of the convention.

**On this population that convention was worth about −0.19R per trade.** It is
not a rule change: the frozen stop-first convention exists precisely because HTF
data cannot order the two events. What changes is that 1m data *can*.

This is a candidate for Experiment 2, and it is a larger effect than anything
Experiment 1 tested. It is reported, not adopted — it was not pre-registered, it
emerged from the control construction, and it needs its own test on data this
analysis has not seen.

---

## 10. Limitations

1. **The control is reconstructed, not v1 verbatim** (§9). A/B/C are mutually
   comparable; A against the published v1 causal figure is not like-for-like.
2. **63 trades remain `TICK_REQUIRED`** and are excluded from all three versions
   equally, so the comparison is unaffected but the absolute figures exclude 6%
   of the population.
3. **BTC rests on four of five windows**; the 2023-06..08 1m feed is corrupt in a
   way the freeze document does not describe and no detector was invented for it.
4. **The frozen population understates B and C.** Earlier exits would free the
   position slot sooner and admit trades v1 never took. That upside is excluded
   by design.
5. **Same-window reuse.** This is the same corpus that exposed the v1 failure, so
   the result is a measurement on already-examined data. It is strong enough to
   reject a hypothesis; it would not be strong enough to accept one.

---

## 11. Answering the primary question

> Does changing only the S2 confirmation timeframe make the frozen IPO signal
> economically viable?

**No.** `NO_MATERIAL_IMPROVEMENT`. Both alternatives are worse than the control
on expectancy, profit factor, total R, drawdown and the break-even gap, on every
instrument.

v1 did **not** fail mainly because S2 waited for the full candle to close. The
wide stop is buying something real — about a quarter of trades that pierce S2
intrabar recover to target — and paying for it with a fat tail. Removing the tail
removes the recoveries too, and the recoveries are worth more.

A hard −1R stop (Experiment 2 as originally scoped) would be a strictly more
aggressive version of the same intervention, and this result makes it a poor
prior. The §9 finding looks like the better Experiment 2.

---

## 12. Statement

No IPO rule was changed. S2's price, the 2R target, E2, the FVG requirement,
re-entry, sequencing, costs and volatility handling are all as in causally
corrected v1. No filter was added — no early-entry, same-bar, EUR-only,
supply-only, session, trailing, break-even or hard-stop rule. No breaker/retest.
No production code, schema, cron, deployment, SMC or broker change, and no
database write. Research artifacts stay local and no market-data cache is
committed.
