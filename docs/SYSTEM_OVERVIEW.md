# SMC Trading System — Complete Architecture Overview

## System Summary

This is a **live forex/crypto trading bot** built on Smart Money Concepts (SMC). It runs as a collection of Supabase Edge Functions that scan 16 currency pairs, detect high-probability setups using institutional order flow concepts, and execute trades through MetaAPI (MT4/MT5) and OANDA brokers. The system supports both paper trading and live execution with prop firm compliance.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Lovable/React)                      │
│  BotView │ Backtest │ Journal │ Chart │ GamePlan │ PropFirm │ Settings│
└────────────────────────────────┬────────────────────────────────────┘
                                 │ Supabase Client
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SUPABASE (PostgreSQL + Edge Functions)            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌───────────────────┐    ┌──────────────────┐  │
│  │ bot-scanner  │───▶│ paper-trading     │───▶│ broker-execute   │  │
│  │ (6512 lines) │    │ (position mgmt)   │    │ (OANDA/MetaAPI)  │  │
│  └──────┬───────┘    └───────────────────┘    └──────────────────┘  │
│         │                                                            │
│         │ uses _shared/                                              │
│         ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  smcAnalysis.ts (2567 lines) — Core SMC detection           │    │
│  │  directionEngine.ts — Top-down direction (D→4H→1H)          │    │
│  │  impulseZoneEngine.ts (1124 lines) — Zone scoring /11       │    │
│  │  unifiedZoneEngine.ts — NEW: Full story engine /14           │    │
│  │  confluenceScoring.ts — Tiered scoring (T1/T2/T3)           │    │
│  │  cascadeZoneEngine.ts — Daily cascade (being deprecated)     │    │
│  │  exitEngine.ts — Regime-adaptive TP + trailing SL            │    │
│  │  zoneLiquidity.ts — NEW: BSL/SSL near zones                  │    │
│  │  confirmationHierarchy.ts — NEW: Sweep+CHoCH hierarchy       │    │
│  │  regimeDetection.ts — Market regime classification           │    │
│  │  fotsiEngine.ts — FOTSI overbought/oversold                  │    │
│  │  inducementDetection.ts — Inducement/liquidity traps         │    │
│  │  zoneConfirmation.ts — 5m CHoCH for zone entries             │    │
│  │  scannerManagement.ts — Open-trade lifecycle                  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ SUPPORTING FUNCTIONS                                          │   │
│  │  zone-confirmation-scanner (1-min cron) — fast CHoCH poll     │   │
│  │  backtest-engine (2479 lines) — full bot-scanner parity       │   │
│  │  paper-trading (1648 lines) — position lifecycle + P&L        │   │
│  │  bot-daily-review — AI self-learning daily review             │   │
│  │  bot-weekly-advisor — deep strategy review                    │   │
│  │  outcome-tracker — trade post-mortem analysis                 │   │
│  │  strategy-advisor — AI recommendations                        │   │
│  │  fundamentals — economic calendar integration                 │   │
│  │  market-data — candle fetching (MetaAPI→TwelveData→Polygon)   │   │
│  │  telegram-notify — trade alerts                               │   │
│  │  prop-firm — compliance tracking                              │   │
│  │  data-cleanup — daily retention policy                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ DATABASE TABLES                                               │   │
│  │  bot_configs │ paper_positions │ paper_trade_history           │   │
│  │  paper_accounts │ scan_logs │ trades │ trade_reasonings        │   │
│  │  pending_orders │ staged_setups │ rejected_setups              │   │
│  │  broker_connections │ close_audit_log │ trade_post_mortems     │   │
│  │  backtest_runs │ prop_firm_config │ prop_firm_daily_state      │   │
│  │  user_settings │ config_presets │ kv_cache │ trade_archive     │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The Scan Pipeline (bot-scanner/index.ts — 6512 lines)

The bot-scanner is the **heart of the system**. It runs on a configurable interval (default 5 minutes) and processes each of the 16 watchlist pairs through a multi-stage pipeline:

### Stage 1: Data Fetching
- Fetches candles from MetaAPI (primary) with TwelveData and Polygon.io as fallbacks
- Timeframes: 15m, 1H, 4H, Daily
- Also fetches live spread data for gate calculations

