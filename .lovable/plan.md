

# System Audit — Data Mismatches & Disconnected UI

After inspecting the edge functions, API responses, and frontend code, here are all the issues found and the plan to fix them.

---

## Issues Found

### 1. Close Position Button Broken (BotView)
**Line 215** calls `paperApi.closePosition(p.positionId)` but the status response maps the field as `p.id` (from `position_id`). The `positionId` property doesn't exist on the mapped object, so closing trades silently fails.
**Fix:** Change to `paperApi.closePosition(p.id)` — the backend expects `positionId` which matches `position_id` in the DB, and `p.id` in the frontend is mapped from `position_id`.

### 2. Daily P&L Always Zero
The `paper-trading` status action hardcodes `dailyPnl: 0` (line 216). It never calculates the actual daily P&L from today's closed trades.
**Fix:** Compute daily P&L from `paper_trade_history` where `closed_at` starts with today's date, sum the `pnl` values.

### 3. Dashboard Stats Disconnected from Bot Data
The Dashboard's KPI cards pull `winRate`, `totalTrades`, `wins`, `losses` from `tradesApi.stats()` — which queries the **`trades`** table (Journal). But bot trades go to `paper_trade_history`. These are two completely separate tables. The Journal `trades` table has 0 entries, so dashboard always shows 0 wins, 0 trades, 0% win rate.
**Fix:** Dashboard should pull stats from `paperApi.status()` which already returns `winRate`, `wins`, `losses`, `totalTrades` from `paper_trade_history`. Remove the separate `tradesApi.stats()` call on Dashboard.

### 4. Equity Curve Shows Fake Data
`tradesApi.equityCurve()` queries the `trades` table (empty). When empty, the Dashboard generates random mock data. Meanwhile real trade history is in `paper_trade_history`.
**Fix:** Add an `equity_curve` computation to the `paper-trading` edge function using `paper_trade_history`, and call that from the Dashboard instead.

### 5. Dashboard "Open Positions" KPI Shows Exposure as $0
The exposure calculation `positions.reduce((s, p) => s + Math.abs(p.pnl || 0), 0)` is labeled "exposure" but actually sums P&L. Should show margin used or notional value.
**Fix:** Label it "Unrealized P&L" instead, which is what it actually shows.

### 6. XAG/USD Missing from Instruments
`INSTRUMENTS` list in `marketData.ts` has 12 entries but XAG/USD is missing (only 11 unique + BTC). The `WATCHED_PAIRS` on Dashboard include `USD/CHF` and `EUR/JPY` which aren't in the original 10. Minor inconsistency but not a data bug.

### 7. `entryPrice` Sent as 0 for Market Orders
When placing a market order from BotView, `orderTrigger` is empty (hidden for market type), so `parseFloat(orderTrigger) || 0` sends `entryPrice: 0`. The position gets stored with `entry_price: "0"`, making P&L calculations meaningless.
**Fix:** For market orders, fetch the current live price before placing the order, or have the edge function fetch it server-side when `entryPrice` is 0.

### 8. `ScanLogLine` and `BotConfigModal` ref warnings
Console shows "Function components cannot be given refs" for `AppShell`, `ScanLogLine`, and `BotConfigModal`. These are cosmetic React warnings but indicate incorrect ref passing.

---

## Implementation Plan

### Step 1: Fix Close Position Button (BotView)
Change `paperApi.closePosition(p.positionId)` to `paperApi.closePosition(p.id)` on line 215.

### Step 2: Fix Dashboard Data Source
In `Index.tsx`, remove the separate `tradesApi.stats()` and `tradesApi.equityCurve()` queries. Instead, derive all stats from the already-fetched `botStatus` (`paperApi.status()`).

### Step 3: Compute Daily P&L Server-Side
In `paper-trading/index.ts` status action, query today's closed trades from `paper_trade_history` and sum P&L instead of returning `dailyPnl: 0`.

### Step 4: Build Equity Curve from Paper History
In `paper-trading/index.ts`, add equity curve data to the status response (or as a separate action) using `paper_trade_history` sorted by `closed_at`.

### Step 5: Fix Market Order Entry Price
In `paper-trading/index.ts` `place_order` action, when `entryPrice` is 0, fetch live price via Yahoo Finance before storing. This ensures market orders have real entry prices.

### Step 6: Fix Exposure Label
Change "exposure" label to "Unrealized P&L" on Dashboard KPI card.

### Step 7: Fix React Ref Warnings
Wrap `ScanLogLine` and `BotConfigModal` with `React.forwardRef` or remove ref passing from parent.

**Files to edit:**
- `src/pages/Index.tsx` — Steps 2, 6
- `src/pages/BotView.tsx` — Steps 1, 7
- `src/components/BotConfigModal.tsx` — Step 7
- `supabase/functions/paper-trading/index.ts` — Steps 3, 4, 5

