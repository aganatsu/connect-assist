# Backtest Engine Architecture (Post-Fix)

**Date:** April 22, 2026
**Scope:** `supabase/functions/backtest-engine/index.ts` and its shared dependencies

---

## 1. What the Backtest Does

The backtest engine replays your bot-scanner's decision logic against historical candle data to estimate how a given configuration would have performed over a date range. It produces a list of simulated trades, an equity curve, performance statistics, and factor/gate analytics that tell you which SMC factors contributed to wins vs losses and which safety gates blocked would-have-been trades.

It is a **Supabase Edge Function** that accepts a POST request and returns JSON. It runs entirely server-side in Deno.

---

## 2. End-to-End Flow

The engine executes in seven sequential stages. Each stage feeds the next.

### Stage 1: Request Parsing & Config Mapping

The handler receives a JSON body with:

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `instruments` | `string[]` | All 28 FX pairs + indices + metals | Symbols to backtest |
| `startDate` | ISO date string | required | Backtest window start |
| `endDate` | ISO date string | required | Backtest window end |
| `startingBalance` | number | 10000 | Initial account balance in USD |
| `config` | object | `{}` | Same shape as `bot_configs.config_json` |
| `tradingStyle` | string | none | Optional style override (scalper/day/swing) |
| `slippagePips` | number | 0.5 | Simulated slippage on SL fills |
| `spreadPips` | number | 0 | 0 = use per-instrument `typicalSpread` from SPECS |

The raw config is passed through `mapConfig()`, which normalizes the nested `strategy.*`, `risk.*`, `entry.*`, `exit.*`, `sessions.*`, `instruments.*`, and `protection.*` fields into a flat config object. This mirrors the bot-scanner's `loadConfig()` function. Backward compatibility is preserved: the mapper accepts both `confluenceThreshold` (new, percentage) and the legacy `minConfluenceScore` (old, 1-10 scale).

If a `tradingStyle` is provided, `STYLE_OVERRIDES` from `smcAnalysis.ts` are applied on top, but the user's `minConfluence` is preserved (not overwritten by the style).

### Stage 2: Historical Data Fetching

For each instrument, the engine fetches two sets of candles:

**Entry-timeframe candles** (e.g., 15m, 5m, 1h) — these are the bars the engine steps through. The data source priority is:

1. **TwelveData date-range API** — preferred, supports up to 5000 candles per request with pagination (up to 100k candles total). Uses `start_date`/`end_date` parameters for precise coverage.
2. **Yahoo Finance** — fallback if TwelveData returns fewer than 30 candles. Uses range strings (3mo, 6mo, 1y, 2y).
3. **Shared `fetchCandlesWithFallback`** — last resort, uses the same candle source as the live scanner but with a 5000-candle limit.

**Daily candles** — fetched separately for HTF bias analysis, regime classification, PD/PW level calculation, and FOTSI computation. Always fetched with a 2-year range to ensure sufficient lookback.

**SMT correlated-pair candles** — if the instrument has a defined SMT pair (e.g., EUR/USD ↔ GBP/USD) and SMT is enabled, the correlated pair's entry-timeframe candles are also fetched.

A lookback buffer is added before `startDate` to ensure the analysis window has enough history on the first evaluation bar. The buffer size depends on the interval: 60 days for daily, 30 days for 4h, 14 days for 1h, 7 days for 15m/5m.

### Stage 3: FOTSI Timeline Construction

The engine builds a **per-day FOTSI snapshot timeline** to avoid lookahead bias. This is the most computationally expensive part of the setup phase.

The process works as follows. Daily candles for all 28 major FX pairs are fetched (in batches of 7 to respect rate limits). For each unique trading date in the backtest range, a FOTSI snapshot is computed using only daily candles up to and including that date. This produces a `Map<string, FOTSIResult>` where each key is a date string and each value contains the 8-currency True Strength Index readings.

During the main loop, each bar looks up the FOTSI snapshot for its date. If no snapshot exists for that exact date (weekends, holidays), the most recent prior snapshot is used. This means FOTSI in the backtest is **daily resolution** — it does not change intrabar. The live bot-scanner gets fresh FOTSI on every scan cycle (typically every 15 minutes), so this is a known accuracy gap.

### Stage 4: Rate Map Construction