### Stage 2: Market Structure Analysis (smcAnalysis.ts)
For each pair, the system detects:

| Concept | What it finds |
|---------|--------------|
| **Swing Points** | Fractal highs/lows (3-candle or 5-candle) |
| **BOS (Break of Structure)** | Price breaking a previous swing high/low |
| **CHoCH (Change of Character)** | First break against the prevailing trend |
| **Order Blocks (OB)** | Last opposing candle before an impulse move |
| **Fair Value Gaps (FVG)** | 3-candle imbalances (gaps in price) |
| **Liquidity Pools** | Equal highs/lows (BSL/SSL) |
| **Premium/Discount Zones** | Above/below 50% of the current range |
| **Support/Resistance** | Historical levels from line-chart analysis |

### Stage 3: Direction Engine (directionEngine.ts)
Determines trade direction using a **top-down approach**:

```
Daily Regime (trending/ranging/transitional)
    → 4H Structure (BOS direction, CHoCH)
        → 1H Confirmation (alignment check)
            → Final Direction: LONG or SHORT (or null = skip)
```

Key rules:
- Daily trending + 4H aligned = high confidence
- Daily ranging = look for 4H structure break
- 1H CHoCH against 4H direction = nullify (no trade)
- "Don't catch a falling knife" — never trade against the main trend

### Stage 4: Impulse Zone Engine (impulseZoneEngine.ts)
Finds the **best entry zone** within the impulse leg:

1. Identifies the impulse leg (BOS → swing extreme)
2. Maps all FVGs and OBs created by that impulse
3. Overlays Fibonacci retracement (50%, 61.8%, 71%, 78.6%, 88.6%)
4. Checks S/R alignment (line-chart historical levels)
5. Checks HTF confluence (does a higher TF FVG/OB/Fib align?)
6. Checks LTF refinement (can we narrow the zone on 15m?)
7. Scores the zone out of 11:

| Factor | Points | What it means |
|--------|--------|---------------|
| Zone type (FVG/OB) | 1.0 | Base detection |
| Fib level (61.8-78.6%) | 1.0-2.0 | Deeper = better |
| S/R alignment | 2.0 | Historical level confirms zone |
| HTF confluence | 1.5 | Higher TF zone overlaps |
| LTF refinement | 1.0 | 15m narrows the entry |
| Premium/Discount | 1.0 | Zone in correct market half |
| Impulse quality | 1.0 | Strong, clean impulse |
| Multi-zone | 0.5 | Multiple zones in same area |

### Stage 5: Unified Zone Engine (NEW — unifiedZoneEngine.ts)
Extends the impulse zone engine with:
- **Daily timeframe scanning** — finds Daily impulse + zone (highest priority)
- **Liquidity detection** — BSL/SSL near zone edges, sweep detection
- **Confirmation hierarchy** — Sweep+CHoCH > CHoCH > Displacement > Inducement
- **Continuation direction** — entry always WITH the impulse (not against it)
- **Story narrative** — full top-down explanation of why this zone matters
- Scores out of ~14 (base/9 + liquidity/3 + confirmation/2.5 + TF bonus/2)

### Stage 6: Confluence Scoring (confluenceScoring.ts)
Evaluates 10+ factors across 3 tiers:

**Tier 1 — Core Setup (must have ≥3 of 4):**
- Market Structure (BOS/CHoCH)
- Order Block
- Fair Value Gap
- Premium/Discount & Fib

**Tier 2 — Confirmation (7-10 factors):**
- HTF FVG/OB/Fib alignment
- Regime alignment
- Session/Kill Zone timing
- FOTSI (currency strength)
- Impulse zone score
- Displacement
- Inducement
- S/R level
- SMT divergence
- Volume confirmation

**Tier 3 — Bonus (3-10 factors):**
- Multi-timeframe alignment
- Clean structure
- Liquidity sweep
- News alignment
- Correlation filter

Total score: up to 24 points (8 T1 + 10 T2 + 5 T3 + bonus)

### Stage 7: Safety Gates (21 gates)
Every potential trade must pass ALL enabled gates:

