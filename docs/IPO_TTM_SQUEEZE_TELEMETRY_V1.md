# IPO_TTM_SQUEEZE_TELEMETRY_V1

**Telemetry / cohort study — NOT a profitability test of a TTM strategy.**
Research only. Production IPO logic unchanged. No TTM filter deployed. Nothing filtered:
every control trade is kept and tagged.

**Question:** does TTM Squeeze state known before an IPO entry separate stronger and weaker trades?

**Answer: no.** No cohort is distinguishable from noise. The best permutation p is 0.169, and after
Holm correction across the 10 required cohorts every p is 1.000. Most apparent differences also flip
sign between periods or instruments. TTM state at entry does not separate IPO trades in this control.

---

## 1. Control reconstruction

**Control = `IPO_BASELINE_1H_4H_CAUSAL_V1`, ARM C (1H+4H, shared instrument slot),** taken verbatim
from the committed `docs/exports/ipo_1h_4h_combined_clean.csv` (commit 784aab32).

| | frozen | reconstructed |
|---|---:|---:|
| n | 1,032 | 1,032 |
| WR | 61.5% | 61.5% |
| expectancy | +0.202R | +0.202R |
| PF | 1.25 | 1.25 |
| net | +208.3R | +208.3R |
| max DD | 41.3R | 41.3R (file order) · **45.6R chronological** |
| trades/month | 32.8 | 32.8 (per 31.5 instrument-months) |

- **The 41.3R drawdown was computed in file order,** which runs window by window per instrument.
  Chronologically across the whole portfolio, the control's max DD is **45.6R**. All cohort drawdowns
  below are chronological.
- **The figures you quoted for "1H +0.150R / 4H +0.188R" are the STANDALONE arms** A (n=986) and
  B (n=249). Inside ARM C, the 1H and 4H slices are n=823 (+0.199R) and n=209 (+0.214R). The
  timeframe breakdowns below use the ARM C slices.

### Why the frozen trades are tagged rather than re-selected

The frozen run read its 1H/4H series from `/tmp`, which has since been cleared, and the script that
wrote those files was never committed. I re-fetched the series (36 requests, cached persistently in
`local-runner/.cache/ipo-ttm/`) and re-ran the exact ARM C loop. It re-selected **1,011 of 1,032**
trades exactly, missed 16 and added 6.

- **The data is identical:** all 1,032 frozen IPO candles are byte-identical in the re-fetched series.
- **The cause is the decision start.** It was set by the first 1m bar, which came from backward 1m
  paging. Recovering it would take ~220 1m requests on the API key production shares. The anchor
  available lands 1-2 days late in 5 windows. That drops 18 early frozen trades as warm-up and
  shifts the one-slot state, which produces paired shifts (e.g. BTC 1H entry 112474.31 at 22:00
  frozen vs 20:00 re-run).

TTM needs only the bars strictly before each trade's entry bar, and those bars are proven identical.
**The user chose to tag the frozen trades directly (2026-10-01).** The engine re-run is kept as a
diagnostic: `ipo-ttm-telemetry.ts --reconstruct`.

### Data-equivalence gate — every trade, not a sample

For each of the 1,032 frozen trades:
- its IPO candle is byte-identical in the re-fetched series;
- its entry bar exists and reaches the frozen entry price;
- the entry bar comes after the IPO candle.

**Result: 1,032 / 1,032 pass, 0 fail.**

## 2. Causality

- **Decision bar:** TTM for a trade is computed from `series.slice(0, entryBarIndex)`, the bars
  strictly **before** the IPO touch bar. This is the same `barsBefore` prefix the frozen engine hands
  its own research hooks (`ipoIncrementalEngine.ts`: `barsBefore: this.bars.slice(0, K)`). The touch
  bar is still forming when the resting order fills, so it is never read.
- **Tests:** `supabase/tests/_shared/ttmSqueeze.test.ts`, 11 tests, run in CI. They show:
  - every TTM value at bar i is identical when every bar after i is deleted (prefix invariance);
  - wrecking every candle from the entry bar onward leaves the trade's TTM state unchanged;
  - a squeeze release is not detectable until the bar that ended it has closed;
  - no production function imports the TTM module.
- **Mutation-tested:** planting a one-bar look-ahead in the momentum turns the prefix-invariance,
  future-mutation and independent regression tests red.

## 3. TTM implementation (frozen before any result)

- **Parameters:** length 20, BB ×2.0, KC ×1.5, computed on the same timeframe as the trade
  (1H→1H, 4H→4H). No sweep, no alternates.
- **Formula, as specified:**
  - BB = SMA ± 2·stdev
  - KC = EMA ± 1.5·ATR
  - squeeze ON when the BB sit inside the KC
  - momentum = linreg(close − ((HH+LL)/2 + SMA)/2, 20)
- **Choices the spec left open, fixed before any result was seen:**
  - stdev is the **population** standard deviation;
  - ATR is **Wilder's RMA**, seeded with an SMA;
  - EMA is seeded with an SMA;
  - linreg takes the fitted value at the last point (TradingView `ta.linreg(src, 20, 0)`).
- **Phases** are mutually exclusive, with SQUEEZE_ON taking precedence. "Released" means band
  containment ended on a closed bar ≤ 3 bars before the decision bar (0 = on the decision bar
  itself).
- **Coverage:** TTM is available for all 1,032 trades. No momentum is exactly zero, so no trade is
  neutral.

