# IPO_MARKET_CONTEXT_TELEMETRY_V1

**Telemetry / cohort study — discovery only.** Not a strategy change, not a filter, not an optimisation.
Research only: production IPO logic unchanged, nothing deployed, no trade filtered.

**Question:** does real FX market context, known before entry, separate stronger and weaker IPO trades?

## M. FINAL VERDICT (up front)

# NO ROBUST MARKET-CONTEXT FILTER FOUND

- **FX (EUR/USD + USD/JPY, n=810):** 58 predefined cohorts were tested. 5 reached raw p < .05, about what
  chance alone predicts (≈2.9). After correction, **0 survive Holm and 0 survive Benjamini-Hochberg at
  q ≤ 0.10**. No cohort meets the frozen candidate criteria.
- **BTC/USD (n=222, reported separately):** 0 of 21 cohorts reach even raw p < .05.
- **News:** `NEWS_CONTEXT_UNAVAILABLE`. There is no reliable historical economic calendar, so no news study
  was fabricated.

The strongest lead, the London/NY overlap, is described in §K. It fails correction, and its effect is
**absent in the 2022-era window**.

---

## A. CONTROL RECONSTRUCTION

The control is `IPO_BASELINE_1H_4H_CAUSAL_V1`, ARM C (1H+4H, shared instrument slot), taken as the
committed trade list `docs/exports/ipo_1h_4h_combined_clean.csv`. This is the same accepted
frozen-trade tagging approach as `IPO_TTM_SQUEEZE_TELEMETRY_V1`.

| | frozen | reproduced |
|---|---:|---:|
| n | 1,032 | 1,032 |
| WR | 61.5% | 61.5% |
| expectancy | +0.202R | +0.202R |
| PF | 1.25 | 1.25 |
| net | +208.3R | +208.3R |
| max DD — **file order** (frozen convention) | 41.3R | 41.3R |
| max DD — **true chronological** | — | **45.6R** |

- **Drawdown conventions:** the frozen baseline's published 41.3R used window-major file order, and it is
  left unchanged as a historical figure. The true chronological drawdown of the same trades is
  **45.6R**. **Every new drawdown in this study is chronological.**
- **Per-trade data-equivalence gate: 1,032 / 1,032 pass.** For each trade:
  - its IPO candle is byte-identical in the re-fetched series;
  - its entry bar exists and reaches the entry price;
  - the entry comes after the IPO candle;
  - the 1m fill falls inside the touch bar.
- **The study stops if any of these fail,** or if any control figure fails to reproduce.
- **The original frozen inputs cannot be rebuilt exactly.** They lived in `/tmp`. See
  `IPO_TTM_SQUEEZE_TELEMETRY_V1` §1 for why tagging is equivalent here.

## B. DATA / CAUSALITY