| Gate | Name | What it checks |
|------|------|---------------|
| 1 | HTF Bias Alignment | Daily direction matches entry direction |
| 2 | Premium/Discount | Entry in correct market half |
| 3 | Structural Conviction | Fractal analysis on conviction TF |
| 3b | Reaction Confirmation | Ranging market reaction check |
| 4 | Instrument Enabled | Pair is in active watchlist |
| 4b | Max Open Positions | Portfolio-wide limit |
| 5 | Max Per Symbol | No duplicate same-direction trades |
| 6 | Portfolio Heat | Total risk % across all positions |
| 7 | Daily Loss Limit | % drawdown today |
| 8 | Max Drawdown | Account-level drawdown cap |
| 9 | Min Confluence | Score threshold |
| 9b | SMT Opposite Veto | SMT divergence opposing signal |
| 10 | Min R:R | Risk-reward after spread + commission |
| 11 | Opening Range | Wait for session open completion |
| 12 | Kill Zone Only | Trade only during active sessions |
| 13 | Cooldown | Time between trades |
| 14 | Max Consecutive Losses | Loss streak protection |
| 15 | Dollar Daily Loss | Net P&L dollar limit |
| 16 | News Event Filter | Block near high-impact events |
| 17 | FOTSI Filter | Currency strength overbought/oversold |
| 18 | ATR Volatility | Minimum volatility threshold |
| 19 | Tier 1 Minimum | Must have ≥3 core factors |
| 20 | Regime Alignment | Direction matches regime |
| 21 | Spread Quality | Info-only, never rejects |
| 22 | Correlation Filter | Prevent conflicting correlated positions |

### Stage 8: Trade Decision
If all gates pass:
1. Calculate position size (risk-based: account % / SL distance)
2. Determine entry type (market or limit at zone edge)
3. Set SL (below impulse origin) and TP (based on R:R and regime)
4. Insert into `paper_positions` table
5. If live mode: call `broker-execute` to mirror on MetaAPI/OANDA

---

## Trade Execution Flow

```
bot-scanner detects setup
    │
    ├─ All gates pass?
    │   ├─ YES → Insert paper_positions
    │   │         ├─ Live mode? → broker-execute (OANDA/MetaAPI)
    │   │         └─ Paper mode? → track P&L internally
    │   │
    │   └─ NO → Insert rejected_setups (with gate failure reasons)
    │
    └─ Zone found but price not there?
        └─ Insert pending_orders (status: "watching" or "awaiting_confirmation")
            └─ zone-confirmation-scanner (1-min cron) monitors these
                ├─ Price enters zone → status: "awaiting_confirmation"
                ├─ 5m CHoCH detected → ENTER TRADE
                ├─ Price leaves zone → reset to "pending"
                └─ Impulse invalidated → cancel order
```

---

## Position Management (paper-trading/index.ts)

Once a trade is open, the paper-trading function manages it:

| Action | Trigger | What happens |
|--------|---------|-------------|
| **SL Hit** | Price reaches stop loss | Close position, record loss |
| **TP Hit** | Price reaches take profit | Close position, record win |
| **Trailing SL** | Price moves in favor | Adjust SL using ATR-based trail |
| **Break-even** | Price reaches 1R profit | Move SL to entry |
| **Partial close** | Price reaches partial TP | Close 50% at first target |
| **Regime TP adjust** | Market regime changes | Tighten/widen TP based on regime |
| **Time expiry** | Max hold time exceeded | Close at market |

---

## Broker Execution (broker-execute/index.ts)

Supports two broker types:

**OANDA:**
- REST API v20
- Underscore symbol format (EUR_USD)
- Precision-aware pricing (JPY=3dp, forex=5dp, gold=2dp)

**MetaAPI (MT4/MT5):**
- Multi-region failover (London → New York → Singapore)
- Region caching per account
- Retry with exponential backoff
- Symbol override mapping (configurable per connection)

---

## Self-Learning System

The bot has built-in AI review capabilities:

**Daily Review (bot-daily-review):**
- Analyzes today's trades (wins, losses, missed setups)
- Identifies patterns in failures
- Suggests parameter adjustments

**Weekly Advisor (bot-weekly-advisor):**
- Deep statistical analysis of the week
- Gate effectiveness scoring
- Factor edge analysis (which factors predict winners?)
- Regime/session breakdown
- Concrete recommendations for next week