**Distribution:**

| Measure | Counts |
|---|---|
| Phase | NO_RECENT_SQUEEZE 770 · SQUEEZE_ON 145 · RELEASED_2_TO_3 60 · RELEASED_1 29 · RELEASED_SAME_BAR 28 |
| Alignment | opposed 631 · aligned 401 |
| Momentum slope | falling 538 · rising 494 |

## 4. Headline table

| Cohort | n | WR | Exp R | PF | Net R | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| CONTROL | 1032 | 61.5% | +0.202 | 1.25 | +208.3 | 45.6 |
| Squeeze ON | 145 | 56.6% | −0.018 | 0.98 | −2.6 | 23.9 |
| Recently Released (0-3) | 117 | 63.2% | +0.314 | 1.41 | +36.8 | 19.5 |
| Released + Aligned | 32 | 68.8% | +0.159 | 1.15 | +5.1 | 17.8 |
| Released + Opposed | 85 | 61.2% | +0.373 | 1.57 | +31.7 | 8.6 |
| No Recent Squeeze | 770 | 62.2% | +0.226 | 1.28 | +174.1 | 32.7 |

## 5. Interpretation

- **SQUEEZE_ON** has the largest gap, −0.256R vs the rest, but p = 0.169 (Holm 1.000). Its sign
  holds in both periods, yet **not across instruments**: EUR/USD is −0.273R (n=79) while USD/JPY is
  **+0.381R** (n=52). A real effect would not reverse by instrument.
- **RECENTLY_RELEASED** is +0.436R on 1H (n=99) but **−0.355R** on 4H (n=18), so its sign flips by
  timeframe, and p = 0.53.
- **Momentum alignment** is a non-factor: aligned +0.217R vs opposed +0.192R, p = 0.85. On BTC the
  gap is larger (+0.219 vs −0.104), but it does not hold on EUR/USD, where opposed is better.
- **The TTM folklore cohort, RELEASED + ALIGNED, is the weakest released cohort** (n=32, +0.159R),
  below RELEASED + OPPOSED (n=85, +0.373R). This is the reverse of the textbook reading, and it is
  noise too.
- **Sample-size warnings** are flagged inline in every table: ⚠ small sample for n < 30, and
  ⚠ too small for inference for n < 15. Every RELEASED sub-cohort is small. Most
  instrument × timeframe cells are too small to support any claim.

## 6. Next step

**No cohort met the bar for a preregistered second run,** and I do not recommend one.

If a rule is tested anyway, the only defensible candidate is the least-bad one:

> *Skip an IPO entry when the same-timeframe TTM squeeze is ON at the decision bar (length 20,
> BB 2.0, KC 1.5, decision bar = last closed bar before the touch bar).*

It must be frozen **before** running, and evaluated only on data this study has not seen. This
dataset generated the hypothesis, so re-testing on it would be circular. Note that unseen IPO history
is nearly exhausted (see the IPO research freeze docs), so a forward paper test may be the only clean
option. Expectations should be low, because the effect already reverses on USD/JPY here.

## 7. Artefacts

- `docs/exports/ipo_ttm_squeeze_telemetry_v1.csv` — 1,032 rows: the trade, its net R, and all TTM fields
- `local-runner/ttmSqueeze.ts` — the frozen TTM definition (pure)
- `local-runner/ipo-ttm-telemetry.ts` — data gate, tagging, cohorts and inference (`--reconstruct` for the diagnostic re-run)
- `local-runner/ipo-ttm-fetch.ts` — rebuilds the strategy-timeframe corpus into a persistent cache
- `supabase/tests/_shared/ttmSqueeze.test.ts` — causality and formula tests

Reproduce:
`deno run --allow-net --allow-read --allow-write local-runner/ipo-ttm-fetch.ts && deno run --allow-read --allow-write local-runner/ipo-ttm-telemetry.ts`

---

## Full tables

### INFERENCE — each cohort vs its complement (combined control)

| Cohort | n | Exp − complement | 95% CI of cohort Exp | perm p | Holm p | sign holds 2022 & 2025 | sign holds by instrument (n≥15) |
|---|---:|---:|---|---:|---:|:---:|:---:|
| SQUEEZE_ON at entry | 145 | -0.256 | [-0.378, +0.345] | 0.169 | 1.000 | yes | 1/2 |
| RELEASED_SAME_BAR ⚠ small sample | 28 | +0.513 | [+0.079, +1.265] | 0.195 | 1.000 | NO | 1/1 |
| RELEASED_1_BAR_AGO ⚠ small sample | 29 | +0.132 | [-0.391, +0.976] | 0.740 | 1.000 | NO | 1/1 |
| RELEASED_2_TO_3_BARS_AGO | 60 | -0.080 | [-0.615, +0.725] | 0.767 | 1.000 | NO | 1/1 |
| RECENTLY_RELEASED (0-3) | 117 | +0.127 | [-0.113, +0.693] | 0.529 | 1.000 | NO | 2/3 |
| NO_RECENT_SQUEEZE | 770 | +0.096 | [+0.080, +0.367] | 0.523 | 1.000 | yes | 2/3 |
| ALIGNED_MOMENTUM | 401 | +0.025 | [+0.003, +0.422] | 0.849 | 1.000 | NO | 2/3 |
| OPPOSED_MOMENTUM | 631 | -0.025 | [+0.031, +0.350] | 0.857 | 1.000 | NO | 2/3 |
| RELEASED + ALIGNED | 32 | -0.044 | [-1.168, +1.137] | 0.905 | 1.000 | NO | 0/1 |
| RELEASED + OPPOSED | 85 | +0.186 | [+0.007, +0.734] | 0.429 | 1.000 | NO | 1/2 |