**Decision instant D = the trade's 1m fill minute** (`m1_entry_time`).
- **Timestamp features** depend on D alone.
- **Bar features** use only bars that had closed by D:
  - **own timeframe:** the bars strictly before the touch bar (the engine's own `barsBefore` prefix);
  - **1H context**, for both 1H and 4H trades: 1H bars whose close ≤ D.
- **The 1H bar containing D is still forming.** It contributes only its *open*, which is known from the
  bar's first tick.

**DST.** All wall clocks come from the IANA tz database through ICU, which Deno ships. Nothing is
hand-written. Zones: `Europe/London` and `America/New_York`. Tests pin real 2025 transition dates,
including the mismatch weeks when the US has changed its clocks and the UK has not.

**Definitions, all frozen before the first run:**

| Feature | Definition |
|---|---|
| UTC windows | 00–05, 06–07, 08–11, 12–15, 16–19, 20–23 |
| Sessions (DST-aware, first match wins) | LONDON_NY_OVERLAP = inside London 08:00–17:00 *and* NY 08:00–17:00 local · LATE_NY_ROLLOVER = NY 16:00–19:00 · LONDON = London session only · NEW_YORK = NY session only · ASIA = everything else |
| Session timing | Minutes from London open/close (08:00/17:00 London) and NY open/close (08:00/17:00 NY), each on its own local date |
| London fix | WM/Reuters 16:00 `Europe/London`. Fix window ±2.5 min (the post-2015 five-minute window). Nine fixed buckets, as specified. Timing only, with no directional assumption. |
| Rollover | 17:00 `America/New_York`. Minutes to the next rollover and since the previous one. Within 15 before, within 15 after, within 30, within 60, outside 60. |
| Trading day | FX: 17:00 NY to 17:00 NY (the FX convention). BTC: the UTC day. "Previous day" means the most recent **completed** trading day that has data, so weekends are skipped. |
| Volatility (own timeframe) | Wilder ATR(14). ATR percentile over the trailing 100 and 252 bars. Last closed bar range / ATR. RV20 = population stdev of 20 log returns, with its trailing 100-bar percentile. Prior session range and prior-day range / ATR. **Regime from the 100-bar trailing ATR percentile:** LOW ≤ 25th, HIGH ≥ 75th, otherwise NORMAL. Trailing only, never full-sample; percentiles return null when history is short rather than falling back to the full sample. |
| Price location | Entry price versus day open, prior-day high/low/close, session open, and session high/low-so-far (closed 1H bars only), each divided by own-timeframe ATR. Near = ≤ 0.25 ATR. Inside / above prior-day high / below prior-day low. |

**Causality tests:** `supabase/tests/_shared/marketContext.test.ts`, 14 tests, run in CI. They prove
that:
- changing any future bar alters no feature;
- the forming bar contributes nothing to session high/low;
- prior-day values come only from the completed previous day;
- ATR, RV and percentiles are trailing-only (prefix invariance);
- fix, rollover and session context depend only on the timestamp;
- no production function imports the module.

**Planted look-ahead and DST bugs, each caught by the intended test:**

| Planted bug | Caught by |
|---|---|
| Percentile over a centred window | The trailing-only / prefix-invariance test |
| A "previous day" that includes the current day | The completed-previous-day test |
| The fix on a fixed UTC clock (no DST) | The fix test |
| The forming bar's high/low entering session high/low | The forming-bar test |

One plant first aimed at a redundant shared filter. With that filter removed, the forming bar still
could not reach any feature, because each consumer applies its own closed-bar filter.

**News, Part 7: `NEWS_CONTEXT_UNAVAILABLE`.**
- No table holds a calendar (`economic_events`, `news_events`, `calendar_events` and
  `fundamentals_cache` all return PostgREST `PGRST205`).
- The only feed in code (ForexFactory `ff_calendar_thisweek.json`) covers the current week only.
- The TwelveData plan has no calendar endpoint (HTTP 404).

No current calendar was used to infer old events, and the news-audit CSV is therefore not produced.
A news study needs a licensed historical calendar with timestamps, currency, impact and
actual/forecast/previous values.

## C–H. RESULTS

The full cohort tables are below and in `docs/exports/ipo_market_context_cohorts_v1.csv`. Summary
for FX, the primary population: **n=810, +0.249R baseline (WR 60.5%, PF 1.30, net +201.4R, chronological DD 37.2R).** BTC/USD separately: n=222, +0.031R.

**C. Session.**
- **Overlap** is the standout: **+0.585R**, n=194, PF 1.90. Δ +0.442 vs the rest, raw p 0.008,
  Holm 0.476, BH q 0.261.
- London +0.341R (REVERSES on USD/JPY) · Asia +0.072R · New York −0.012R · Late NY +0.195R (n=56).
- Overlap good, NY and Asia weak: a coherent-looking pattern that **does not survive correction**.

**D. London fix.** The fix window is n=13, and every bucket within 120 minutes of the fix has n ≤ 49.
**No inference is possible.** The only bucket with a usable sample, ">120 min before" (n=478), is flat
(Δ −0.097).

**E. Rollover.** n=1 within 15 min before, n=13 within 15 after, n=45 within 60. **Too small.**
"Outside 60 min" (n=765) is essentially the whole population, and it REVERSES between EUR and JPY.

**F. Volatility regime.** LOW +0.185R · NORMAL +0.240R · HIGH +0.321R. A mild monotone gradient, but
**every regime REVERSES on USD/JPY**, and the best p is 0.51. There is no volatility effect.

**G. Price location.**
- **Near the daily open is the strongest negative lead:** −0.234R, n=94, Δ −0.546, raw p 0.017,
  BH q 0.321. It **REVERSES** on USD/JPY (+0.11, n=35). On EUR/USD it is −0.94 (n=59).
- Outside vs inside the prior-day range: ±0.151, REVERSES.
- Below the prior-day low: +0.432R (n=176, STABLE), but p 0.18.

**H. News.** `NEWS_CONTEXT_UNAVAILABLE`.

## I. STABILITY ACROSS INSTRUMENT / TIMEFRAME / WINDOW

**Labels (frozen):** within each slice, compare the cohort's expectancy with the rest of that slice.
- **TOO_SMALL:** combined n < 30, or fewer than 4 slices with n ≥ 15.
- **REVERSES:** a slice with n ≥ 30 has the opposite sign.
- **STABLE:** every evaluable slice (n ≥ 15) shares the sign.
- **MIXED:** otherwise.

**FX counts:** STABLE 8 · MIXED 2 · REVERSES 17 · TOO_SMALL 32. The full table is below and in
`docs/exports/ipo_market_context_stability_v1.csv`.

**What STABLE means here needs care.** The overlap is labelled STABLE, but its 2022-window Δ is
**+0.02** (n=46). Its fixed-UTC twin, 12:00–15:59, sits at **−0.03** (n=45) and is labelled REVERSES.
Both are effectively **zero in 2022**: the effect lives entirely in the 2025 window. The label is
mechanically correct and substantively a knife-edge.

## J. MULTIPLE-TESTING RESULTS

The FX family has 58 cohorts. Corrections are Holm (family-wise) and Benjamini-Hochberg (FDR).

| Lowest raw p | n | Exp R | Δ vs rest | raw p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---|
| LONDON_NY_OVERLAP | 194 | +0.585 | +0.442 | 0.008 | 0.476 | 0.261 | STABLE (knife-edge) |
| UTC 12:00–15:59 | 191 | +0.593 | +0.451 | 0.009 | 0.513 | 0.261 | REVERSES |
| NEAR DAY OPEN | 94 | −0.234 | −0.546 | 0.017 | 0.930 | 0.321 | REVERSES |
| HOUR 11 | 35 | +0.940 | +0.722 | 0.043 | 1.000 | 0.524 | TOO_SMALL |
| HOUR 15 | 47 | +0.820 | +0.606 | 0.050 | 1.000 | 0.524 | TOO_SMALL |

**No raw p-value survives correction.** The overlap and the UTC 12–16 window are near-duplicates of the
same hours, so they are not independent evidence.

## K. CANDIDATES WORTH OOS TESTING

**None meet the frozen criteria:** n ≥ 60, |Δ| ≥ 0.15R, STABLE, and BH q ≤ 0.10.

The closest is the **London/NY overlap.** It meets every bar except the decisive one: correction (BH q
0.261). It also has a plausible mechanism, peak FX liquidity. **But its effect is zero in the
2022-era window** and lives entirely in 2025. Your §12 says not to recommend the best-looking cohort,
so it is **not** proposed as a rule.

If it is pursued at all, it should be as passive forward observation, not a filter. Tag live IPO
trades with the session label and revisit once a few hundred unseen FX trades exist. Note that unseen
IPO history is nearly exhausted.

## L. CANDIDATES REJECTED

| Cohort | Why rejected |
|---|---|
| UTC 12:00–15:59 | Duplicate hours of the overlap, and REVERSES in 2022 |
| Near daily open | Raw p 0.017, but fails correction (BH 0.321) and REVERSES (USD/JPY +0.11) |
| London session | REVERSES (EUR +0.26, JPY −0.17) |
| Asia / New York | STABLE, negative, but p 0.12 / 0.10 and fail correction |
| Volatility regimes | All REVERSE, and all p > 0.5 |
| Below prior-day low | STABLE, but p 0.18 |
| Every London-fix and rollover bucket near the anchors | Too small (n ≤ 49) |
| Individual UTC hours | 24 cells of ~34 trades each: TOO_SMALL, and the largest single source of false positives |
| BTC/USD, every cohort | 0 of 21 at raw p < .05. Not pooled into any FX conclusion. |

## M. FINAL VERDICT

**NO ROBUST MARKET-CONTEXT FILTER FOUND.** No preregistered rule is proposed, and no second filtered
backtest is warranted.

---

### Artefacts

- `docs/exports/ipo_market_context_telemetry_v1.csv` — 1,032 trades × 60 columns (trade, net R, every feature)
- `docs/exports/ipo_market_context_cohorts_v1.csv` — every cohort: stats, CI, raw/Holm/BH p, stability, candidate flag
- `docs/exports/ipo_market_context_stability_v1.csv` — per-slice n and Δ for every FX cohort
- `local-runner/marketContext.ts` — the frozen feature definitions (pure)
- `local-runner/ipo-market-context-telemetry.ts` — gate, features, cohorts, inference, exports
- `supabase/tests/_shared/marketContext.test.ts` — DST and causality tests

Reproduce:
`deno run --allow-net --allow-read --allow-write local-runner/ipo-ttm-fetch.ts && deno run --allow-read --allow-write local-runner/ipo-market-context-telemetry.ts`

---

## Full tables

FX control (EUR/USD + USD/JPY): n=810, WR 60.5%, exp +0.249, PF 1.30, net 201.4, chron DD 37.2

BTC control: n=222, WR 65.3%, exp +0.031, PF 1.04, net 6.9, chron DD 33.2

#### FX — UTC_HOUR

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| HOUR_00 | 39 | 53.8% | +1.841 | -2.296 | -0.068 | 0.94 | -2.7 | 11.8 | -0.333 | 0.323 | 1.000 | 0.813 | STABLE |
| HOUR_01 ⚠ | 28 | 39.3% | +1.880 | -1.707 | -0.298 | 0.71 | -8.3 | 15.2 | -0.566 | 0.158 | 1.000 | 0.761 | TOO_SMALL |
| HOUR_02 ⚠ | 26 | 57.7% | +1.784 | -1.571 | +0.365 | 1.55 | +9.5 | 5.1 | +0.120 | 0.772 | 1.000 | 0.932 | TOO_SMALL |
| HOUR_03 ⚠ | 18 | 50.0% | +1.731 | -2.335 | -0.302 | 0.74 | -5.4 | 11.1 | -0.563 | 0.259 | 1.000 | 0.787 | TOO_SMALL |
| HOUR_04 ⚠ | 25 | 52.0% | +1.802 | -1.844 | +0.052 | 1.06 | +1.3 | 7.7 | -0.203 | 0.627 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_05 ⚠ | 28 | 57.1% | +1.798 | -2.315 | +0.035 | 1.04 | +1.0 | 8.0 | -0.221 | 0.580 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_06 | 47 | 66.0% | +1.801 | -2.658 | +0.283 | 1.31 | +13.3 | 18.6 | +0.036 | 0.917 | 1.000 | 0.958 | REVERSES |
| HOUR_07 | 36 | 63.9% | +1.807 | -2.027 | +0.423 | 1.58 | +15.2 | 5.6 | +0.182 | 0.610 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_08 | 42 | 54.8% | +1.759 | -1.825 | +0.137 | 1.17 | +5.8 | 12.0 | -0.117 | 0.717 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_09 | 46 | 60.9% | +1.766 | -2.775 | -0.011 | 0.99 | -0.5 | 17.2 | -0.275 | 0.379 | 1.000 | 0.878 | TOO_SMALL |
| HOUR_10 ⚠ | 26 | 61.5% | +1.721 | -2.466 | +0.110 | 1.12 | +2.9 | 9.6 | -0.143 | 0.735 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_11 | 35 | 80.0% | +1.821 | -2.586 | +0.940 | 2.82 | +32.9 | 8.6 | +0.722 | 0.043 | 1.000 | 0.524 | TOO_SMALL |
| HOUR_12 | 55 | 74.5% | +1.793 | -3.137 | +0.538 | 1.67 | +29.6 | 16.5 | +0.310 | 0.284 | 1.000 | 0.787 | STABLE |
| HOUR_13 | 51 | 62.7% | +1.777 | -1.833 | +0.432 | 1.63 | +22.0 | 10.3 | +0.196 | 0.511 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_14 | 38 | 68.4% | +1.809 | -1.993 | +0.608 | 1.97 | +23.1 | 5.7 | +0.377 | 0.281 | 1.000 | 0.787 | TOO_SMALL |
| HOUR_15 | 47 | 70.2% | +1.801 | -1.493 | +0.820 | 2.84 | +38.5 | 4.1 | +0.606 | 0.050 | 1.000 | 0.524 | TOO_SMALL |
| HOUR_16 | 40 | 52.5% | +1.797 | -1.801 | +0.088 | 1.10 | +3.5 | 14.6 | -0.169 | 0.612 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_17 | 42 | 59.5% | +1.840 | -2.242 | +0.188 | 1.21 | +7.9 | 10.4 | -0.064 | 0.848 | 1.000 | 0.958 | TOO_SMALL |
| HOUR_18 | 35 | 60.0% | +1.820 | -2.283 | +0.179 | 1.20 | +6.3 | 10.4 | -0.073 | 0.839 | 1.000 | 0.958 | TOO_SMALL |
| HOUR_19 ⚠ | 24 | 45.8% | +1.801 | -2.521 | -0.541 | 0.60 | -13.0 | 25.1 | -0.813 | 0.060 | 1.000 | 0.524 | TOO_SMALL |
| HOUR_20 | 31 | 58.1% | +1.886 | -1.561 | +0.441 | 1.67 | +13.7 | 6.6 | +0.200 | 0.602 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_21 ⚠⚠ | 14 | 71.4% | +1.806 | -2.703 | +0.518 | 1.67 | +7.3 | 6.7 | +0.274 | 0.615 | 1.000 | 0.907 | TOO_SMALL |
| HOUR_22 ⚠ | 18 | 44.4% | +1.775 | -2.035 | -0.342 | 0.70 | -6.2 | 13.0 | -0.604 | 0.214 | 1.000 | 0.787 | TOO_SMALL |
| HOUR_23 ⚠ | 19 | 52.6% | +1.837 | -1.621 | +0.199 | 1.26 | +3.8 | 4.5 | -0.051 | 0.918 | 1.000 | 0.958 | TOO_SMALL |

#### FX — UTC_WINDOW

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| UTC_00:00-05:59 | 164 | 51.8% | +1.810 | -2.007 | -0.028 | 0.97 | -4.7 | 18.5 | -0.347 | 0.063 | 1.000 | 0.524 | REVERSES |
| UTC_06:00-07:59 | 83 | 65.1% | +1.803 | -2.375 | +0.343 | 1.41 | +28.5 | 18.1 | +0.106 | 0.663 | 1.000 | 0.907 | REVERSES |
| UTC_08:00-11:59 | 149 | 63.8% | +1.773 | -2.359 | +0.275 | 1.32 | +41.0 | 22.0 | +0.033 | 0.867 | 1.000 | 0.958 | REVERSES |
| UTC_12:00-15:59 | 191 | 69.1% | +1.794 | -2.094 | +0.593 | 1.92 | +113.3 | 21.1 | +0.451 | 0.009 | 0.513 | 0.261 | REVERSES |
| UTC_16:00-19:59 | 141 | 55.3% | +1.818 | -2.176 | +0.033 | 1.03 | +4.7 | 45.9 | -0.261 | 0.177 | 1.000 | 0.761 | STABLE |
| UTC_20:00-23:59 | 82 | 56.1% | +1.839 | -1.834 | +0.226 | 1.28 | +18.5 | 11.1 | -0.025 | 0.916 | 1.000 | 0.958 | REVERSES |

#### FX — SESSION

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| ASIA | 236 | 55.5% | +1.811 | -2.098 | +0.072 | 1.08 | +16.9 | 20.2 | -0.250 | 0.117 | 1.000 | 0.641 | STABLE |
| LONDON | 181 | 64.6% | +1.775 | -2.279 | +0.341 | 1.42 | +61.8 | 20.2 | +0.119 | 0.506 | 1.000 | 0.907 | REVERSES |
| LONDON_NY_OVERLAP | 194 | 68.6% | +1.799 | -2.062 | +0.585 | 1.90 | +113.4 | 21.1 | +0.442 | 0.008 | 0.476 | 0.261 | STABLE |
| NEW_YORK | 143 | 53.8% | +1.825 | -2.154 | -0.012 | 0.99 | -1.7 | 45.9 | -0.316 | 0.100 | 1.000 | 0.641 | STABLE |
| LATE_NY_ROLLOVER | 56 | 57.1% | +1.822 | -1.976 | +0.195 | 1.23 | +10.9 | 11.3 | -0.058 | 0.842 | 1.000 | 0.958 | REVERSES |

#### FX — LONDON_FIX

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| FIX >120 before | 478 | 60.7% | +1.793 | -2.234 | +0.209 | 1.24 | +99.9 | 35.7 | -0.097 | 0.520 | 1.000 | 0.907 | REVERSES |
| FIX 60-120 before | 42 | 64.3% | +1.804 | -1.749 | +0.535 | 1.86 | +22.5 | 10.3 | +0.302 | 0.360 | 1.000 | 0.871 | TOO_SMALL |
| FIX 30-60 before ⚠ | 28 | 75.0% | +1.810 | -2.042 | +0.847 | 2.66 | +23.7 | 3.4 | +0.620 | 0.122 | 1.000 | 0.641 | TOO_SMALL |
| FIX 0-30 before ⚠ | 25 | 64.0% | +1.805 | -1.741 | +0.528 | 1.84 | +13.2 | 4.5 | +0.288 | 0.493 | 1.000 | 0.907 | TOO_SMALL |
| FIX fix window ⚠⚠ | 13 | 69.2% | +1.840 | -1.349 | +0.859 | 3.07 | +11.2 | 2.8 | +0.620 | 0.280 | 1.000 | 0.787 | TOO_SMALL |
| FIX 0-30 after ⚠ | 15 | 80.0% | +1.797 | -1.342 | +1.169 | 5.36 | +17.5 | 2.7 | +0.938 | 0.083 | 1.000 | 0.600 | TOO_SMALL |
| FIX 30-60 after ⚠ | 18 | 50.0% | +1.800 | -1.640 | +0.080 | 1.10 | +1.4 | 4.5 | -0.172 | 0.724 | 1.000 | 0.907 | TOO_SMALL |
| FIX 60-120 after | 49 | 55.1% | +1.794 | -2.109 | +0.042 | 1.04 | +2.0 | 12.2 | -0.220 | 0.472 | 1.000 | 0.907 | TOO_SMALL |
| FIX >120 after | 142 | 55.6% | +1.832 | -2.139 | +0.070 | 1.07 | +9.9 | 29.9 | -0.217 | 0.265 | 1.000 | 0.787 | STABLE |

#### FX — ROLLOVER

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| ROLLOVER within 15 before ⚠⚠ | 1 | 0.0% | +0.000 | -1.952 | -1.952 | 0.00 | -2.0 | 2.0 | -2.204 |  |  |  | TOO_SMALL |
| ROLLOVER within 15 after ⚠⚠ | 13 | 61.5% | +1.792 | -2.213 | +0.252 | 1.30 | +3.3 | 6.1 | +0.003 | 0.996 | 1.000 | 0.996 | TOO_SMALL |
| ROLLOVER within 30 ⚠ | 21 | 66.7% | +1.783 | -2.048 | +0.506 | 1.74 | +10.6 | 5.6 | +0.264 | 0.571 | 1.000 | 0.907 | TOO_SMALL |
| ROLLOVER within 60 | 45 | 62.2% | +1.826 | -2.038 | +0.366 | 1.48 | +16.5 | 9.2 | +0.125 | 0.706 | 1.000 | 0.907 | TOO_SMALL |
| ROLLOVER outside 60 | 765 | 60.4% | +1.800 | -2.135 | +0.242 | 1.29 | +184.9 | 37.0 | -0.125 | 0.695 | 1.000 | 0.907 | REVERSES |

#### FX — VOLATILITY

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| VOL LOW | 239 | 61.1% | +1.802 | -2.354 | +0.185 | 1.20 | +44.2 | 22.6 | -0.090 | 0.577 | 1.000 | 0.907 | REVERSES |
| VOL NORMAL | 322 | 59.0% | +1.789 | -1.990 | +0.240 | 1.29 | +77.3 | 16.7 | -0.014 | 0.925 | 1.000 | 0.958 | REVERSES |
| VOL HIGH | 249 | 61.8% | +1.817 | -2.105 | +0.321 | 1.40 | +79.9 | 17.1 | +0.104 | 0.508 | 1.000 | 0.907 | REVERSES |

#### FX — PRICE_LOCATION

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| NEAR PDH (<=0.25 ATR) | 53 | 64.2% | +1.837 | -2.020 | +0.454 | 1.63 | +24.1 | 7.5 | +0.220 | 0.459 | 1.000 | 0.907 | MIXED |
| NEAR PDL (<=0.25 ATR) | 48 | 62.5% | +1.830 | -2.074 | +0.366 | 1.47 | +17.6 | 13.2 | +0.125 | 0.691 | 1.000 | 0.907 | MIXED |
| NEAR DAY OPEN (<=0.25 ATR) | 94 | 56.4% | +1.815 | -2.882 | -0.234 | 0.81 | -22.0 | 32.3 | -0.546 | 0.017 | 0.930 | 0.321 | REVERSES |
| INSIDE prior-day range | 404 | 60.4% | +1.797 | -2.304 | +0.173 | 1.19 | +69.8 | 34.6 | -0.151 | 0.299 | 1.000 | 0.787 | REVERSES |
| OUTSIDE prior-day range | 406 | 60.6% | +1.807 | -1.956 | +0.324 | 1.42 | +131.6 | 33.0 | +0.151 | 0.295 | 1.000 | 0.787 | REVERSES |
| ABOVE PDH | 230 | 57.4% | +1.824 | -1.891 | +0.241 | 1.30 | +55.5 | 35.4 | -0.010 | 0.951 | 1.000 | 0.968 | REVERSES |
| BELOW PDL | 176 | 64.8% | +1.787 | -2.058 | +0.432 | 1.60 | +76.1 | 14.8 | +0.235 | 0.184 | 1.000 | 0.761 | STABLE |

#### BTC/USD (separate, generic labels) — UTC_WINDOW

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| UTC_00:00-05:59 | 44 | 63.6% | +1.145 | -1.911 | +0.033 | 1.05 | +1.5 | 14.8 | +0.003 | 0.991 | 1.000 | 0.991 | n/a |
| UTC_06:00-07:59 ⚠ | 20 | 65.0% | +1.397 | -2.165 | +0.150 | 1.20 | +3.0 | 6.3 | +0.131 | 0.778 | 1.000 | 0.991 | TOO_SMALL |
| UTC_08:00-11:59 ⚠⚠ | 14 | 57.1% | +1.254 | -2.007 | -0.143 | 0.83 | -2.0 | 7.6 | -0.186 | 0.731 | 1.000 | 0.991 | TOO_SMALL |
| UTC_12:00-15:59 | 44 | 61.4% | +1.207 | -1.917 | -0.000 | 1.00 | -0.0 | 15.7 | -0.039 | 0.917 | 1.000 | 0.991 | n/a |
| UTC_16:00-19:59 | 60 | 65.0% | +1.168 | -2.774 | -0.212 | 0.78 | -12.7 | 20.5 | -0.333 | 0.291 | 1.000 | 0.991 | n/a |
| UTC_20:00-23:59 | 40 | 75.0% | +1.195 | -1.870 | +0.429 | 1.92 | +17.2 | 4.8 | +0.485 | 0.178 | 1.000 | 0.991 | n/a |

#### BTC/USD (separate, generic labels) — GENERIC_SESSION_LABEL

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| ASIA | 60 | 63.3% | +1.210 | -2.029 | +0.022 | 1.03 | +1.3 | 20.5 | -0.012 | 0.973 | 1.000 | 0.991 | n/a |
| LONDON ⚠ | 24 | 62.5% | +1.353 | -1.961 | +0.110 | 1.15 | +2.6 | 6.5 | +0.089 | 0.840 | 1.000 | 0.991 | TOO_SMALL |
| LONDON_NY_OVERLAP | 45 | 62.2% | +1.224 | -1.853 | +0.061 | 1.09 | +2.8 | 14.8 | +0.038 | 0.916 | 1.000 | 0.991 | n/a |
| NEW_YORK | 59 | 64.4% | +1.155 | -2.764 | -0.240 | 0.76 | -14.2 | 20.5 | -0.369 | 0.245 | 1.000 | 0.991 | n/a |
| LATE_NY_ROLLOVER | 34 | 76.5% | +1.146 | -1.937 | +0.421 | 1.92 | +14.3 | 4.0 | +0.460 | 0.226 | 1.000 | 0.991 | n/a |

#### BTC/USD (separate, generic labels) — WEEKDAY

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| WEEKDAY Mon | 41 | 65.9% | +1.150 | -1.595 | +0.213 | 1.39 | +8.7 | 6.2 | +0.223 | 0.543 | 1.000 | 0.991 | n/a |
| WEEKDAY Tue | 38 | 57.9% | +1.012 | -2.240 | -0.357 | 0.62 | -13.6 | 17.9 | -0.469 | 0.201 | 1.000 | 0.991 | n/a |
| WEEKDAY Wed | 30 | 70.0% | +1.466 | -2.521 | +0.270 | 1.36 | +8.1 | 13.8 | +0.276 | 0.503 | 1.000 | 0.991 | n/a |
| WEEKDAY Thu | 32 | 68.8% | +1.419 | -3.097 | +0.008 | 1.01 | +0.3 | 16.7 | -0.027 | 0.948 | 1.000 | 0.991 | n/a |
| WEEKDAY Fri | 50 | 66.0% | +1.094 | -1.936 | +0.064 | 1.10 | +3.2 | 12.9 | +0.042 | 0.897 | 1.000 | 0.991 | n/a |
| WEEKDAY Sat ⚠⚠ | 11 | 45.5% | +1.155 | -2.270 | -0.713 | 0.42 | -7.8 | 9.3 | -0.783 | 0.194 | 1.000 | 0.991 | TOO_SMALL |
| WEEKDAY Sun ⚠ | 20 | 75.0% | +1.134 | -1.796 | +0.402 | 1.89 | +8.0 | 5.4 | +0.407 | 0.389 | 1.000 | 0.991 | TOO_SMALL |

#### BTC/USD (separate, generic labels) — VOLATILITY

| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| VOL LOW ⚠ | 19 | 63.2% | +1.202 | -3.072 | -0.372 | 0.67 | -7.1 | 10.1 | -0.441 | 0.361 | 1.000 | 0.991 | TOO_SMALL |
| VOL NORMAL | 76 | 63.2% | +1.283 | -1.976 | +0.083 | 1.11 | +6.3 | 9.5 | +0.078 | 0.792 | 1.000 | 0.991 | n/a |
| VOL HIGH | 127 | 66.9% | +1.155 | -2.155 | +0.060 | 1.08 | +7.7 | 30.3 | +0.069 | 0.817 | 1.000 | 0.991 | n/a |

#### FX stability (Δ vs rest within each slice; n in brackets)

| Feature | Combined | EUR/USD | USD/JPY | 1H | 4H | 2022 window | 2025 window | Label |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| HOUR_00 | -0.333 (39) | -0.743 (18) | -0.036 (21) | -0.165 (26) | -0.659 (13) | -0.371 (10) | -0.312 (29) | STABLE |
| HOUR_06 | +0.036 (47) | -0.380 (31) | +0.840 (16) | -0.002 (39) | +0.202 (8) | -1.088 (13) | +0.469 (34) | REVERSES |
| HOUR_07 | +0.182 (36) | +0.021 (23) | +0.454 (13) | +0.567 (25) | -0.691 (11) | +0.787 (7) | +0.032 (29) | TOO_SMALL |
| HOUR_08 | -0.117 (42) | +0.171 (29) | -0.747 (13) | -0.026 (36) | -0.690 (6) | +1.098 (11) | -0.533 (31) | TOO_SMALL |
| HOUR_09 | -0.275 (46) | -0.419 (32) | +0.064 (14) | -0.263 (42) | -0.509 (4) | +0.275 (9) | -0.413 (37) | TOO_SMALL |
| HOUR_11 | +0.722 (35) | +1.135 (23) | -0.078 (12) | +0.645 (25) | +0.943 (10) | +1.753 (4) | +0.572 (31) | TOO_SMALL |
| HOUR_12 | +0.310 (55) | +0.359 (40) | +0.218 (15) | +0.345 (38) | +0.260 (17) | +1.090 (12) | +0.094 (43) | STABLE |
| HOUR_13 | +0.196 (51) | +0.008 (37) | +0.717 (14) | +0.204 (37) | +0.192 (14) | -0.678 (12) | +0.466 (39) | TOO_SMALL |
| HOUR_14 | +0.377 (38) | +0.256 (27) | +0.694 (11) | +0.299 (34) | +0.968 (4) | -0.398 (10) | +0.661 (28) | TOO_SMALL |
| HOUR_15 | +0.606 (47) | +0.477 (35) | +1.027 (12) | +0.627 (36) | +0.548 (11) | -0.191 (11) | +0.852 (36) | TOO_SMALL |
| HOUR_16 | -0.169 (40) | -0.200 (31) | +0.006 (9) | -0.133 (30) | -0.266 (10) | -0.020 (8) | -0.209 (32) | TOO_SMALL |
| HOUR_17 | -0.064 (42) | +0.089 (31) | -0.448 (11) | -0.170 (40) | +1.702 (2) | -0.042 (12) | -0.058 (30) | TOO_SMALL |
| HOUR_18 | -0.073 (35) | +0.007 (24) | -0.240 (11) | +0.011 (28) | -0.410 (7) | -0.920 (9) | +0.225 (26) | TOO_SMALL |
| HOUR_20 | +0.200 (31) | +0.266 (24) | +0.051 (7) | +0.009 (20) | +0.593 (11) | +1.795 (4) | -0.055 (27) | TOO_SMALL |
| UTC_00:00-05:59 | -0.347 (164) | -0.388 (90) | -0.363 (74) | -0.275 (127) | -0.598 (37) | +0.104 (33) | -0.466 (131) | REVERSES |
| UTC_06:00-07:59 | +0.106 (83) | -0.219 (54) | +0.706 (29) | +0.235 (64) | -0.330 (19) | -0.441 (20) | +0.282 (63) | REVERSES |
| UTC_08:00-11:59 | +0.033 (149) | +0.176 (103) | -0.270 (46) | -0.004 (126) | +0.194 (23) | +0.831 (29) | -0.169 (120) | REVERSES |
| UTC_12:00-15:59 | +0.451 (191) | +0.346 (139) | +0.757 (52) | +0.449 (145) | +0.474 (46) | -0.034 (45) | +0.600 (146) | REVERSES |
| UTC_16:00-19:59 | -0.261 (141) | -0.213 (104) | -0.345 (37) | -0.306 (117) | -0.072 (24) | -0.288 (32) | -0.250 (109) | STABLE |
| UTC_20:00-23:59 | -0.025 (82) | +0.149 (54) | -0.369 (28) | -0.111 (62) | +0.260 (20) | -0.499 (14) | +0.067 (68) | REVERSES |
| ASIA | -0.250 (236) | -0.404 (137) | -0.058 (99) | -0.220 (182) | -0.347 (54) | -0.263 (51) | -0.245 (185) | STABLE |
| LONDON | +0.119 (181) | +0.258 (124) | -0.168 (57) | +0.125 (149) | +0.078 (32) | +0.844 (35) | -0.065 (146) | REVERSES |
| LONDON_NY_OVERLAP | +0.442 (194) | +0.322 (141) | +0.782 (53) | +0.448 (149) | +0.433 (45) | +0.018 (46) | +0.574 (148) | STABLE |
| NEW_YORK | -0.316 (143) | -0.303 (102) | -0.323 (41) | -0.368 (116) | -0.109 (27) | -0.363 (31) | -0.302 (112) | STABLE |
| LATE_NY_ROLLOVER | -0.058 (56) | +0.221 (40) | -0.720 (16) | -0.047 (45) | -0.107 (11) | -0.582 (10) | +0.051 (46) | REVERSES |
| FIX >120 before | -0.097 (478) | -0.094 (304) | -0.149 (174) | -0.008 (375) | -0.437 (103) | +0.579 (97) | -0.290 (381) | REVERSES |
| FIX 60-120 before | +0.302 (42) | +0.007 (30) | +1.056 (12) | +0.175 (32) | +0.720 (10) | -0.748 (13) | +0.780 (29) | TOO_SMALL |
| FIX 60-120 after | -0.220 (49) | -0.162 (38) | -0.343 (11) | -0.243 (42) | -0.126 (7) | +0.128 (13) | -0.334 (36) | TOO_SMALL |
| FIX >120 after | -0.217 (142) | -0.126 (98) | -0.404 (44) | -0.261 (114) | -0.045 (28) | -0.579 (26) | -0.139 (116) | STABLE |
| ROLLOVER within 60 | +0.125 (45) | +0.361 (36) | -0.686 (9) | +0.202 (34) | -0.107 (11) | +0.533 (6) | +0.047 (39) | TOO_SMALL |
| ROLLOVER outside 60 | -0.125 (765) | -0.361 (508) | +0.686 (257) | -0.202 (607) | +0.107 (158) | -0.533 (167) | -0.047 (598) | REVERSES |
| VOL LOW | -0.090 (239) | -0.320 (159) | +0.368 (80) | -0.043 (173) | -0.216 (66) | -0.138 (51) | -0.077 (188) | REVERSES |
| VOL NORMAL | -0.014 (322) | +0.045 (220) | -0.129 (102) | -0.007 (258) | -0.049 (64) | -0.143 (64) | +0.015 (258) | REVERSES |
| VOL HIGH | +0.104 (249) | +0.262 (165) | -0.217 (84) | +0.045 (210) | +0.355 (39) | +0.278 (58) | +0.059 (191) | REVERSES |
| NEAR PDH (<=0.25 ATR) | +0.220 (53) | +0.380 (36) | -0.114 (17) | +0.044 (35) | +0.618 (18) | -0.572 (9) | +0.377 (44) | MIXED |
| NEAR PDL (<=0.25 ATR) | +0.125 (48) | +0.386 (31) | -0.366 (17) | +0.189 (27) | +0.083 (21) | +0.032 (11) | +0.155 (37) | MIXED |
| NEAR DAY OPEN (<=0.25 ATR) | -0.546 (94) | -0.939 (59) | +0.112 (35) | -0.474 (70) | -0.752 (24) | -0.863 (20) | -0.460 (74) | REVERSES |
| INSIDE prior-day range | -0.151 (404) | -0.255 (268) | +0.052 (136) | -0.131 (333) | -0.260 (71) | -0.547 (98) | -0.036 (306) | REVERSES |
| OUTSIDE prior-day range | +0.151 (406) | +0.255 (276) | -0.052 (130) | +0.131 (308) | +0.260 (98) | +0.547 (75) | +0.036 (331) | REVERSES |
| ABOVE PDH | -0.010 (230) | +0.153 (158) | -0.348 (72) | -0.061 (174) | +0.176 (56) | +0.468 (41) | -0.131 (189) | REVERSES |
| BELOW PDL | +0.235 (176) | +0.190 (118) | +0.326 (58) | +0.270 (134) | +0.130 (42) | +0.315 (34) | +0.211 (142) | STABLE |