A `btRateMap` is built for cross-pair lot sizing and PnL conversion. For each major rate pair (USD/JPY, GBP/USD, AUD/USD, NZD/USD, USD/CAD, USD/CHF), the last daily close is extracted from the already-fetched candle data. If any pairs are missing, they are fetched separately.

**Known limitation:** The rate map uses a single static rate (the last close in the dataset) for all trades regardless of when they occurred. For a 6-month backtest where USD/JPY moved from 140 to 155, every trade uses 155 for conversion. This introduces a small systematic bias in PnL calculations for cross-currency pairs.

### Stage 5: Sliding Window Main Loop

This is the core of the engine. For each instrument, the engine steps through the entry-timeframe candles from the start of the date range to the end.

**STEP size** is dynamically calculated based on the entry timeframe and the configured scan interval:

```
STEP = max(1, round(scanIntervalMinutes / candleMinutes))
```

For example, with 15-minute candles and a 15-minute scan interval, STEP = 1 (evaluate every candle). With 5-minute candles and a 15-minute scan interval, STEP = 3 (evaluate every 3rd candle). This matches the bot-scanner's actual scan frequency.

On each evaluation step, the engine performs the following sequence:

**5a. Exit Processing (every candle, not just STEP candles)**

Before evaluating new entries, the engine processes exits on all intermediate candles between the previous STEP and the current one. This ensures that SL/TP hits on candles between evaluation points are not missed. The exit engine (`processExits`) handles:

1. **Break-even activation** — if the candle's best price (high for longs, low for shorts) reaches the BE trigger distance from entry, the SL is moved to entry + 1 pip.
2. **Trailing stop** — if activated (after 1R or after a fixed pip distance), the SL trails from the candle's best price minus the trail distance. The SL only moves in the favorable direction.
3. **SL/TP hit detection** — checks if the candle's low (for longs) or high (for shorts) breaches the SL, and if the candle's high (for longs) or low (for shorts) reaches the TP.
4. **Same-candle disambiguation** — if both SL and TP are hit on the same candle, the engine uses proximity to the candle's open price to determine which was hit first. Whichever level is closer to the open is assumed to have been hit first.
5. **Max hold hours** — if the elapsed time since entry exceeds the configured maximum, the position is closed at the candle's close.
6. **Partial TP** — if enabled and not yet fired, checks if the candle reaches the partial TP trigger level (default: 1R). If hit, closes a percentage of the position at the trigger price and marks the partial TP as fired.

**5b. Weekend Gap Detection**

For FX and index instruments (not crypto), candles on Saturday (day 6) and Sunday (day 0) are skipped entirely. This matches the bot-scanner's behavior of not scanning during weekends.

**5c. Session Filtering**

The candle's timestamp is passed to `detectSession()` to determine which trading session it falls in (Asian, London, New York, Off-Hours). If the config has `enabledSessions` set (e.g., `["london", "newyork"]`), candles outside those sessions are skipped. Instruments with `skipSessionGate: true` in their asset profile (e.g., crypto, gold) bypass this filter.

**5d. Day-of-Week Filtering**

If the candle's day of week is not in `config.enabledDays`, it is skipped (FX only).

**5e. Confluence Analysis**

The engine runs `runConfluenceAnalysis()` on a sliding window of the last 80 candles. This is a **local copy** of the scoring logic (not imported from a shared module), but it uses all the same shared detection functions from `smcAnalysis.ts`:

The analysis evaluates 20 factors across 9 groups:

| Group | Factors | Max Points |
|---|---|---|
| Market Structure | BOS/CHoCH + Trend | 2.5 |
| Daily Bias | HTF Trend | 1.0 |
| Order Flow Zones | OB + FVG + Breaker + Unicorn | 3.0 |
| Premium/Discount & Fib | P/D Zone + PD/PW Levels | 2.5 |
| Timing | Kill Zone + Silver Bullet + Macro Window | 1.5 |
| Price Action | Judas + Reversal + Sweep + Displacement | 2.5 |
| AMD / Power of 3 | AMD Phase + Po3 Combo | 1.5 |
| Macro Confirmation | SMT + Currency Strength + Regime | 2.0 |
| Volume Profile | TPO-based Volume Profile | 0.75 |

After raw scoring, the engine applies:
- **Anti-double-count rules** (e.g., Unicorn absorbs Breaker + FVG scores)
- **Group caps** (no group can exceed its maximum)
- **Regime alignment adjustment** (bonus/penalty based on whether the setup type matches the current market regime)
- **Percentage normalization** — the raw score is converted to a 0-100% scale based on the sum of enabled factor weights

