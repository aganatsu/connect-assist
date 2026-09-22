# FTMO $100K 2-Step Challenge — simulation of the locked causal IPO strategy

**2026-09-21. Account/risk layer only.** No IPO rule changed, read or re-derived.
`ipoFtmoSimulator.ts` imports nothing from the strategy stack and a test asserts
it. Research-only filters (Fib, H1, H5) are **excluded**, as instructed.

Strategy as locked: FVG A1 admission · current lifecycle · E2 candle-midpoint
entry · S2 close invalidation · 2R target · current volatility eligibility ·
first-touch sequencing · one position per instrument · EUR/USD 1H, USD/JPY 30M,
BTC/USD 1H HIGH_VOL.

---

## Method

**Equity replay, not realized results.** The walk is bar-driven. On every bar
where a position is open, floating P/L is marked and both FTMO limits are
checked. This is the entire point: S2 exits on a *close* beyond the IPO candle
extreme, so a position can travel far against the account before the engine
reacts — validation measured median MAE at 1.34R with a tail past 17R.

**Dollars from R.** Risk is fixed per trade, so P/L in dollars is exactly
`R × riskDollars`. An identity, not an approximation — no invented contract
sizes or pip values.

**Ambiguity is run both ways, never resolved silently.**
- `CONSERVATIVE` — every open position marked at its adverse extreme at the same
  instant: the worst equity the bar could have produced.
- `OPTIMISTIC` — marked at bar close only.

**Day boundary.** 00:00 CE(S)T, i.e. UTC+1 winter / UTC+2 summer, with EU DST
switching on the last Sunday of March and October at 01:00 UTC. Daily loss is
measured against **balance at the day open**, so profit banked earlier does not
enlarge the next day's allowance.

**Phases.** Challenge to $110,000, reset to $100,000, Verification to $105,000.
Both need ≥4 trading days and flat positions at the target. Phase 2 resumes at
the first trade Phase 1 did not consume — no trade is reused.

### Stated limitations

- **Swaps are not modelled.** Historical overnight swap rates for these
  instruments are not in this repository and cannot be reconstructed from
  candles. They are omitted, not estimated.
- **Floating equity omits transaction cost.** Realized P/L uses the frozen
  net-of-cost `netR`, but the floating mark uses raw price movement. Real
  equity is lower by roughly `costR × riskDollars` (median costR ≈ 0.3) from the
  moment of entry. **Reported drawdowns are therefore slightly understated.**
- **7 starting windows**, so a "pass rate" of 86% means 6 of 7. These are
  proportions of a small sample, not probabilities.

**Windows** (all three instruments, same calendar period): 2021-01..03 ·
2022-06..08 · 2022-12..2023-02 · 2023-04..06 · 2023-08..09 · 2025-06-15..08 ·
2026-08..09-20. 103–251 trades each.

---

## Results — CONSERVATIVE ordering

| risk | $/1R | P1 pass | P2 given P1 | 2-step | med days P1 | med days P2 | fail daily | fail max | incomplete | closest to daily limit | closest to floor | max intraday DD | max total DD | med trades |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.20% | $200 | **100%** | 71% | **71%** | 20 | 7 | 0 | 0 | 2 | **$376** | $5,469 | $4,624 | $6,292 | 86 |
| 0.25% | $250 | 86% | 67% | 57% | 15 | 7 | 1 | 0 | 2 | **breached** | $4,336 | $5,780 | $7,866 | 62 |
| 0.30% | $300 | 86% | 100% | **86%** | 14 | 8 | 1 | 0 | 0 | breached | $3,203 | $6,936 | $9,439 | 49 |
| 0.40% | $400 | 86% | 100% | **86%** | 9 | 6 | 1 | 0 | 0 | breached | $5,322 | $5,676 | $7,453 | 35 |
| 0.50% | $500 | 86% | 100% | **86%** | 8 | 4 | 1 | 0 | 0 | breached | $4,153 | $7,095 | $9,316 | 32 |

