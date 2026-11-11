# BREAK_STRENGTH_PREREG_V1 — do strong BOS candles make better SMC trades? Pre-registered

**Written 2026-11-06, before the replay was run.** Owner request (2026-11-06):
check whether the Zone Story's "BOS close strength" predicts results, then adjust.

## What prompted it (the hypothesis comes from here, so it is not evidence)

Live/demo trades with the measure recorded (40 trades, owner's SQL 2026-11-06):
BOS close ≥ 70%: 12 trades, +0.76R; < 70%: 28 trades, −0.34R; the same ordering
in both halves. Too few to act on (the rule needed ≥ 30 strong-break trades).

## Test

Re-run SMC_IMPULSE_ZONE_CORPUS_BACKTEST_V1 (`local-runner/smc-zone-replay.ts`,
the production modules decideDirection → buildHtfContext → decideZone →
findUnifiedZone, frozen cost model, 1m execution) on its frozen window
(decisions 2026-03-29 → 2026-09-25, 7 FX pairs), unchanged except that each
setup also records the unified impulse's `candleQuality` (`bosCloseStrength`,
`originCloseStrength`, `bosRejectionWick`) and `displacement.strength`
(`local-runner/break-strength-replay.ts`). Trades = outcome TRADE_TAKEN, not
ambiguous — the same definition as `impulse_zone_trades_clean.csv` (n=1071).

**Corpus.** 1m / 5m / 15m / 1h reuse the SCALPER15 fetch (same TwelveData
series, same date spans as SMC_IMPULSE_ZONE's TF_SPEC, fetched 2026-11-05); 4h /
1d / 1w are fetched by `smc-corpus-fetch.ts`. Provider revisions since the
original fetch may change a few setups, so the original's n=1071 / −0.099R is
reported next to the re-run as a consistency check, not assumed.

**Split.** STRONG = `bosCloseStrength ≥ 0.70` (the threshold fixed before the
owner's query ran); WEAK = below. Halves split at the window midpoint
(2026-06-27, which is also the original PRIMARY window start).

## Gate — all must hold to add the filter

1. STRONG: ≥ 30 trades and net expectancy > 0R;
2. STRONG beats WEAK by net expectancy;
3. 1 and 2 hold in each half separately.

Pass → a Bot Config switch "require strong BOS close (≥ 70%)", **default off**,
the owner turns it on and starts a fresh demo record. Fail → no change; the
measure stays observational.

## Reported, not decisive

The same split by `displacement.strength` (strong/moderate/weak) and by
`bosCloseStrength` tercile; before-cost expectancy; by timeframe (1H/15m/5m).
No other threshold is evaluated for the decision.