Time-dependent factors (session, Silver Bullet, macro window, AMD) use the candle's timestamp (`atMs`), not the current wall-clock time. This is critical for backtest accuracy.

**5f. Confluence Threshold Gate**

A single check: `analysis.score < config.minConfluence`. If the percentage score is below the threshold, the candle is skipped. There are no longer separate `minFactorCount` or `minStrongFactors` gates — these were collapsed into this single percentage threshold.

**5g. Safety Gates**

If the confluence threshold passes and a direction is determined, the engine runs 10 safety gates:

| Gate | What It Checks |
|---|---|
| Max Open Positions | Total open positions < `maxOpenPositions` |
| Max Per Symbol | Positions on this symbol < `maxPerSymbol` |
| Duplicate Direction | No existing position in the same direction on this symbol |
| Min RR (spread-adjusted) | Effective R:R after spread cost >= `minRiskReward` |
| Drawdown Circuit Breaker | `(peakBalance - balance) / peakBalance < maxDrawdown%` |
| Daily Loss Limit | Today's realized loss < `maxDailyLoss%` of balance |
| Portfolio Heat | Total open risk < `portfolioHeat%` of balance |
| Cooldown | Enough time since last trade on this symbol |
| Consecutive Losses | Consecutive losing trades < `maxConsecutiveLosses` |
| Kill Zone Only | If enabled, must be in a kill zone |
| FOTSI Veto | If enabled, checks for overbought/oversold currency conditions |

All gates must pass for a trade to be opened.

**5h. Close on Reverse**

If enabled and there are open positions in the opposite direction on this symbol, they are closed at the current price (with spread cost applied to the exit).

**5i. SL/TP Recalculation**

The SL is recalculated using the asset-adjusted buffer (`slBufferPips * assetProfile.slBufferMultiplier`) and recent swing points. The TP is set at `risk * tpRatio` from entry.

**5j. Spread Simulation**

The entry price is adjusted by half the spread:
- Longs: `lastPrice + (spreadCost / 2)` (buying at the ask)
- Shorts: `lastPrice - (spreadCost / 2)` (selling at the bid)

The spread is per-instrument from `SPECS[symbol].typicalSpread` when `spreadPips = 0`, or uses the user's global override if `spreadPips > 0`.

**5k. Position Sizing**

Supports three methods: `percent_risk` (default, risks X% of balance per trade), `fixed_lot` (constant lot size), and `volatility_adjusted` (ATR-based scaling). Cross-pair conversion uses the `btRateMap`.

**5l. Position Opening**

The position is added to `openPositions` with all exit flags (trailing stop, break-even, partial TP, max hold hours) configured from the mapped config.

### Stage 6: Cleanup

After the main loop, any remaining open positions are closed at the last candle's close price with close reason `backtest_end`.

### Stage 7: Stats & Response

The engine calculates comprehensive statistics from the trade list:

| Stat | Description |
|---|---|
| Win Rate | Wins / total full trades (excludes partial TP fragments) |
| Profit Factor | Gross profit / gross loss |
| Max Drawdown | Peak-to-trough in both $ and % |
| Sharpe Ratio | Annualized (√252) from daily return approximation |
| Avg RR | Average win pips / average loss pips |
| Expectancy | Total PnL / total trades |
| Trades/Month | Total trades / months in range |
| Long/Short Win Rates | Separate win rates by direction |
| Consecutive Wins/Losses | Longest winning and losing streaks |

The response also includes:
- **`factorBreakdown`** — for each factor, how many times it appeared, and how many of those trades won vs lost
- **`gateBreakdown`** — for each gate, how many times it blocked a trade
- **`dataCoverage`** — per-instrument candle counts and date ranges
- **`equityCurve`** — balance after each trade close

---

## 3. What's Shared with the Bot Scanner

The backtest imports all detection functions from `_shared/smcAnalysis.ts`. This means the following are **identical** between the live scanner and the backtest:

- Market structure analysis (BOS, CHoCH, swing points, trend classification)
- Order block detection, FVG detection, liquidity pool detection
- Displacement detection and quality tagging
- Breaker block and unicorn setup detection
- Premium/discount zone calculation
- PD/PW level calculation
- Judas swing and reversal candle detection
- ATR calculation
- SL/TP calculation
- Position sizing
- PnL calculation
- Session detection, Silver Bullet, macro window, AMD phase detection
- SMT divergence detection
- Instrument specs (SPECS), asset profiles, style overrides
- Regime classification (now imported from shared module, was previously a local copy)

