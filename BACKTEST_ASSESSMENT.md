# Honest Assessment: Backtest Engine, Bot-Scanner, and smcAnalysis.ts

**Author:** Manus AI
**Date:** April 20, 2026
**Scope:** Architecture review of the three core modules in connect-assist's SMC trading system

---

## 1. What Each Module Actually Is

### smcAnalysis.ts — The Pure Library (1,200+ lines)

`smcAnalysis.ts` is a **zero-side-effect library**. It exports detection functions, calculation helpers, and constants. It never reads from a database, never calls a broker API, never writes state anywhere. It is the single source of truth for *how SMC analysis works*.

| What it owns | Examples |
|---|---|
| **Instrument specs** | `SPECS` table (pipSize, lotUnits, maxSpread, typicalSpread for every instrument) |
| **Detection functions** | `detectSwingPoints`, `analyzeMarketStructure`, `detectOrderBlocks`, `detectFVGs`, `detectLiquidityPools`, `detectDisplacement`, `detectBreakerBlocks`, `detectUnicornSetups`, `detectSMTDivergence`, `detectJudasSwing`, `detectReversalCandle` |
| **Timing functions** | `detectSession`, `detectSilverBullet`, `detectMacroWindow`, `detectAMDPhase` |
| **Calculation helpers** | `calculateSLTP`, `calculatePositionSize`, `calcPnl`, `getQuoteToUSDRate`, `calculateATR`, `calculatePremiumDiscount`, `calculatePDLevels`, `calculateAnchoredVWAP` |
| **Configuration constants** | `DEFAULTS`, `STYLE_OVERRIDES`, `ASSET_PROFILES`, `YAHOO_SYMBOLS`, `SMT_PAIRS` |
| **Regime classification** | `classifyInstrumentRegime` (the full version with ADX-like analysis, SMA crossover, range%) |

Every function takes data in, returns results out. No side effects. This is exactly what a shared library should be.

### bot-scanner — The Runtime Orchestrator (2,000+ lines)

`bot-scanner` is the **live execution engine**. It is the thing that actually *does stuff* — it reads config from the database, fetches live candle data, calls the smcAnalysis.ts functions, applies an 18-gate safety pipeline, sizes positions, executes trades through OANDA/MetaApi, manages open positions via `scannerManagement.ts`, detects commissions, and writes results back to the database.

| What it owns | Examples |
|---|---|
| **Config loading/merging** | `loadConfig()` — reads `bot_configs` table, merges DEFAULTS + STYLE_OVERRIDES + user overrides |
| **Live data fetching** | Yahoo Finance candles, broker spread checks (`fetchBrokerSpread`), rate map building |
| **18-gate safety pipeline** | Max positions, per-symbol cap, duplicate direction, min confluence, min factor count, min RR (spread-adjusted), HTF bias, P/D zone, daily loss, portfolio heat, cooldown, consecutive losses, kill zone, session/day, max drawdown, news filter, spread filter, FOTSI veto |
| **20-factor confluence scoring** | `runFullConfluenceAnalysis()` — 9 groups, anti-double-count rules, Power of 3 combo, group caps |
| **Trade execution** | Position sizing with commission, broker mirroring (OANDA + MetaApi), SL/TP spread adjustment |
| **Trade management** | Calls `manageOpenPositions()` from `scannerManagement.ts` (trailing, BE, partial TP, structure invalidation, time exit) |
| **State management** | DB reads/writes for scan_logs, positions, broker connections, commission auto-detection |

The relationship is clear: **bot-scanner calls smcAnalysis.ts**. smcAnalysis.ts is the library; bot-scanner is the application.

### backtest-engine — The Historical Simulator (2,160 lines)

`backtest-engine` attempts to **faithfully replicate** what bot-scanner + paper-trading would have done on historical data. It imports all detection functions from smcAnalysis.ts (zero re-implementation of detection logic), but it has its own local copies of:

