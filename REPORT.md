# Task: Workstream A — New Feature Modules + Infrastructure Fixes
## Branch: manus/workstream-a
## Behavior changes

1. **Paper-trading ATR cache** — `fetchATR()` now caches results for 15 minutes per symbol. Reduces TwelveData API calls from ~1/order to ~1/15min/symbol. No change in sizing accuracy (same ATR value used within the TTL window).

2. **Backtest engine SL floor** — Backtests now enforce the same two-layer SL floor (static MIN_SL_PIPS + dynamic ATR × multiplier) as bot-scanner and paper-trading. Trades with too-tight SLs are widened before sizing. **This will change backtest results** for trades that previously had sub-minimum SLs.

3. **Seven new shared modules added** (no live behavior change until integrated into bot-scanner/paper-trading):
   - Adaptive factor weights
   - Inducement detection
   - Portfolio correlation matrix
   - Shadow trading mode
   - Tick-level zone confirmation
   - Multi-broker failover
   - Unified position sizing

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/paper-trading/index.ts` | Added 15-min TTL cache to `fetchATR()` |
| `supabase/functions/backtest-engine/index.ts` | Added MIN_SL_PIPS + ATR floor enforcement before position sizing |
| `supabase/functions/_shared/adaptiveWeights.ts` | **NEW** — Bayesian-inspired factor weight adaptation based on trade outcomes |
| `supabase/functions/_shared/adaptiveWeights.test.ts` | 14 tests |
| `supabase/functions/_shared/inducementDetection.ts` | **NEW** — Detect liquidity sweeps, equal highs/lows, and stop hunts |
| `supabase/functions/_shared/inducementDetection.test.ts` | 8 tests |
| `supabase/functions/_shared/portfolioCorrelation.ts` | **NEW** — Pearson correlation matrix, portfolio VaR, and exposure limits |
| `supabase/functions/_shared/portfolioCorrelation.test.ts` | 8 tests |
| `supabase/functions/_shared/shadowTrading.ts` | **NEW** — Virtual execution engine for strategy validation without capital |
| `supabase/functions/_shared/shadowTrading.test.ts` | 8 tests |
| `supabase/functions/_shared/tickZoneConfirmation.ts` | **NEW** — Sub-candle zone confirmation (micro-CHoCH, displacement burst, volume spike, bid/ask imbalance) |
| `supabase/functions/_shared/tickZoneConfirmation.test.ts` | 12 tests |
| `supabase/functions/_shared/multiBrokerFailover.ts` | **NEW** — Priority routing, circuit breaker, latency-aware selection, position reconciliation |
| `supabase/functions/_shared/multiBrokerFailover.test.ts` | 22 tests |
| `supabase/functions/_shared/unifiedPositionSizing.ts` | **NEW** — Wraps calculatePositionSize with portfolio heat, correlation, volatility, and prop firm layers |
| `supabase/functions/_shared/unifiedPositionSizing.test.ts` | 21 tests |

## Extra caution file explanations

### paper-trading/index.ts
Added a simple in-memory cache (`atrCache` Map) to the existing `fetchATR()` function. Cache key is the symbol, value is `{ atr, fetchedAt }`. Returns cached value if less than 15 minutes old. No logic change to the ATR calculation itself.

### backtest-engine/index.ts
Added a SL floor enforcement block (identical logic to paper-trading and bot-scanner) between the existing SL/TP calculation and position sizing. If `actualSlDistance < effectiveMinSlPips * pipSize`, the SL is widened and TP recalculated preserving original R:R. Uses ATR from the candle window (already available in backtest context). Added `MIN_SL_PIPS` and `ATR_SL_FLOOR_MULTIPLIER` to the import block.

## Tests added

| Test file | Count | What it asserts |
|-----------|-------|-----------------|
| `adaptiveWeights.test.ts` | 14 | Weight adaptation, decay, convergence, edge cases |
| `inducementDetection.test.ts` | 8 | Sweep detection, equal highs/lows, recency filtering |
| `portfolioCorrelation.test.ts` | 8 | Pearson correlation, matrix construction, VaR calculation |
| `shadowTrading.test.ts` | 8 | Virtual order lifecycle, SL/TP hits, performance metrics |
| `tickZoneConfirmation.test.ts` | 12 | Micro-candle aggregation, displacement burst, CHoCH, buffer expiry |
| `multiBrokerFailover.test.ts` | 22 | Circuit breaker, failover sequencing, reconciliation, health updates |
| `unifiedPositionSizing.test.ts` | 21 | Portfolio heat, correlation caps, volatility scaling, prop firm compliance |

**Total new tests: 93**

## Tests run

```
ok | 1019 passed | 0 failed (15s)
```

All 1019 tests pass (913 existing from main + 93 new + 13 from infrastructure fixes in earlier commits).

## Regression check

- **ATR caching**: Cache is transparent — same ATR value returned within TTL. No sizing divergence.
- **Backtest SL floor**: Intentional behavior change documented above. Trades with SL < MIN_SL_PIPS will now be widened, changing backtest P&L for those specific entries.
- **New modules**: All are additive shared libraries. They export functions but are NOT yet called from any live execution path (bot-scanner, paper-trading, broker-execute). Zero risk of regression until integration.

## Open questions

1. **Integration priority** — Which module(s) should be wired into bot-scanner first? Suggested order:
   - `unifiedPositionSizing` (replaces raw `calculatePositionSize` calls with safety layers)
   - `multiBrokerFailover` (replaces sequential connection iteration)
   - `portfolioCorrelation` (adds correlation gate before trade entry)
   - `adaptiveWeights` (requires historical trade data pipeline)
   - `tickZoneConfirmation` (requires tick data feed integration)
   - `inducementDetection` (adds to confluence scoring)
   - `shadowTrading` (standalone validation mode)

2. **Backtest divergence** — The SL floor in backtest-engine will change historical results. Should I run a comparison backtest on a known dataset to quantify the delta?

3. **Tick data source** — `tickZoneConfirmation` needs a real-time tick feed. Currently the system uses TwelveData for candles. Should we use MetaAPI's streaming ticks, or add a WebSocket connection to TwelveData?

## Suggested PR title and description

**Title:** `feat: Workstream A — 7 new trading engine modules + ATR caching + backtest SL floor`

**Description:**
Adds seven new shared modules that bring the trading engine to production-grade:

- **Adaptive Factor Weights** — Bayesian weight adaptation from trade outcomes
- **Inducement Detection** — Liquidity sweep and stop hunt identification
- **Portfolio Correlation Matrix** — Pearson correlation, VaR, exposure limits
- **Shadow Trading Mode** — Virtual execution for strategy validation
- **Tick-Level Zone Confirmation** — Sub-candle precision entry confirmation
- **Multi-Broker Failover** — Circuit breaker, latency routing, reconciliation
- **Unified Position Sizing** — Portfolio heat, correlation, volatility, prop firm layers

Infrastructure fixes:
- 15-minute TTL cache for ATR fetching in paper-trading
- Backtest engine now enforces MIN_SL_PIPS + ATR floor (matching live)
- Frontend TypeScript: zero type errors confirmed

All modules are additive shared libraries with full test coverage (93 new tests). No live behavior changes until explicitly integrated.