**Outcome Tracker:**
- Post-mortem analysis on closed trades
- Tracks which factors correlated with winners vs losers
- Feeds back into scoring weights over time

---

## Prop Firm Compliance (prop-firm/index.ts)

Tracks compliance with funded account rules:

- Daily drawdown limits (hard stop at threshold)
- Maximum drawdown (account lifetime)
- Profit targets (challenge phases)
- Trading day requirements
- News trading restrictions
- Weekend holding restrictions
- Daily state snapshots for audit trail

---

## Data Flow Summary

```
Market Data (MetaAPI/TwelveData/Polygon)
    → Candles (15m, 1H, 4H, Daily)
        → SMC Analysis (structure, zones, liquidity)
            → Direction Engine (D→4H→1H)
                → Impulse Zone Engine (best zone, score/11)
                → Unified Zone Engine (full story, score/14)
                    → Confluence Scoring (tiered, /24)
                        → Safety Gates (21 checks)
                            → Trade Decision (enter/reject/watch)
                                → Execution (paper + optional live mirror)
                                    → Position Management (SL/TP/trail)
                                        → Outcome Tracking (P&L, post-mortem)
                                            → Self-Learning (daily/weekly review)
```

---

## Key Configuration (bot_configs table)

The bot is highly configurable via the `config_json` column:

| Category | Key settings |
|----------|-------------|
| **Risk** | riskPerTrade (%), maxOpenPositions, maxPerSymbol, portfolioHeat, maxDrawdown |
| **Scoring** | minConfluence, tier1MinFactors, minRR |
| **Sessions** | killZones (London, NY, Tokyo, Sydney), openingRangeMinutes |
| **Instruments** | watchlist (16 pairs), symbol overrides |
| **Gates** | Each gate can be enabled/disabled independently |
| **Execution** | orderType (market/limit), slippage, spread tolerance |
| **Exit** | trailEnabled, trailATRMultiple, partialCloseEnabled, regimeTPAdjust |
| **Prop Firm** | dailyDrawdown, maxDrawdown, profitTarget, tradingDays |

---

## Current State & Recent Changes

**Working:**
- Full scan pipeline with 16 pairs
- Paper trading with P&L tracking
- Live execution via MetaAPI/OANDA
- Zone confirmation scanner (1-min cron)
- Backtest engine with full parity
- Prop firm compliance
- Telegram notifications
- AI daily/weekly reviews

**Recently Added (this session):**
- Unified Zone Engine — combines Daily detection + liquidity + confirmation into one story
- Zone Liquidity module — BSL/SSL detection near zones with sweep scoring
- Confirmation Hierarchy — ranked confirmation types with scoring
- Continuation direction logic — entries WITH the impulse, not against it
- Fixed cascade htfConfluenceData scope bug
- Fixed Daily impulse date/bar display
- Fixed JPY pip calculation

**Planned (next steps):**
- Wire unified engine score into gate decisions (replace standalone impulse zone as primary)
- Remove cascade engine from backend (once unified is validated)
- Add 5m data for 1H impulse confirmations
- Tune liquidity sweep timeout via backtest data

---

## File Size Reference

| File | Lines | Role |
|------|-------|------|
| bot-scanner/index.ts | 6,512 | Main scan pipeline |
| smcAnalysis.ts | 2,567 | Core SMC detection |
| backtest-engine/index.ts | 2,479 | Historical testing |
| bot-weekly-advisor/index.ts | 1,658 | AI weekly review |
| paper-trading/index.ts | 1,648 | Position management |
| impulseZoneEngine.ts | 1,124 | Zone scoring |
| bot-daily-review/index.ts | 1,124 | AI daily review |
| zone-confirmation-scanner/index.ts | 621 | Fast CHoCH polling |
| broker-execute/index.ts | 511 | Order routing |
| confluenceScoring.ts | ~800 | Tiered scoring |
| directionEngine.ts | ~600 | Direction determination |
| unifiedZoneEngine.ts | ~250 | NEW: Story engine |
| zoneLiquidity.ts | ~180 | NEW: Liquidity detection |
| confirmationHierarchy.ts | ~170 | NEW: Confirmation ranking |

**Total system: ~25,000+ lines of TypeScript across 21 edge functions and 15+ shared modules.**