### COMBINED — 1H + 4H (the control)

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 1032 | 61.5% | +1.665 | -2.138 | +0.202 | 1.25 | +208.3 | 45.6 | 32.8 |
| SQUEEZE_ON at entry | 145 | 56.6% | +1.744 | -2.312 | -0.018 | 0.98 | -2.6 | 23.9 | 4.6 |
| RELEASED_SAME_BAR ⚠ small sample | 28 | 71.4% | +1.685 | -1.758 | +0.701 | 2.40 | +19.6 | 4.3 | 0.9 |
| RELEASED_1_BAR_AGO ⚠ small sample | 29 | 62.1% | +1.752 | -1.997 | +0.330 | 1.44 | +9.6 | 4.6 | 0.9 |
| RELEASED_2_TO_3_BARS_AGO | 60 | 60.0% | +1.705 | -2.241 | +0.126 | 1.14 | +7.6 | 24.0 | 1.9 |
| RECENTLY_RELEASED (0-3) | 117 | 63.2% | +1.711 | -2.089 | +0.314 | 1.41 | +36.8 | 19.5 | 3.7 |
| NO_RECENT_SQUEEZE | 770 | 62.2% | +1.644 | -2.108 | +0.226 | 1.28 | +174.1 | 32.7 | 24.4 |
| ALIGNED_MOMENTUM | 401 | 62.8% | +1.656 | -2.216 | +0.217 | 1.26 | +87.0 | 38.0 | 12.7 |
| OPPOSED_MOMENTUM | 631 | 60.7% | +1.671 | -2.091 | +0.192 | 1.23 | +121.2 | 38.0 | 20.0 |
| RELEASED + ALIGNED | 32 | 68.8% | +1.802 | -3.454 | +0.159 | 1.15 | +5.1 | 17.8 | 1.0 |
| RELEASED + OPPOSED | 85 | 61.2% | +1.672 | -1.675 | +0.373 | 1.57 | +31.7 | 8.6 | 2.7 |
| SQUEEZE_ON + ALIGNED | 61 | 55.7% | +1.726 | -2.596 | -0.187 | 0.84 | -11.4 | 25.7 | 1.9 |
| SQUEEZE_ON + OPPOSED | 84 | 57.1% | +1.757 | -2.100 | +0.104 | 1.12 | +8.7 | 11.6 | 2.7 |
| MOMENTUM RISING | 494 | 59.9% | +1.721 | -2.024 | +0.220 | 1.27 | +108.7 | 32.3 | 15.7 |
| MOMENTUM FALLING | 538 | 63.0% | +1.616 | -2.252 | +0.185 | 1.22 | +99.5 | 28.2 | 17.1 |

### BY TIMEFRAME — 1H slice of the combined control

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 823 | 62.1% | +1.634 | -2.152 | +0.199 | 1.24 | +163.5 | 32.0 | 26.1 |
| SQUEEZE_ON at entry | 119 | 60.5% | +1.724 | -2.433 | +0.082 | 1.09 | +9.7 | 24.4 | 3.8 |
| RELEASED_SAME_BAR ⚠ small sample | 26 | 73.1% | +1.671 | -1.847 | +0.724 | 2.46 | +18.8 | 4.3 | 0.8 |
| RELEASED_1_BAR_AGO ⚠ small sample | 25 | 64.0% | +1.735 | -2.103 | +0.353 | 1.47 | +8.8 | 4.5 | 0.8 |
| RELEASED_2_TO_3_BARS_AGO | 48 | 60.4% | +1.669 | -1.731 | +0.323 | 1.47 | +15.5 | 8.4 | 1.5 |
| RECENTLY_RELEASED (0-3) | 99 | 64.6% | +1.686 | -1.850 | +0.436 | 1.67 | +43.2 | 8.2 | 3.1 |
| NO_RECENT_SQUEEZE | 605 | 62.0% | +1.607 | -2.140 | +0.183 | 1.22 | +110.5 | 36.8 | 19.2 |
| ALIGNED_MOMENTUM | 317 | 63.1% | +1.616 | -2.167 | +0.220 | 1.27 | +69.7 | 34.3 | 10.1 |
| OPPOSED_MOMENTUM | 506 | 61.5% | +1.645 | -2.143 | +0.185 | 1.22 | +93.7 | 37.1 | 16.1 |
| RELEASED + ALIGNED ⚠ small sample | 25 | 64.0% | +1.784 | -2.153 | +0.366 | 1.47 | +9.2 | 6.7 | 0.8 |
| RELEASED + OPPOSED | 74 | 64.9% | +1.653 | -1.745 | +0.460 | 1.75 | +34.0 | 8.6 | 2.3 |
| SQUEEZE_ON + ALIGNED | 46 | 60.9% | +1.696 | -2.862 | -0.088 | 0.92 | -4.0 | 27.7 | 1.5 |
| SQUEEZE_ON + OPPOSED | 73 | 60.3% | +1.742 | -2.167 | +0.189 | 1.22 | +13.8 | 9.1 | 2.3 |
| MOMENTUM RISING | 390 | 59.0% | +1.694 | -2.080 | +0.145 | 1.17 | +56.6 | 35.2 | 12.4 |
| MOMENTUM FALLING | 433 | 64.9% | +1.585 | -2.227 | +0.247 | 1.32 | +106.8 | 21.5 | 13.7 |