## Results — OPTIMISTIC ordering

| risk | P1 pass | P2 given P1 | 2-step | closest to daily limit | max intraday DD | max total DD |
|---|---|---|---|---|---|---|
| 0.20% | 100% | 71% | 71% | $2,808 | $2,192 | $3,412 |
| 0.25% | 100% | 71% | 71% | $2,260 | $2,740 | $4,266 |
| 0.30% | **100%** | 100% | **100%** | $1,712 | $3,288 | $5,119 |
| 0.40% | **100%** | 100% | **100%** | $616 | $4,384 | $6,825 |
| 0.50% | 86% | 100% | 86% | breached | $5,245 | $8,531 |

**Every breach in every configuration is Maximum Daily Loss. Zero Maximum Loss
breaches at any risk size.** The $90,000 floor was never approached — closest
was $3,203 clear at 0.30%.

**Every breach is USD/JPY.** No EUR/USD or BTC/USD breach occurred at any risk
size under either ordering.

The two "incomplete" results at 0.20–0.25% are windows that never reached +10%
within the available data, not failures.

---

## The finding that matters

**The binding constraint is Maximum Daily Loss, not Maximum Loss, and the margin
is thin even at the smallest risk tested.**

At 0.20% — $200 per 1R, the most conservative size requested — the worst day came
within **$376** of the $5,000 daily limit under conservative ordering. At 0.25%
it breached.

The gap between the two orderings is the whole risk picture:

| | 0.30% conservative | 0.30% optimistic |
|---|---|---|
| 2-step pass | 86% | 100% |
| max intraday DD | $6,936 | $3,288 |

A **$3,648 difference on the same trades**, decided purely by whether adverse
extremes across open positions coincide within a bar. That is not knowable from
OHLC. Anything between those two numbers is possible in live trading, and the
conservative figure already exceeds the $5,000 daily limit.

This follows directly from S2. A stop that waits for a *close* beyond the extreme
permits exactly the kind of deep floating excursion that daily-loss rules are
designed to catch — the strategy's defining risk characteristic is the one FTMO
penalises most.

---

## Worked example — one full Challenge, trade by trade

Window 2025-06-15..08-01, risk 0.30% ($300 per 1R), CONSERVATIVE ordering.
**PASS** — $110,008.25 in 32 trades over 6 trading days. Worst daily loss $1,101;
lowest equity $100,000; 77 ambiguous bars.

