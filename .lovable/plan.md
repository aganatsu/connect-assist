

# Gap Analysis: What's Built vs. What's Missing

## Already Done
- Database: 9 tables with RLS (trades, bot_configs, broker_connections, paper_accounts, paper_positions, paper_trade_history, trade_reasonings, trade_post_mortems, user_settings)
- Auth: Email/password + Google OAuth, protected routes
- Edge Functions: market-data, smc-analysis, paper-trading, bot-config, trades, broker-connections, broker-execute, user-settings, fundamentals
- Pages: Dashboard, Chart, ICT Analysis, Bot Monitor, Journal, Backtest, Settings
- API layer: unified `src/lib/api.ts` client

## What's NOT Done Yet

### 1. Chart Page — Hardcoded Mock Data
The Chart page panels (Market Bias, Market Structure, Key Levels, Risk Calculator) show **static hardcoded values** (e.g. "Bullish", "1.0855"). It should call the `smc-analysis` Edge Function with real candle data, like the ICT Analysis page does.

### 2. Backtest — Client-Side Random Data Only
The Backtest page generates **random fake results** (`generateBacktestResults`). It should call the SMC analysis engine on historical candles from the market-data function. No Edge Function for backtesting exists.

### 3. Live Price Feed / WebSocket
No real-time price streaming. The spec calls for WebSocket at 5-second intervals with live bid/ask. Currently all data is fetched on-demand via REST. A polling approach (5-10s intervals) fetching quotes from the market-data function is the feasible alternative.

### 4. Dashboard — Live Prices Grid
The Dashboard shows balance/equity/positions but has **no live prices grid** showing current prices for all watched pairs.

### 5. Dashboard — Active Signals Panel
No display of current SMC signals with confluence scores before they become trades.

### 6. Journal — Manual Trade Entry
The Journal only displays trades fetched from the DB. There's no form to **manually add trades** with notes, screenshots, tags, setup type, or SMC context.

### 7. Journal — Performance Analytics per Pair/Setup
The Journal has basic stats but no **breakdown by pair or by setup type** (e.g. "BOS+OB win rate: 72%").

### 8. Fundamental Analysis Page
The `fundamentals` Edge Function exists but there's **no frontend page** for the economic calendar, event countdown timers, or news sentiment.

### 9. Bot Config — Editable Parameters
Settings shows bot config as read-only key/value pairs. The user can't **edit individual parameters** — only reset to defaults.

### 10. Currency Strength Meter
The SMC analysis function supports `currency_strength` but it's not displayed anywhere in the UI.

### 11. Pair Correlation Matrix
The SMC function supports `correlation` but no UI shows it.

### 12. Missing Pairs
Spec lists USD/CHF and EUR/JPY — these aren't in the instrument lists on most pages.

---

## Implementation Plan

### Step 1: Wire Chart Page to Real SMC Data
- Fetch candles via `marketApi.candles()` for the selected symbol/timeframe
- Call `smcApi.fullAnalysis()` and populate the side panels with real structure, bias, order blocks, FVGs, and key levels
- Add a dynamic risk calculator using account balance from paper-trading status

### Step 2: Build Backtest Edge Function
- Create `supabase/functions/backtest/index.ts` that fetches historical candles, runs SMC analysis bar-by-bar, simulates entries/exits based on confluence scoring
- Update `Backtest.tsx` to call the edge function instead of generating random data
- Display real equity curve, drawdown, monthly P&L from the engine output

### Step 3: Live Prices Grid on Dashboard
- Add a polling query (10s interval) that fetches quotes for all watched pairs via `marketApi.quote()`
- Display a price grid with bid/ask, spread, daily change, and session indicator
- Add active signals section showing pending SMC setups with confluence scores

### Step 4: Create Fundamentals Page
- New `src/pages/Fundamentals.tsx` with economic calendar view
- Call `fundamentalsApi.data()` to get events, display with impact badges (high/medium/low)
- Event countdown timers, currency-pair mapping
- Add route to App.tsx and sidebar nav

### Step 5: Journal Manual Trade Entry + Analytics
- Add a dialog/form for manual trade entry with fields: symbol, direction, entry/exit price, notes, setup type, screenshot URL, timeframe, tags
- Add "Performance by Pair" and "Performance by Setup" tab with win rate / profit factor breakdowns
- Wire `tradesApi.create()` for manual entries

### Step 6: Editable Bot Config
- Replace read-only config display with editable form fields (inputs, switches, selects)
- Group by category (strategy, risk, entry, exit, instruments, sessions)
- Call `botConfigApi.update()` on save
- Add strategy presets (conservative, moderate, aggressive)

### Step 7: Currency Strength + Correlation
- Add a "Market Overview" section to Dashboard or ICT Analysis showing currency strength meter (bar chart)
- Add correlation matrix display (heatmap or table)
- Call `smcApi.currencyStrength()` and `smcApi.correlation()`

### Step 8: Add Missing Pairs + Polish
- Add USD/CHF, EUR/JPY, NZD/USD to all instrument lists
- Add live quote polling to Chart page header (current price + spread)
- Session/killzone indicator on Chart page