### BY TIMEFRAME — 4H slice of the combined control

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 209 | 59.3% | +1.793 | -2.088 | +0.214 | 1.25 | +44.8 | 21.7 | 6.6 |
| SQUEEZE_ON at entry ⚠ small sample | 26 | 38.5% | +1.893 | -1.957 | -0.476 | 0.60 | -12.4 | 14.3 | 0.8 |
| RELEASED_SAME_BAR ⚠ too small for inference | 2 | 50.0% | +1.949 | -1.136 | +0.406 | 1.72 | +0.8 | 1.1 | 0.1 |
| RELEASED_1_BAR_AGO ⚠ too small for inference | 4 | 50.0% | +1.888 | -1.523 | +0.183 | 1.24 | +0.7 | 1.6 | 0.1 |
| RELEASED_2_TO_3_BARS_AGO ⚠ too small for inference | 12 | 58.3% | +1.854 | -4.182 | -0.661 | 0.62 | -7.9 | 19.7 | 0.4 |
| RECENTLY_RELEASED (0-3) ⚠ small sample | 18 | 55.6% | +1.871 | -3.136 | -0.355 | 0.75 | -6.4 | 21.3 | 0.6 |
| NO_RECENT_SQUEEZE | 165 | 63.0% | +1.776 | -1.985 | +0.385 | 1.52 | +63.6 | 13.7 | 5.2 |
| ALIGNED_MOMENTUM | 84 | 61.9% | +1.808 | -2.396 | +0.206 | 1.23 | +17.3 | 20.4 | 2.7 |
| OPPOSED_MOMENTUM | 125 | 57.6% | +1.782 | -1.903 | +0.220 | 1.27 | +27.5 | 14.7 | 4.0 |
| RELEASED + ALIGNED ⚠ too small for inference | 7 | 85.7% | +1.850 | -15.161 | -0.580 | 0.73 | -4.1 | 15.2 | 0.2 |
| RELEASED + OPPOSED ⚠ too small for inference | 11 | 36.4% | +1.902 | -1.418 | -0.211 | 0.77 | -2.3 | 6.1 | 0.3 |
| SQUEEZE_ON + ALIGNED ⚠ small sample | 15 | 40.0% | +1.869 | -2.062 | -0.490 | 0.60 | -7.3 | 8.6 | 0.5 |
| SQUEEZE_ON + OPPOSED ⚠ too small for inference | 11 | 36.4% | +1.930 | -1.823 | -0.458 | 0.60 | -5.0 | 7.2 | 0.3 |
| MOMENTUM RISING | 104 | 63.5% | +1.817 | -1.785 | +0.501 | 1.77 | +52.1 | 6.8 | 3.3 |
| MOMENTUM FALLING | 105 | 55.2% | +1.766 | -2.334 | -0.069 | 0.93 | -7.3 | 29.0 | 3.3 |

### BY INSTRUMENT — EUR/USD

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 544 | 60.3% | +1.775 | -2.198 | +0.198 | 1.23 | +107.6 | 37.2 | 51.8 |
| SQUEEZE_ON at entry | 79 | 51.9% | +1.799 | -2.510 | -0.273 | 0.77 | -21.6 | 30.2 | 7.5 |
| RELEASED_SAME_BAR ⚠ small sample | 16 | 75.0% | +1.761 | -1.917 | +0.842 | 2.76 | +13.5 | 2.8 | 1.5 |
| RELEASED_1_BAR_AGO ⚠ small sample | 18 | 66.7% | +1.806 | -2.021 | +0.530 | 1.79 | +9.5 | 4.5 | 1.7 |
| RELEASED_2_TO_3_BARS_AGO | 41 | 61.0% | +1.751 | -2.382 | +0.138 | 1.15 | +5.7 | 19.0 | 3.9 |
| RECENTLY_RELEASED (0-3) | 75 | 65.3% | +1.767 | -2.227 | +0.382 | 1.49 | +28.7 | 18.9 | 7.1 |
| NO_RECENT_SQUEEZE | 390 | 61.0% | +1.773 | -2.114 | +0.258 | 1.31 | +100.6 | 20.7 | 37.1 |
| ALIGNED_MOMENTUM | 204 | 60.8% | +1.772 | -2.423 | +0.127 | 1.13 | +25.9 | 30.8 | 19.4 |
| OPPOSED_MOMENTUM | 340 | 60.0% | +1.777 | -2.065 | +0.240 | 1.29 | +81.7 | 19.0 | 32.4 |
| RELEASED + ALIGNED ⚠ small sample | 20 | 75.0% | +1.788 | -4.534 | +0.208 | 1.18 | +4.2 | 17.2 | 1.9 |
| RELEASED + OPPOSED | 55 | 61.8% | +1.757 | -1.678 | +0.446 | 1.70 | +24.5 | 8.6 | 5.2 |
| SQUEEZE_ON + ALIGNED | 36 | 50.0% | +1.808 | -2.732 | -0.462 | 0.66 | -16.6 | 27.1 | 3.4 |
| SQUEEZE_ON + OPPOSED | 43 | 53.5% | +1.792 | -2.310 | -0.116 | 0.89 | -5.0 | 11.4 | 4.1 |
| MOMENTUM RISING | 262 | 58.4% | +1.791 | -1.986 | +0.220 | 1.27 | +57.6 | 23.0 | 25.0 |
| MOMENTUM FALLING | 282 | 62.1% | +1.761 | -2.413 | +0.177 | 1.19 | +50.0 | 29.2 | 26.9 |

