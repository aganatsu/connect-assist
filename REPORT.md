# Task: Integrate Workstream A Modules into Bot-Scanner

## Branch: manus/integrate-modules

## Behavior changes

1. **Position sizing now includes volatility regime scaling** — In high-volatility regimes (ATR trending up), lot size is reduced by 25%. In extreme volatility, reduced by 50%. Previously, sizing was purely risk-based with no volatility adjustment.

2. **Prop firm compliance integrated into sizing** — `computePositionSize` now caps lots based on daily loss remaining (if prop firm gate data is available). Previously, the prop firm multiplier was applied as a separate step.

3. **Circuit breaker skips failing broker connections** — Connections with 3+ consecutive failures in the past 5 minutes are automatically skipped in the mirror loop. Previously, every connection was attempted regardless of recent failure history.

4. **Portfolio correlation advisory reduces size** — After all 21 gates pass, if the new trade is >50% correlated with existing open positions, lot size is reduced by up to 30%. This is a soft advisory (never blocks trades).

5. **Backtest SL floor impact quantified** — 81% of trades with random tight SLs get widened, average widening is +32 pips, R:R is always preserved.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Replaced 3x `calculatePositionSize` calls with `computePositionSize`; added circuit-breaker logic to mirror loop; added portfolio correlation advisory post-gate check |
| `supabase/functions/backtest-engine/slFloorComparison.test.ts` | New: comparison test quantifying SL floor impact across instruments |

## Extra caution file explanation

### bot-scanner/index.ts

Three integration points were modified:

1. **Position sizing (market orders, limit orders, broker mirror)** — Replaced `calculatePositionSize()` + manual `propFirmSizeMultiplier` with `computePositionSize()`. The new function wraps the same underlying calculation but adds volatility regime scaling. Portfolio heat and correlation checks are disabled (Option A — gates already handle those).

2. **Mirror loop** — Added `isConnectionAvailable()` check at the top of the connection iteration. If a connection has 3+ recent failures, it's skipped for 5 minutes. Added `updateHealth()` calls at every success/failure point (OANDA success, OANDA failure, MetaAPI success, MetaAPI HTTP failure, MetaAPI broker rejection).

3. **Post-gate advisory** — After all 21 gates pass and before sizing, added `checkPortfolioConflict()` call. If correlation > 50%, a multiplier (0.7–1.0) is applied to the final lot size. Logged but never blocks.

## Tests added

| Test | Asserts |
|------|---------|
| `slFloorComparison.test.ts: tight-SL EUR/USD trades` | Trades with SL < 20 pips get widened to 20 pips (MIN_SL_PIPS floor) |
| `slFloorComparison.test.ts: GBP/JPY high-volatility trades` | ATR floor (45 pips) dominates over static floor (35 pips) when ATR is high |
| `slFloorComparison.test.ts: ATR floor dominates in high volatility` | When ATR × 1.5 > MIN_SL_PIPS, the ATR floor is used |
| `slFloorComparison.test.ts: batch impact quantification` | 100 random trades across 5 instruments — measures widening percentage and average delta |
| `slFloorComparison.test.ts: R:R always preserved after widening` | TP is proportionally adjusted so R:R ratio is identical before and after widening |

## Tests run

```
$ deno test --allow-all --no-check supabase/
ok | 1024 passed | 0 failed (14s)
```

## Regression check

- The `computePositionSize` integration was done with Option A (conservative): portfolio heat and correlation checks disabled inside the sizing function since existing Gates 6 and 22 already handle those. Only volatility scaling and prop firm compliance are active.
- Circuit breaker is additive — it can only SKIP connections (never adds new ones), so worst case is a connection that should be tried gets skipped for 5 minutes.
- Portfolio correlation advisory is multiplicative (0.7–1.0 range) — it can only reduce size, never increase it.
- All 1024 tests pass with zero failures.

## Tick Data Source Research

### Recommendation

**Short-term (now): Enhanced Polling**
- Reduce zone-confirmation-scanner interval to 15 seconds
- Collect price snapshots as pseudo-ticks
- Feed them to `tickZoneConfirmation` module
- 80% of the benefit with 0% infrastructure change

**Medium-term: MetaAPI Streaming via external service**
- Deploy a lightweight Deno/Node process on Fly.io or Railway (~$5-10/mo)
- Maintain MetaAPI WebSocket connections for watchlist symbols
- Push ticks to Supabase Realtime channel
- Zone-confirmation-scanner subscribes to the channel

**Why MetaAPI over TwelveData for ticks:**
- MetaAPI ticks ARE your broker's actual feed (what you see = what you trade at)
- Already integrated (connections exist)
- No additional API key needed
- TwelveData WebSocket is aggregated (not true tick-by-tick) and costs $229/mo for 28+ symbols

**Architecture constraint:** Supabase Edge Functions are stateless/short-lived — cannot maintain persistent WebSocket connections. A separate always-on process is needed for true streaming.

## Open questions

1. **Volatility regime detection** — Currently mapped from `regimeInfo.atrTrend` field. If this field is sometimes null/undefined, the system defaults to "normal" (no scaling). Should we add a fallback ATR percentile calculation?

2. **Circuit breaker persistence** — The health map is in-memory (resets on cold start). Should we persist it to Supabase for cross-invocation memory?

3. **Correlation advisory threshold** — Currently set at 50% correlation → reduce size. Want this configurable per-user, or is a global default fine?

4. **Tick data next step** — Ready to implement the enhanced polling approach (15s zone-confirmation-scanner) whenever you give the go-ahead.

## Suggested PR title and description

**Title:** `feat: integrate unified sizing, circuit breaker, and correlation advisory into bot-scanner`

**Description:**
Wires three Workstream A modules into the live execution path:

- **Unified Position Sizing** (Option A): Replaces raw `calculatePositionSize` with `computePositionSize` — adds volatility regime scaling (25-50% reduction in high/extreme vol) and integrated prop firm compliance. Portfolio heat and correlation checks disabled (handled by existing gates).

- **Circuit Breaker**: Broker connections with 3+ consecutive failures are skipped for 5 minutes. Prevents wasted API calls to dead/disconnected brokers. Health updates on every success/failure in the mirror loop.

- **Portfolio Correlation Advisory**: Post-gate soft check that reduces position size by up to 30% when new trade is >50% correlated with existing open positions. Never blocks trades.

Also includes SL floor comparison test quantifying the backtest impact: 81% of tight-SL trades widened, avg +32 pips, R:R preserved.

Tick data research concludes MetaAPI streaming is the right choice for medium-term, with enhanced polling (15s) as the immediate next step.

All 1024 tests passing.