```
  #  time (UTC)         CET-day     evt    instrument  detail                          balance
   1  2025-06-17 07:00  2025-06-17  CLOSE  USD/JPY    win 1.692R = +$507.69          $100,507.69
   2  2025-06-17 07:30  2025-06-17  CLOSE  USD/JPY    win 1.858R = +$557.52          $101,065.21
   3  2025-06-17 12:30  2025-06-17  CLOSE  USD/JPY    win 1.858R = +$557.52          $101,622.74
   4  2025-06-18 00:00  2025-06-18  CLOSE  USD/JPY    win 1.695R = +$508.58          $102,131.32
   5  2025-06-18 01:30  2025-06-18  CLOSE  USD/JPY    loss -1.713R = -$514.03        $101,617.29
   6  2025-06-18 17:30  2025-06-18  CLOSE  USD/JPY    win 1.858R = +$557.52          $102,174.81
   7  2025-06-18 18:00  2025-06-18  CLOSE  USD/JPY    win 1.858R = +$557.52          $102,732.33
   8  2025-06-18 18:30  2025-06-18  CLOSE  USD/JPY    win 1.923R = +$576.76          $103,309.09
   9  2025-06-18 19:00  2025-06-18  CLOSE  USD/JPY    win 1.736R = +$520.66          $103,829.75
  10  2025-06-18 21:00  2025-06-18  CLOSE  USD/JPY    win 1.736R = +$520.66          $104,350.41
  11  2025-06-19 03:30  2025-06-19  CLOSE  USD/JPY    win 1.736R = +$520.66          $104,871.07
  12  2025-06-19 06:00  2025-06-19  CLOSE  USD/JPY    loss -1.711R = -$513.17        $104,357.90
  13  2025-06-19 07:30  2025-06-19  CLOSE  USD/JPY    win 1.729R = +$518.66          $104,876.56
  14  2025-06-19 14:00  2025-06-19  CLOSE  EUR/USD    win 1.768R = +$530.43          $105,406.99
  15  2025-06-19 17:00  2025-06-19  CLOSE  EUR/USD    win 1.768R = +$530.43          $105,937.43
  16  2025-06-19 23:00  2025-06-20  CLOSE  USD/JPY    loss -1.674R = -$502.09        $105,435.33   <- CET rollover
  17  2025-06-20 16:00  2025-06-20  CLOSE  EUR/USD    loss -1.523R = -$457.03        $104,978.30
  18  2025-06-20 19:00  2025-06-20  CLOSE  EUR/USD    win 1.709R = +$512.73          $105,491.03
  19  2025-06-22 23:00  2025-06-23  CLOSE  EUR/USD    loss -1.716R = -$514.88        $104,976.15
  20  2025-06-23 09:00  2025-06-23  CLOSE  EUR/USD    win 1.573R = +$472.00          $105,448.15
  21  2025-06-23 13:30  2025-06-23  CLOSE  USD/JPY    win 1.859R = +$557.71          $106,005.86
  22  2025-06-23 14:00  2025-06-23  CLOSE  EUR/USD    win 1.897R = +$569.13          $106,574.99
  23  2025-06-23 16:30  2025-06-23  CLOSE  USD/JPY    win 1.584R = +$475.32          $107,050.31
  24  2025-06-23 17:30  2025-06-23  CLOSE  USD/JPY    win 1.584R = +$475.32          $107,525.64
  25  2025-06-23 22:00  2025-06-24  CLOSE  USD/JPY    win 1.802R = +$540.74          $108,066.38   <- CET rollover
  26  2025-06-23 23:00  2025-06-24  CLOSE  USD/JPY    win 1.802R = +$540.74          $108,607.13
  27  2025-06-24 00:30  2025-06-24  CLOSE  USD/JPY    loss -3.481R = -$1,044.36      $107,562.76   <- S2 tail loss
  28  2025-06-24 09:30  2025-06-24  CLOSE  USD/JPY    win 1.771R = +$531.43          $108,094.19
  29  2025-06-24 13:00  2025-06-24  CLOSE  USD/JPY    win 1.771R = +$531.43          $108,625.62
  30  2025-06-24 14:00  2025-06-24  CLOSE  USD/JPY    win 1.858R = +$557.52          $109,183.14
  31  2025-06-24 16:00  2025-06-24  CLOSE  BTC/USD    win 1.127R = +$338.05          $109,521.20
  32  2025-06-24 17:00  2025-06-24  CLOSE  USD/JPY    win 1.624R = +$487.06          $110,008.25
  33  2025-06-24 17:00  2025-06-24  TARGET  -         +10% reached, 6 trading days   $110,008.25
```

Two things to notice. Line 16 and line 25 are the CE(S)T rollover — a 23:00 UTC
close in summer belongs to the *next* FTMO day, which resets the loss allowance.
Line 27 is an S2 tail loss of −3.48R, more than double the nominal 1R, on a
strategy whose losses average well past 1R.

The concentration is also visible: **25 of 32 trades are USD/JPY**, which is both
why the account reaches target quickly and why every breach in the study is
USD/JPY.

---

## Conclusions

1. **The strategy can pass an FTMO 2-Step** — 86% of windows at 0.30–0.50% under
   conservative ordering, 100% at 0.30–0.40% under optimistic, in a median of
   8–14 trading days for Phase 1.