### BY INSTRUMENT — USD/JPY

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 266 | 60.9% | +1.855 | -1.989 | +0.352 | 1.45 | +93.7 | 17.0 | 25.3 |
| SQUEEZE_ON at entry | 52 | 61.5% | +1.856 | -1.980 | +0.381 | 1.50 | +19.8 | 12.9 | 5.0 |
| RELEASED_SAME_BAR ⚠ too small for inference | 6 | 66.7% | +1.878 | -1.628 | +0.709 | 2.31 | +4.3 | 2.1 | 0.6 |
| RELEASED_1_BAR_AGO ⚠ too small for inference | 8 | 37.5% | +1.883 | -1.969 | -0.525 | 0.57 | -4.2 | 5.9 | 0.8 |
| RELEASED_2_TO_3_BARS_AGO ⚠ too small for inference | 12 | 58.3% | +1.857 | -1.646 | +0.398 | 1.58 | +4.8 | 4.3 | 1.1 |
| RECENTLY_RELEASED (0-3) ⚠ small sample | 26 | 53.8% | +1.868 | -1.778 | +0.186 | 1.23 | +4.8 | 6.8 | 2.5 |
| NO_RECENT_SQUEEZE | 188 | 61.7% | +1.854 | -2.026 | +0.368 | 1.47 | +69.1 | 13.9 | 17.9 |
| ALIGNED_MOMENTUM | 104 | 61.5% | +1.837 | -1.921 | +0.392 | 1.53 | +40.8 | 21.3 | 9.9 |
| OPPOSED_MOMENTUM | 162 | 60.5% | +1.867 | -2.031 | +0.327 | 1.41 | +53.0 | 19.1 | 15.4 |
| RELEASED + ALIGNED ⚠ too small for inference | 9 | 55.6% | +1.872 | -2.089 | +0.111 | 1.12 | +1.0 | 4.5 | 0.9 |
| RELEASED + OPPOSED ⚠ small sample | 17 | 52.9% | +1.867 | -1.622 | +0.225 | 1.29 | +3.8 | 4.3 | 1.6 |
| SQUEEZE_ON + ALIGNED ⚠ small sample | 18 | 66.7% | +1.831 | -2.369 | +0.431 | 1.55 | +7.8 | 4.1 | 1.7 |
| SQUEEZE_ON + OPPOSED | 34 | 58.8% | +1.872 | -1.814 | +0.354 | 1.47 | +12.0 | 10.5 | 3.2 |
| MOMENTUM RISING | 137 | 62.0% | +1.859 | -1.824 | +0.461 | 1.67 | +63.2 | 10.6 | 13.0 |
| MOMENTUM FALLING | 129 | 59.7% | +1.852 | -2.154 | +0.237 | 1.27 | +30.6 | 11.9 | 12.3 |

### BY INSTRUMENT — BTC/USD

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 222 | 65.3% | +1.201 | -2.173 | +0.031 | 1.04 | +6.9 | 33.2 | 21.1 |
| SQUEEZE_ON at entry ⚠ too small for inference | 14 | 64.3% | +1.097 | -2.141 | -0.059 | 0.92 | -0.8 | 7.0 | 1.3 |
| RELEASED_SAME_BAR ⚠ too small for inference | 6 | 66.7% | +1.264 | -1.569 | +0.320 | 1.61 | +1.9 | 2.6 | 0.6 |
| RELEASED_1_BAR_AGO ⚠ too small for inference | 3 | 100.0% | +1.404 | +0.000 | +1.404 | ∞ | +4.2 | 0.0 | 0.3 |
| RELEASED_2_TO_3_BARS_AGO ⚠ too small for inference | 7 | 57.1% | +1.153 | -2.482 | -0.405 | 0.62 | -2.8 | 4.6 | 0.7 |
| RECENTLY_RELEASED (0-3) ⚠ small sample | 16 | 68.8% | +1.262 | -2.117 | +0.206 | 1.31 | +3.3 | 4.6 | 1.5 |
| NO_RECENT_SQUEEZE | 192 | 65.1% | +1.204 | -2.180 | +0.023 | 1.03 | +4.4 | 34.7 | 18.3 |
| ALIGNED_MOMENTUM | 93 | 68.8% | +1.248 | -2.052 | +0.219 | 1.34 | +20.4 | 8.6 | 8.9 |
| OPPOSED_MOMENTUM | 129 | 62.8% | +1.165 | -2.246 | -0.104 | 0.88 | -13.5 | 26.7 | 12.3 |
| RELEASED + ALIGNED ⚠ too small for inference | 3 | 66.7% | +1.730 | -3.514 | -0.018 | 0.98 | -0.1 | 3.5 | 0.3 |
| RELEASED + OPPOSED ⚠ too small for inference | 13 | 69.2% | +1.158 | -1.768 | +0.258 | 1.47 | +3.3 | 3.9 | 1.2 |
| SQUEEZE_ON + ALIGNED ⚠ too small for inference | 7 | 57.1% | +1.046 | -2.232 | -0.359 | 0.62 | -2.5 | 5.5 | 0.7 |
| SQUEEZE_ON + OPPOSED ⚠ too small for inference | 7 | 71.4% | +1.139 | -2.006 | +0.240 | 1.42 | +1.7 | 2.5 | 0.7 |
| MOMENTUM RISING | 95 | 61.1% | +1.333 | -2.417 | -0.128 | 0.86 | -12.1 | 30.3 | 9.0 |
| MOMENTUM FALLING | 127 | 68.5% | +1.114 | -1.948 | +0.150 | 1.24 | +19.0 | 11.3 | 12.1 |

