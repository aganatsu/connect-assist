# TREND_PREREG_V1 — daily trend-following, pre-registered

**Written 2026-11-05, before any data for this study was fetched or looked at.**
Rules, universe, periods, costs and pass criteria are frozen here. If a result
disappoints, the idea is rejected; the parameters are not changed. Any later
variant is a new pre-registration with its own name.

## Why this idea

Every strategy tested in this repo so far fades price at a zone (Impulse,
Route 1, IPO, Breaker flip), and every causal, cost-adjusted test of it came
out negative (impulse corpus −0.099R n=1071; IPO V2 −0.171R n=928; breaker
−0.131R n=58). Trend-following is a structurally different hypothesis — buy
strength, sell weakness — with long published evidence across markets
(time-series momentum). On daily bars, costs are a small fraction of R, which
removes the main cost problem the intraday work had.

## Universe and data

- **9 instruments:** EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CAD,
  USD/CHF, XAU/USD, BTC/USD.
- **Data:** TwelveData `1day`, UTC, fetched by `local-runner/trend-fetch.ts`.
  Saturday/Sunday bars are dropped for everything except BTC/USD.
- **Periods** (by entry date):
  - warm-up: from the first bar fetched (2014) — no trades counted;
  - **in-sample (IS): 2015-01-01 → 2022-12-31;**
  - **out-of-sample (OOS): 2023-01-01 → 2026-10-31** — evaluated **once**, and
    only if the IS gate passes. The script refuses `--oos` otherwise.

## Rules (one parameter set, no grid)

| | Rule |
|---|---|
| ATR | Wilder ATR(20) on daily bars |
| Long signal | close of day *t* > highest high of the previous 50 days (*t−50 … t−1*) |
| Short signal | close of day *t* < lowest low of the previous 50 days |
| Entry | open of day *t+1*, only if flat on that instrument |
| Initial stop | entry ∓ 2 × ATR(20) as of day *t*. **1R = 2 × ATR(20)**. The stop never moves |
| Stop exit | intraday: if the bar opens beyond the stop, exit at the open (gap); else if the bar trades through the stop, exit at the stop. Checked from the entry day on |
| Channel exit | long: close < lowest low of the previous 20 days → exit at next open. Short: close > highest high of the previous 20 days → exit at next open |
| Other | no target, no partials, no pyramiding, no break-even; one position per instrument; opposite signals while in a trade are ignored |
| End of data | a still-open trade is reported as OPEN and excluded from stats |

## Costs (charged on every trade, in R)

- **Round trip**, price units:
  - FX: repo `SPECS.typicalSpread` + 0.5 pip commission-equivalent + 0.5 pip
    slippage → EUR/USD 2.0, GBP/USD 2.5, USD/JPY 2.0, AUD/USD 2.5, NZD/USD 3.0,
    USD/CAD 2.5, USD/CHF 2.5 pips;
  - XAU/USD: $0.50;
  - BTC/USD: 0.20% of entry price.
- **Financing**, always charged as a cost regardless of direction (conservative —
  no carry credit is ever assumed): 1.0%/year of notional for FX and XAU/USD,
  10%/year for BTC/USD, pro rata per calendar day held.
- `netR = grossR − (roundTrip + financing) / R`.

## Decision gates

**G1 — in-sample (2015–2022). All must hold:**
1. portfolio net expectancy > 0R;
2. portfolio profit factor ≥ 1.10;
3. net expectancy > 0 on at least 5 of the 9 instruments.

Fail → the idea is rejected. OOS is not run.

**G2 — out-of-sample (2023-01-01 → 2026-10-31), run once, only after G1 passes:**
1. portfolio net expectancy > 0R;
2. portfolio profit factor ≥ 1.0.

Pass → design a forward shadow arm (separate doc) and run it for ≥ 100 trades
or 12 months before any real money. Fail → rejected.

**"Strong evidence"** label (reported, not a gate): IS + OOS combined, bootstrap
95% CI of net expectancy has a lower bound > 0.

## Reported but not decisive

Computed after the primary result, labelled descriptive, never used to pick
parameters:
- 2× cost stress;
- neighbouring parameter sets (20/10, 100/50 channels; 3×ATR stop) — to see
  whether the primary sits on a plateau or a spike;
- a random-entry placebo with the same exits and costs (entries at the same
  average rate, random direction) — to separate the entry signal from the
  exit asymmetry;
- per-instrument and per-year breakdown; equity curve at 0.5% risk per trade
  (non-compounding, closed-trade sequence).

## Known limitations, stated up front

- Daily bars only: the intraday order of stop vs open is handled by the gap
  rule, but slippage on fast stop-outs is approximated by the fixed allowance.
- Financing is a flat assumption, not historical swap rates.
- 9 instruments are correlated (USD on one side of 7 of them); the effective
  number of independent bets is smaller than the trade count.
- Max drawdown is on the closed-trade sequence; mark-to-market drawdown is larger.