- Config mapping (`mapConfig`)
- Confluence scoring engine (20 factors, 9 groups, anti-double-count, Power of 3, group caps)
- Lightweight regime classifier
- Volume profile (TPO)
- Safety gates (10 gates vs bot-scanner's 18)
- Exit simulation (`processExits` — trailing, BE, partial TP, time exit)
- Stats computation

---

## 2. What the Backtest Engine Does Well

I want to be fair before I get critical. There are several genuinely good design decisions here.

**Zero re-implementation of detection logic.** The backtest imports 30+ functions from smcAnalysis.ts. Every swing point, order block, FVG, liquidity pool, displacement, breaker block, unicorn setup, SMT divergence, Judas swing, reversal candle, session, silver bullet, macro window, and AMD phase is detected by the exact same code that runs in production. This is the single most important thing to get right in a backtester, and it is right.

**Time-aware historical evaluation.** The `atMs` timestamp parameter is passed to all time-dependent factors (session, silver bullet, macro window, AMD). This means the backtest correctly evaluates "was this candle in a kill zone?" based on the candle's actual time, not the current wall clock. This is correct and non-trivial to get right.

**FOTSI timeline without lookahead bias.** The engine builds a `fotsiTimeline` map — one FOTSI snapshot per day, computed only from daily candles up to and including that date. Each bar looks up the most recent prior snapshot. This prevents the classic backtesting sin of using future data.

**SMT alignment without lookahead.** Correlated pair candles are filtered to `<= candleTime` before computing SMT divergence. Correct.

**Factor and gate breakdown analytics.** The `factorBreakdown` tracks which factors appeared in winning vs losing trades. The `gateBreakdown` tracks which gates blocked trades and whether those blocked trades would have won or lost (by peeking ahead up to 20 bars). This is genuinely useful for understanding which parts of the strategy add value and which gates are too aggressive.

**Spread-adjusted R:R gating.** Gate 4 uses per-instrument `typicalSpread` from SPECS to compute effective R:R, matching the fix we added to bot-scanner in Commit 2.

**Cross-pair lot sizing.** Uses `btRateMap` with `getQuoteToUSDRate` and `calculatePositionSize` from the shared library. Matches the fix from Commit 1.

**Intermediate candle exit processing.** The loop processes exits on every candle between STEP intervals (lines 1906-1934), not just on analysis candles. This prevents the backtester from missing SL/TP hits that occur between evaluation points.

**Asset-adjusted SL buffer.** Uses `assetProfile.slBufferMultiplier` to adjust SL buffer per instrument class, matching bot-scanner behavior.

---

## 3. What the Backtest Engine Gets Wrong or Is Missing

Here is where I need to be honest. There are real issues, ranging from maintenance risks to simulation inaccuracies.

### 3.1 The Big One: Duplicated Confluence Scoring Engine

The 20-factor, 9-group confluence scoring engine exists in **two places**:

1. `bot-scanner/index.ts` → `runFullConfluenceAnalysis()` (~500 lines)
2. `backtest-engine/index.ts` → `runConfluenceAnalysis()` (~500 lines)

These are not imported from a shared module. They are copy-pasted and maintained separately. Right now they match (I verified factor-by-factor), but this is a ticking time bomb. The moment someone changes a weight, adds a factor, adjusts an anti-double-count rule, or modifies a group cap in bot-scanner, the backtest will silently diverge.

> **Risk level: HIGH.** This is the #1 maintenance risk in the entire codebase. A backtest that doesn't match the live engine is worse than no backtest at all — it gives false confidence.

**The fix:** Extract the confluence scoring into `_shared/confluenceScoring.ts` and import it in both places. The only difference is the `atMs` parameter (which the backtest already passes correctly), so this is a clean extraction.

### 3.2 Simplified Exit Engine vs scannerManagement.ts

The backtest's `processExits()` function is a simplified version of what `scannerManagement.ts` does in production. Here are the differences:

| Feature | scannerManagement.ts (live) | processExits (backtest) |
|---|---|---|
| **Trailing stop tightening** | Step 6b: ratchets SL forward on every subsequent cycle after activation | Only moves SL once per candle (no multi-cycle ratcheting) |
| **Structure invalidation** | CHoCH-based SL tightening when position is in -0.8R to 0R range | Not implemented |
| **Break-even** | Moves SL to entry + small buffer | Moves SL to exact entry (no buffer) |
| **Partial TP** | Closes partial, adjusts remaining position's SL | Closes partial correctly, but no SL adjustment on remainder |
| **Exit attribution logging** | Structured logging with trigger, rMultiple, detail | No attribution logging |

The trailing stop difference is the most impactful. In production, the trailing stop ratchets forward every scan cycle (every ~15 minutes). In the backtest, it only evaluates once per candle. For a 15-minute timeframe this is close, but for 5-minute or 1-hour timeframes the behavior diverges.

Structure invalidation is completely missing from the backtest. In production, if a position is in the -0.8R to 0R range and a CHoCH occurs against the position, the SL is tightened. This is a meaningful exit mechanism that the backtest doesn't simulate.

### 3.3 Global Spread vs Per-Instrument Spread

The backtest accepts a single `spreadPips` parameter (default 1.0) and applies it uniformly to all instruments. But in Commit 2, we added per-instrument spread data to SPECS:

| Instrument | typicalSpread (pips) |
|---|---|
| EUR/USD | 1.0 |
| GBP/JPY | 2.5 |
| XAU/USD | 3.0 |
| BTC/USD | 30.0 |
| US30 | 3.0 |

Using `spreadPips=1.0` for GBP/JPY understates costs by 60%. Using it for BTC/USD understates costs by 97%. This makes the backtest optimistic on high-spread instruments.

**Partial fix already present:** Gate 4 (R:R check) does use `typicalSpread` from SPECS. But the entry price simulation (line 2063-2066) uses the global `spreadPips`, creating an inconsistency: the gate checks one spread, the entry simulates another.

### 3.4 No Commission Simulation

Commit 4 added commission handling to bot-scanner: commission is factored into lot sizing (iterative solve) and R:R gating. The backtest has none of this. For brokers charging $7/lot round-trip, this means the backtest overstates profitability by $7 × lots per trade. On a 0.1 lot scalper doing 200 trades/month, that is $140/month of phantom profit.

### 3.5 Lightweight Regime Classifier is a Simpler Duplicate

The backtest has its own `classifyInstrumentRegime()` (lines 397-460) that is simpler than the shared version in smcAnalysis.ts. The shared version uses:

- ATR-14 with 7-bar recent vs prior comparison
- ADX-like directional movement analysis (+DM/-DM)
- SMA-7 vs SMA-20 crossover with distance measurement
- 20-day range percentage
- Multi-indicator scoring with confidence levels

The backtest version uses:

- ATR with 5-bar recent vs older comparison
- SMA-7 vs SMA-20 crossover (simplified)
- No ADX-like analysis
- Different threshold values

This means regime-aware scoring (Factor 21) may produce different results in backtest vs live. The shared `classifyInstrumentRegime` from smcAnalysis.ts is already exported and could be used directly.

### 3.6 Historical Data Limitations

The `fetchHistoricalCandles` function calls `fetchCandlesWithFallback` with `limit: 500`. For 15-minute candles, 500 candles is about 5 trading days. For daily candles, 500 is about 2 years. This means:

- **Entry timeframe data is limited to ~5 days** regardless of the `startDate`/`endDate` range requested. A "6-month backtest" on 15m candles is actually running on the last 5 days of data.
- The `range` parameter computed from the date span (lines 1771-1772) is passed to `fetchHistoricalCandles` but `fetchCandlesWithFallback` ignores it and uses `limit: 500`.

This is a fundamental limitation. The backtest *looks* like it supports long date ranges, but the actual data window is constrained by the candle source.

### 3.7 Missing Gates (10 vs 18)

The backtest implements 10 safety gates. Bot-scanner has 18. The missing gates:

| Gate | Why missing | Impact |
|---|---|---|
| Spread filter | No live spread data in backtest | Low (typicalSpread used in R:R gate) |
| News filter | No historical news feed | Low (correctly hardcoded to false) |
| Max drawdown (real-time) | Gate 5 is a stub (`passed: true`) | Medium — drawdown circuit breaker doesn't fire |
| Session filter | Handled separately in main loop | None (equivalent) |
| Day filter | Handled separately in main loop | None (equivalent) |
| FOTSI alignment gate | Present (Gate 17) | None |
| Protection: max daily loss $ | Not implemented | Medium — dollar-based daily loss limit doesn't fire |
| Spread filter (per-instrument) | Not implemented | Low-Medium |

The max drawdown gate being a stub is notable. If the live bot would stop trading at 15% drawdown, the backtest won't, potentially showing trades that would never have been taken.

### 3.8 No Walk-Forward or Out-of-Sample Validation

The backtest runs a single pass over the entire date range. There is no:

- Walk-forward testing (train on window A, test on window B, slide forward)
- Out-of-sample holdout
- Monte Carlo simulation
- Parameter sensitivity analysis

This is not a bug — it is a missing feature. But it means any parameter optimization done using this backtest is at risk of overfitting.

### 3.9 btRateMap Uses End-of-Period Rates

The `btRateMap` for quote-to-USD conversion is built from the last close of the daily candle data (line 1847). This means all trades in the backtest use the same conversion rate regardless of when they occurred. For a 6-month backtest where USD/JPY moved from 140 to 155, every trade's lot sizing and PnL uses the rate 155. This introduces a small but systematic bias.

---

## 4. Summary: Strengths vs Issues

| Category | Verdict |
|---|---|
| Detection logic reuse | **Excellent** — zero drift from shared library |
| Time-aware evaluation | **Excellent** — atMs, FOTSI timeline, SMT alignment |
| Analytics (factor/gate breakdown) | **Very good** — genuinely useful for strategy analysis |
| Config mapping fidelity | **Good** — mirrors bot-scanner's loadConfig closely |
| Exit simulation | **Adequate** — covers SL/TP/trailing/BE/partial, but simplified vs live |
| Confluence scoring | **Correct today, dangerous tomorrow** — duplicated, not shared |
| Spread simulation | **Weak** — global value, not per-instrument |
| Commission simulation | **Missing** — overstates profitability |
| Regime classification | **Inconsistent** — uses simpler local version instead of shared |
| Historical data depth | **Limited** — 500 candle cap regardless of date range |
| Drawdown circuit breaker | **Broken** — gate is a stub |
| Walk-forward / OOS | **Missing** — single-pass only |

---

## 5. Recommended Fixes (Priority Order)

1. **Extract confluence scoring into `_shared/confluenceScoring.ts`** — Eliminate the duplication. Both bot-scanner and backtest-engine import from the same module. This is the highest-impact, lowest-risk change.

2. **Use per-instrument `typicalSpread` for entry simulation** — Replace `spreadPips * spec.pipSize` with `spec.typicalSpread * spec.pipSize` in the entry price calculation. Keep the global `spreadPips` as an optional override.

3. **Add commission simulation** — Accept `commissionPerLot` as a backtest parameter. Deduct commission from PnL on every trade open/close. Factor it into the R:R gate.

4. **Use the shared `classifyInstrumentRegime`** — Delete the local lightweight version and import from smcAnalysis.ts.

5. **Implement the drawdown circuit breaker** — Track peak balance and stop opening new trades when drawdown exceeds `config.maxDrawdown`.

6. **Add structure invalidation to processExits** — Port the CHoCH-based SL tightening from scannerManagement.ts.

7. **Fix btRateMap to be time-varying** — Build a per-date rate map (similar to fotsiTimeline) so each trade uses the conversion rate from its entry date.

8. **Address the 500-candle limit** — Either document this limitation clearly in the UI, or implement pagination/chunking in the candle source to support longer backtests.

---

## 6. The Bottom Line

The backtest engine is **architecturally sound** in its most important aspect: it reuses the shared detection library and doesn't re-implement SMC analysis. The time-awareness (atMs, FOTSI timeline) and analytics (factor/gate breakdown) are genuinely well done.

The main risks are **maintenance-related** (duplicated confluence scoring will drift) and **simulation accuracy** (simplified exits, global spread, no commission). These don't make the backtest useless — they make it optimistic. Backtest results will look better than live results because costs are understated and exit management is simplified.

If you're using the backtest to compare strategies against each other (relative performance), it's reasonably reliable. If you're using it to predict actual dollar returns (absolute performance), it will overestimate by a meaningful margin.

The single most impactful fix is extracting the confluence scoring into a shared module. Everything else is incremental improvement.