### INSTRUMENT × TIMEFRAME — EUR/USD 1H (n=427)

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 427 | 60.9% | +1.751 | -2.187 | +0.211 | 1.25 | +90.1 | 24.7 |  |
| SQUEEZE_ON at entry | 61 | 54.1% | +1.780 | -2.631 | -0.245 | 0.80 | -14.9 | 31.7 |  |
| RELEASED_SAME_BAR ⚠ small sample | 15 | 73.3% | +1.744 | -1.917 | +0.768 | 2.50 | +11.5 | 2.8 |  |
| RELEASED_1_BAR_AGO ⚠ small sample | 16 | 68.8% | +1.802 | -2.114 | +0.579 | 1.88 | +9.3 | 4.5 |  |
| RELEASED_2_TO_3_BARS_AGO | 30 | 63.3% | +1.723 | -1.565 | +0.517 | 1.90 | +15.5 | 3.1 |  |
| RECENTLY_RELEASED (0-3) | 61 | 67.2% | +1.750 | -1.772 | +0.595 | 2.02 | +36.3 | 7.2 |  |
| NO_RECENT_SQUEEZE | 305 | 61.0% | +1.746 | -2.152 | +0.225 | 1.27 | +68.8 | 24.7 |  |
| ALIGNED_MOMENTUM | 152 | 59.2% | +1.737 | -2.279 | +0.099 | 1.11 | +15.0 | 25.4 |  |
| OPPOSED_MOMENTUM | 275 | 61.8% | +1.759 | -2.133 | +0.273 | 1.34 | +75.1 | 17.1 |  |
| RELEASED + ALIGNED ⚠ too small for inference | 13 | 69.2% | +1.747 | -1.877 | +0.632 | 2.09 | +8.2 | 3.8 |  |
| RELEASED + OPPOSED | 48 | 66.7% | +1.751 | -1.746 | +0.585 | 2.01 | +28.1 | 8.6 |  |
| SQUEEZE_ON + ALIGNED ⚠ small sample | 25 | 52.0% | +1.788 | -2.953 | -0.488 | 0.66 | -12.2 | 29.1 |  |
| SQUEEZE_ON + OPPOSED | 36 | 55.6% | +1.774 | -2.389 | -0.076 | 0.93 | -2.7 | 10.3 |  |
| MOMENTUM RISING | 202 | 56.4% | +1.766 | -2.014 | +0.119 | 1.14 | +24.1 | 24.0 |  |
| MOMENTUM FALLING | 225 | 64.9% | +1.740 | -2.379 | +0.294 | 1.35 | +66.1 | 18.4 |  |

### INSTRUMENT × TIMEFRAME — EUR/USD 4H (n=117)

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 117 | 58.1% | +1.867 | -2.234 | +0.150 | 1.16 | +17.5 | 25.1 |  |
| SQUEEZE_ON at entry ⚠ small sample | 18 | 44.4% | +1.880 | -2.171 | -0.370 | 0.69 | -6.7 | 10.1 |  |
| RELEASED_SAME_BAR ⚠ too small for inference | 1 | 100.0% | +1.949 | +0.000 | +1.949 | ∞ | +1.9 | 0.0 |  |
| RELEASED_1_BAR_AGO ⚠ too small for inference | 2 | 50.0% | +1.845 | -1.556 | +0.145 | 1.19 | +0.3 | 1.6 |  |
| RELEASED_2_TO_3_BARS_AGO ⚠ too small for inference | 11 | 54.5% | +1.839 | -4.182 | -0.898 | 0.53 | -9.9 | 19.7 |  |
| RECENTLY_RELEASED (0-3) ⚠ too small for inference | 14 | 57.1% | +1.853 | -3.744 | -0.545 | 0.66 | -7.6 | 21.3 |  |
| NO_RECENT_SQUEEZE | 85 | 61.2% | +1.868 | -1.979 | +0.374 | 1.49 | +31.8 | 10.7 |  |
| ALIGNED_MOMENTUM | 52 | 65.4% | +1.867 | -2.922 | +0.210 | 1.21 | +10.9 | 22.8 |  |
| OPPOSED_MOMENTUM | 65 | 52.3% | +1.867 | -1.835 | +0.102 | 1.12 | +6.6 | 9.0 |  |
| RELEASED + ALIGNED ⚠ too small for inference | 7 | 85.7% | +1.850 | -15.161 | -0.580 | 0.73 | -4.1 | 15.2 |  |
| RELEASED + OPPOSED ⚠ too small for inference | 7 | 28.6% | +1.864 | -1.461 | -0.511 | 0.51 | -3.6 | 6.1 |  |
| SQUEEZE_ON + ALIGNED ⚠ too small for inference | 11 | 45.5% | +1.860 | -2.289 | -0.403 | 0.68 | -4.4 | 7.7 |  |
| SQUEEZE_ON + OPPOSED ⚠ too small for inference | 7 | 42.9% | +1.914 | -1.994 | -0.319 | 0.72 | -2.2 | 4.2 |  |
| MOMENTUM RISING | 60 | 65.0% | +1.866 | -1.866 | +0.560 | 1.86 | +33.6 | 4.8 |  |
| MOMENTUM FALLING | 57 | 50.9% | +1.870 | -2.510 | -0.282 | 0.77 | -16.1 | 27.9 |  |