2. **Maximum Daily Loss is the only binding constraint.** Zero Maximum Loss
   breaches at any risk size; the $90,000 floor was never within $3,200.
3. **USD/JPY causes every breach** and supplies most of the profit. Concentration
   is the dominant account-level risk, not the strategy's win rate.
4. **The conservative/optimistic gap is larger than the safety margin.** At 0.30%
   the same trades produce $3,288 or $6,936 of intraday drawdown depending on
   unknowable intrabar ordering. A $5,000 limit sits inside that range.
5. **0.20% is not obviously safe either** — $376 of margin at the closest point,
   and it fails to reach target in 2 of 7 windows.
6. **Reported drawdowns are understated**, because floating equity omits the
   entry cost and swaps are not modelled.

No risk size is recommended here. The simulation says the account survives more
often than not at 0.20–0.30%, and that the margin is thin enough that the
recommendation should not come from seven windows.

---

**No strategy rule changed. No production code changed. Nothing deployed.**

---
---

# ADDENDUM — Intrabar-resolution validation

**2026-09-21.** No IPO rule and no FTMO rule changed. Risk grid narrowed to
0.15 / 0.20 / 0.25 / 0.30 / 0.35% as instructed.

## What was refined, and why that selection is safe

Scanning every Challenge path at every risk level for days whose worst daily
loss came within $1,500 of the $5,000 limit produced **exactly three CE(S)T
days**, all in the 2026-08 window, all with USD/JPY open:

| window | CET day | worst loss (coarse) | buffer | open at worst |
|---|---|---|---|---|
| 2026-08..09 | 2026-08-07 | $3,547 – $4,966 | $34 – $1,453 | USD/JPY |
| 2026-08..09 | **2026-08-09** | $4,624 – $8,092 | **−$3,092 – $376** | USD/JPY, EUR/USD |
| 2026-08..09 | 2026-08-10 | $3,836 | $1,164 | — |

**Refining only these days is sound, not a shortcut.** A coarse bar's low is the
minimum of its constituent minutes' lows, so the coarse conservative mark is a
*lower bound* on equity. Finer resolution can only move conservative equity up,
never down — a day below the threshold at 1h cannot cross it at 1m.

**Data obtained: 1-minute candles, 17,286 bars**, all three instruments, UTC
2026-08-06 22:00 → 2026-08-10 22:00 (which is exactly CET 08-07, 08-09 and
08-10 end to end). **Tick data is not available** from the configured providers
on this plan; 1-minute is the finest resolution obtainable.

## Two corrections applied

1. **Transaction cost now charged to floating equity from entry.** Realized P/L
   always carried it inside `netR`, but a broker debits the spread when the
   position opens. Floating equity is now reduced by `costR × riskDollars` for
   the entire life of every trade, which lowers every drawdown figure below.
2. **Mixed-resolution timeline** — 1-minute bars replace the coarse bars across
   the refined span; everything else is unchanged.

**Swaps remain excluded.** Historical overnight rates are still unavailable and
are not estimated.

---

## Result — the ambiguity resolves in favour of NO breach

### CONSERVATIVE, coarse (1h/30m) vs mixed 1-minute

| risk | breaches coarse | **breaches 1-min** | min buffer coarse | **min buffer 1-min** | worst day coarse | **worst day 1-min** |
|---|---|---|---|---|---|---|
| 0.15% | 0 | **0** | $1,323 | **$2,937** | $3,677 | **$2,063** |
| 0.20% | 0 | **0** | $98 | **$2,249** | $4,902 | **$2,751** |
| 0.25% | **1** | **0** | −$1,128 | **$1,561** | $6,128 | **$3,439** |
| 0.30% | **1** | **0** | −$2,353 | **$873** | $7,353 | **$4,127** |
| 0.35% | **1** | **0** | −$29 | **$185** | $5,029 | **$4,815** |