The FOTSI computation is also shared (`_shared/fotsi.ts`), including `computeFOTSI`, `getCurrencyAlignment`, and `checkOverboughtOversoldVeto`.

---

## 4. What's NOT Shared (Duplicated or Different)

### 4a. Confluence Scoring Function

The `runConfluenceAnalysis()` function in the backtest engine is a **local copy** of the scoring logic, not imported from a shared module. It uses the same factor weights, group caps, anti-double-count rules, and percentage normalization as the bot-scanner's version, but they are maintained separately. If someone changes the scoring logic in the bot-scanner without updating the backtest engine (or vice versa), the two will drift.

This is the single biggest maintenance risk in the codebase.

### 4b. Exit Management

The live bot-scanner uses `scannerManagement.ts` for trade management, which includes:
- Structure-aware SL tightening (CHoCH-based)
- Config-driven execution profiles
- Structured exit attribution metadata

The backtest's `processExits()` is a simplified version that handles SL/TP/trailing/BE/partial TP but does **not** implement structure-aware SL tightening. This means the backtest's exit behavior is less aggressive about protecting profits than the live system.

### 4c. Data Pipeline

The bot-scanner fetches candles from live market feeds (MetaAPI broker connection → TwelveData → Yahoo). The backtest fetches historical candles from TwelveData's date-range API → Yahoo range API → shared fetcher. The candle shape is identical, but the data sources and freshness are fundamentally different.

### 4d. FOTSI Resolution

The bot-scanner computes FOTSI from the latest daily candles on every scan cycle. The backtest uses pre-computed daily snapshots. This means intraday FOTSI changes are invisible to the backtest.

---

## 5. What Was Fixed (April 2026)

| Fix | Before | After |
|---|---|---|
| Threshold collapse | Three gates: `minConfluence`, `minStrongFactors`, `minFactorCount` | Single gate: `analysis.score < config.minConfluence` (percentage) |
| Spread simulation | Global `spreadPips` applied to all instruments | Per-instrument `SPECS[symbol].typicalSpread` when `spreadPips=0` |
| STEP calculation | Hardcoded `STEP = 4` | Dynamic: `round(scanIntervalMinutes / candleMinutes)` |
| Weekend handling | No weekend detection | FX/index candles on Sat/Sun skipped |
| Drawdown breaker | Stub returning `pass: true` | Real check: `(peakBalance - balance) / peakBalance > maxDrawdown%` |
| Regime classifier | Local 60-line copy | Import from `_shared/smcAnalysis.ts` |

---

## 6. Known Remaining Gaps

### 6a. No Commission Simulation

The backtest does not deduct commission on trade open/close. This means profitability is overstated, especially for high-frequency configurations. A typical ECN commission of $7/lot round-trip on a 0.1 lot trade is $0.70 — small per trade but compounds over hundreds of trades.

### 6b. No Walk-Forward or Out-of-Sample Testing

The backtest runs a single pass over the entire date range. There is no mechanism to train on one period and test on another, which means any parameter optimization using backtest results is at risk of overfitting.

### 6c. Static Rate Map

All cross-pair PnL conversions use a single exchange rate (the last daily close in the dataset). For long backtests with significant rate movement, this introduces systematic bias.

### 6d. No Automated Validation Test

There is currently no deterministic test that runs a known candle sequence through the engine and asserts exact trade outcomes. This means there is no way to verify correctness after code changes.

### 6e. Confluence Scoring Duplication

The scoring function is maintained separately in the backtest engine and the bot-scanner. Any change to one must be manually replicated in the other.

---

## 7. How to Interpret Results

**If you're comparing strategies against each other** (relative performance), the backtest is reasonably reliable. The same biases apply to all configurations, so relative rankings are meaningful.

**If you're predicting actual dollar returns** (absolute performance), the backtest will overestimate by a meaningful margin because:
- No commission is deducted
- Exit management is simplified (no structure-aware SL tightening)
- FOTSI is daily-resolution (less precise currency strength filtering)
- The rate map is static (cross-pair PnL slightly off)

A reasonable rule of thumb: expect live results to be 15-30% worse than backtest results, depending on how active the configuration is.