### INSTRUMENT × TIMEFRAME — USD/JPY 1H (n=214)

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 214 | 61.7% | +1.841 | -2.006 | +0.367 | 1.48 | +78.6 | 15.2 |  |
| SQUEEZE_ON at entry | 45 | 66.7% | +1.850 | -2.078 | +0.541 | 1.78 | +24.3 | 11.2 |  |
| RELEASED_SAME_BAR ⚠ too small for inference | 5 | 80.0% | +1.878 | -2.120 | +1.078 | 3.54 | +5.4 | 2.1 |  |
| RELEASED_1_BAR_AGO ⚠ too small for inference | 6 | 33.3% | +1.858 | -2.089 | -0.773 | 0.44 | -4.6 | 5.9 |  |
| RELEASED_2_TO_3_BARS_AGO ⚠ too small for inference | 11 | 54.5% | +1.842 | -1.646 | +0.257 | 1.34 | +2.8 | 4.3 |  |
| RECENTLY_RELEASED (0-3) ⚠ small sample | 22 | 54.5% | +1.857 | -1.871 | +0.162 | 1.19 | +3.6 | 5.9 |  |
| NO_RECENT_SQUEEZE | 147 | 61.2% | +1.836 | -2.011 | +0.344 | 1.44 | +50.6 | 13.7 |  |
| ALIGNED_MOMENTUM | 89 | 62.9% | +1.833 | -1.933 | +0.437 | 1.61 | +38.9 | 18.7 |  |
| OPPOSED_MOMENTUM | 125 | 60.8% | +1.847 | -2.055 | +0.318 | 1.39 | +39.7 | 21.1 |  |
| RELEASED + ALIGNED ⚠ too small for inference | 9 | 55.6% | +1.872 | -2.089 | +0.111 | 1.12 | +1.0 | 4.5 |  |
| RELEASED + OPPOSED ⚠ too small for inference | 13 | 53.8% | +1.846 | -1.725 | +0.198 | 1.25 | +2.6 | 4.3 |  |
| SQUEEZE_ON + ALIGNED ⚠ small sample | 15 | 73.3% | +1.823 | -2.639 | +0.633 | 1.90 | +9.5 | 4.1 |  |
| SQUEEZE_ON + OPPOSED | 30 | 63.3% | +1.866 | -1.874 | +0.495 | 1.72 | +14.8 | 8.8 |  |
| MOMENTUM RISING | 109 | 63.3% | +1.846 | -1.855 | +0.488 | 1.72 | +53.1 | 10.6 |  |
| MOMENTUM FALLING | 105 | 60.0% | +1.837 | -2.150 | +0.242 | 1.28 | +25.4 | 8.9 |  |

### INSTRUMENT × TIMEFRAME — USD/JPY 4H (n=52)

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 52 | 57.7% | +1.918 | -1.925 | +0.292 | 1.36 | +15.2 | 9.2 |  |
| SQUEEZE_ON at entry ⚠ too small for inference | 7 | 28.6% | +1.944 | -1.688 | -0.650 | 0.46 | -4.6 | 6.5 |  |
| RELEASED_SAME_BAR ⚠ too small for inference | 1 | 0.0% | +0.000 | -1.136 | -1.136 | 0.00 | -1.1 | 1.1 |  |
| RELEASED_1_BAR_AGO ⚠ too small for inference | 2 | 50.0% | +1.932 | -1.490 | +0.221 | 1.30 | +0.4 | 1.5 |  |
| RELEASED_2_TO_3_BARS_AGO ⚠ too small for inference | 1 | 100.0% | +1.947 | +0.000 | +1.947 | ∞ | +1.9 | 0.0 |  |
| RECENTLY_RELEASED (0-3) ⚠ too small for inference | 4 | 50.0% | +1.939 | -1.313 | +0.313 | 1.48 | +1.3 | 2.6 |  |
| NO_RECENT_SQUEEZE | 41 | 63.4% | +1.914 | -2.086 | +0.451 | 1.59 | +18.5 | 7.5 |  |
| ALIGNED_MOMENTUM ⚠ small sample | 15 | 53.3% | +1.868 | -1.865 | +0.126 | 1.14 | +1.9 | 9.4 |  |
| OPPOSED_MOMENTUM | 37 | 59.5% | +1.936 | -1.953 | +0.359 | 1.45 | +13.3 | 7.1 |  |
| RELEASED + ALIGNED | 0 | | | | | | | | |
| RELEASED + OPPOSED ⚠ too small for inference | 4 | 50.0% | +1.939 | -1.313 | +0.313 | 1.48 | +1.3 | 2.6 |  |
| SQUEEZE_ON + ALIGNED ⚠ too small for inference | 3 | 33.3% | +1.911 | -1.827 | -0.581 | 0.52 | -1.7 | 3.7 |  |
| SQUEEZE_ON + OPPOSED ⚠ too small for inference | 4 | 25.0% | +1.977 | -1.595 | -0.702 | 0.41 | -2.8 | 3.1 |  |
| MOMENTUM RISING ⚠ small sample | 28 | 57.1% | +1.917 | -1.719 | +0.359 | 1.49 | +10.0 | 6.2 |  |
| MOMENTUM FALLING ⚠ small sample | 24 | 58.3% | +1.919 | -2.173 | +0.214 | 1.24 | +5.1 | 7.6 |  |