**Actual daily-equity breach count at 1-minute resolution: ZERO at every risk
level, under both orderings.** The coarse-resolution breaches at 0.25%, 0.30%
and 0.35% were artefacts of assuming that adverse extremes on USD/JPY and
EUR/USD occurred in the same instant. At 1-minute resolution they demonstrably
did not.

### Full results — MIXED 1-MINUTE, CONSERVATIVE

| risk | $/1R | P1 pass | P2 given P1 | 2-step | med days P1 | med days P2 | breach daily | breach max | min buffer | median day DD | worst day DD | USD/JPY share | ambiguous bars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.15% | $150 | 71% | 100% | 71% | 24 | 9 | 0 | 0 | **$2,937** | $307 | $2,063 | 100% | 6,877 |
| 0.20% | $200 | **100%** | 71% | 71% | 20 | 7 | 0 | 0 | **$2,249** | $410 | $2,751 | 50% | 6,062 |
| 0.25% | $250 | **100%** | 71% | 71% | 15 | 7 | 0 | 0 | **$1,561** | $543 | $3,439 | 75% | 5,400 |
| **0.30%** | $300 | **100%** | **100%** | **100%** | 14 | 7 | 0 | 0 | **$873** | $615 | $4,127 | 56% | 5,117 |
| 0.35% | $350 | **100%** | **100%** | **100%** | 10 | 9 | 0 | 0 | **$185** | $717 | $4,815 | 40% | 4,950 |

MIXED 1-minute OPTIMISTIC is identical on pass rates, with buffers of $3,356 /
$2,808 / $2,260 / $1,712 / $1,164.

The two "incomplete" results at 0.15% are windows that never reached +10% within
the data — not failures.

## Remaining ambiguity

The raw ambiguous-bar count *rises* (1,350 → 5,117 at 0.30%) simply because 1
minute produces more bars. The meaningful measure is the **width of the
conservative-to-optimistic band**, which collapses:

| risk | band, coarse | **band, 1-minute** |
|---|---|---|
| 0.20% | $2,710 | **$559** |
| 0.25% | $3,388 | **$699** |
| 0.30% | $4,065 | **$839** |
| 0.35% | $1,193 | **$979** |

At 0.30% the uncertainty about whether the account survives narrows from $4,065
to $839 — and the entire remaining band now sits **inside** the surviving side of
the limit. Residual ambiguity within a single minute cannot be resolved without
tick data, which is unavailable.

## USD/JPY contribution

Still dominant but no longer exclusive. Of days with drawdown ≥ $2,000, USD/JPY
was open for **40–100%** depending on risk size (100% at 0.15%, 56% at 0.30%).
Every coarse-resolution breach involved USD/JPY; at 1-minute resolution there
are no breaches to attribute.

---

## Conclusions

1. **Zero actual daily-loss breaches at 1-minute resolution**, at all five risk
   levels, under both orderings — including the three near-miss days that drove
   every coarse-resolution failure.
2. **The coarse simulation was materially too pessimistic.** Simultaneous
   adverse extremes across instruments is a worst case the data does not
   support; treating it as the planning figure would have rejected risk sizes
   that never actually breached.
3. **0.30% is the largest size with both a 100% two-step rate and a positive
   buffer** ($873 minimum, $4,127 worst day). 0.35% passes equally but leaves
   $185 — inside the noise of a model that still excludes swaps and cannot see
   inside a minute.
4. **0.20–0.25% buy a much larger buffer** ($2,249 / $1,561) at the cost of a
   71% two-step rate, because Phase 2 more often fails to reach target in the
   data available rather than because it breaches.
5. **The margin still comes from one instrument.** USD/JPY dominates both the
   profit and the drawdown; the account-level risk is concentration, not
   strategy quality.

Two things still understate risk and should be carried into any decision: swaps
are excluded, and 1-minute is not tick — the sub-minute path remains unknown.

**No strategy rule changed. No production code changed. Nothing deployed.**
