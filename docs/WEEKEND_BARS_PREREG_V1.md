# WEEKEND_BARS_PREREG_V1 — drop FX weekend bars from the bot's analysis, pre-registered

**Written 2026-11-16, before either arm was run.** Owner request (2026-11-16), after the
Bot View chart showed weekend candles in the bot's structure.

## The data question

bot-scanner fetches candles with `fetchCandlesWithFallback({ skipBroker: true })` (TwelveData).
TwelveData returns bars for the FX weekend (Fri 17:00 → Sun 17:00 New York), when the
market is shut. The scanner never calls `sessions.dropFxClosedBars`, so swings, CHoCH/BOS,
lookback counts and ATR on forex include them. smc-analysis already drops them. In the
cached corpus, 28% of 5m/15m bars and 23% of 1h bars are weekend bars.

A regular broker or TradingView FX chart has no weekend bars. So this is a data-correctness
fix, not an edge filter. The test asks whether it **hurts**, not whether it creates an edge.

## Change under test (one rule)

VARIANT: every analysis series (5m, 15m, 1h, 4h, 1d; weekly bars are stamped Monday and are
untouched) goes through `dropFxClosedBars(series, true)` after the depth slice. This mirrors
a one-line live fix applied after the fetch. Daily: Saturday and Sunday bars are both dropped
(the shared rule). The Sunday bar's ~7 real evening hours are lost; this matches smc-analysis.

BASELINE: the same series with weekend bars kept (the current live behaviour).

## Harness — `local-runner/weekend-bars-replay.ts`

The `latest-choch-replay.ts` causal replay (production decideDirection → buildHtfContext →
decideZone → findUnifiedZone, frozen costs, 1m execution, same corpus, same 7 FX pairs,
decisions 2026-03-29 → 2026-09-25). It uses the live direction defaults
(`buildDirectionConfig({})`: latest CHoCH decides on, with the #699 rule). Three corrections
apply to **both** arms:

1. **No lookahead.** The old harness decided at the start of a 5m bar using bars whose start
   was ≤ that time, at their *final* OHLC: the current 5m, 15m and 1h bars. It then entered
   one minute later. Decision time is now the close of the 5m bar (start + 5 min). Only bars
   that have **closed** by then are used. Entry is on the first 1m bar starting at or after
   the decision time. (Live includes the forming bar with partial values; that is not
   reconstructed.)
2. No decisions while FX is closed (live does not scan FX then).
3. Weekend 1m bars are removed from the execution tape (nothing fills or exits on them).

## Gate — decided now

Trades = outcome TRADE_TAKEN and not ambiguous; netR after frozen costs.

PASS (ship the fix as a correctness fix, default on, `dropFxWeekendBars: false` restores old)
if **all** hold:
1. VARIANT net expectancy ≥ BASELINE − 0.05R overall;
2. same in each half (split 2026-06-27);
3. VARIANT has ≥ 70% of BASELINE's trade count (the fix must not starve the bot).

FAIL → no change; report why.

0.05R is about one standard error at this sample size. This is a correctness fix, so "no
measurable harm" is enough. It is not required to beat BASELINE.

## Reported, not decisive

Before-cost expectancy; Monday-only trades (where the effect should concentrate); by pair;
trades that exist in only one arm.

## Result (run 2026-11-16, after the gate above was written)

`python3 -I local-runner/weekend-bars-report.py`:

| | trades | win rate | net exp | 95% CI |
|---|---|---|---|---|
| BASELINE (weekend bars kept) | 606 | 30.9% | −0.111R | [−0.178, −0.041] |
| VARIANT (weekend bars dropped) | 637 | 28.9% | −0.104R | [−0.165, −0.044] |
| 1st half B / V | 304 / 357 | | −0.092 / −0.069 | |
| 2nd half B / V | 302 / 280 | | −0.130 / −0.149 | |

Gate: all four checks PASS → ship (default on). Descriptive: only ~340 trades are common to
both arms, so the weekend bars change *which* trades fire a lot but not the average. Mondays:
112 → 192 trades, −0.182R → −0.128R. Tue–Fri: −0.094R in both. Both arms are negative after
costs, consistent with the earlier finding of no edge in the SMC replay. This fix corrects the
data the bot reads; it does not create an edge.

Live wiring: the forex fetch goes deeper (weekendAllowance) so each series keeps its usual count
of real bars after the drop. The replay sliced deeper depths before dropping, so live and replay
are close but not identical. Daily comes from the persistent cache without a deep fetch, so it
is ~30% shorter (≈214 real bars instead of 300).