### INSTRUMENT × TIMEFRAME — BTC/USD 1H (n=182)

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 182 | 65.4% | +1.146 | -2.248 | -0.029 | 0.96 | -5.2 | 42.2 |  |
| SQUEEZE_ON at entry ⚠ too small for inference | 13 | 69.2% | +1.097 | -2.384 | +0.026 | 1.04 | +0.3 | 7.0 |  |
| RELEASED_SAME_BAR ⚠ too small for inference | 6 | 66.7% | +1.264 | -1.569 | +0.320 | 1.61 | +1.9 | 2.6 |  |
| RELEASED_1_BAR_AGO ⚠ too small for inference | 3 | 100.0% | +1.404 | +0.000 | +1.404 | ∞ | +4.2 | 0.0 |  |
| RELEASED_2_TO_3_BARS_AGO ⚠ too small for inference | 7 | 57.1% | +1.153 | -2.482 | -0.405 | 0.62 | -2.8 | 4.6 |  |
| RECENTLY_RELEASED (0-3) ⚠ small sample | 16 | 68.8% | +1.262 | -2.117 | +0.206 | 1.31 | +3.3 | 4.6 |  |
| NO_RECENT_SQUEEZE | 153 | 64.7% | +1.138 | -2.250 | -0.058 | 0.93 | -8.9 | 41.0 |  |
| ALIGNED_MOMENTUM | 76 | 71.1% | +1.191 | -2.203 | +0.208 | 1.33 | +15.8 | 10.6 |  |
| OPPOSED_MOMENTUM | 106 | 61.3% | +1.110 | -2.272 | -0.198 | 0.77 | -21.0 | 34.3 |  |
| RELEASED + ALIGNED ⚠ too small for inference | 3 | 66.7% | +1.730 | -3.514 | -0.018 | 0.98 | -0.1 | 3.5 |  |
| RELEASED + OPPOSED ⚠ too small for inference | 13 | 69.2% | +1.158 | -1.768 | +0.258 | 1.47 | +3.3 | 3.9 |  |
| SQUEEZE_ON + ALIGNED ⚠ too small for inference | 6 | 66.7% | +1.046 | -2.763 | -0.224 | 0.76 | -1.3 | 5.5 |  |
| SQUEEZE_ON + OPPOSED ⚠ too small for inference | 7 | 71.4% | +1.139 | -2.006 | +0.240 | 1.42 | +1.7 | 2.5 |  |
| MOMENTUM RISING | 79 | 59.5% | +1.295 | -2.544 | -0.260 | 0.75 | -20.6 | 34.0 |  |
| MOMENTUM FALLING | 103 | 69.9% | +1.050 | -1.943 | +0.149 | 1.25 | +15.3 | 11.5 |  |

### INSTRUMENT × TIMEFRAME — BTC/USD 4H (n=40)

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CONTROL | 40 | 65.0% | +1.454 | -1.836 | +0.303 | 1.47 | +12.1 | 5.7 |  |
| SQUEEZE_ON at entry ⚠ too small for inference | 1 | 0.0% | +0.000 | -1.169 | -1.169 | 0.00 | -1.2 | 1.2 |  |
| RELEASED_SAME_BAR | 0 | | | | | | | | |
| RELEASED_1_BAR_AGO | 0 | | | | | | | | |
| RELEASED_2_TO_3_BARS_AGO | 0 | | | | | | | | |
| RECENTLY_RELEASED (0-3) | 0 | | | | | | | | |
| NO_RECENT_SQUEEZE | 39 | 66.7% | +1.454 | -1.887 | +0.340 | 1.54 | +13.3 | 5.7 |  |
| ALIGNED_MOMENTUM ⚠ small sample | 17 | 58.8% | +1.557 | -1.576 | +0.267 | 1.41 | +4.5 | 2.4 |  |
| OPPOSED_MOMENTUM ⚠ small sample | 23 | 69.6% | +1.389 | -2.095 | +0.329 | 1.52 | +7.6 | 5.9 |  |
| RELEASED + ALIGNED | 0 | | | | | | | | |
| RELEASED + OPPOSED | 0 | | | | | | | | |
| SQUEEZE_ON + ALIGNED ⚠ too small for inference | 1 | 0.0% | +0.000 | -1.169 | -1.169 | 0.00 | -1.2 | 1.2 |  |
| SQUEEZE_ON + OPPOSED | 0 | | | | | | | | |
| MOMENTUM RISING ⚠ small sample | 16 | 68.8% | +1.497 | -1.604 | +0.528 | 2.05 | +8.4 | 2.4 |  |
| MOMENTUM FALLING ⚠ small sample | 24 | 62.5% | +1.422 | -1.964 | +0.152 | 1.21 | +3.7 | 6.5 |  |
