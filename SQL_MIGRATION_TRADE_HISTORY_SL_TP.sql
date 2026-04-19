-- Migration: Add stop_loss and take_profit columns to paper_trade_history
-- Purpose: Enable accurate RR (risk-reward) calculation in AI advisor reviews
-- Run this in Supabase SQL Editor

-- Step 1: Add the columns
ALTER TABLE paper_trade_history
  ADD COLUMN IF NOT EXISTS stop_loss text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS take_profit text DEFAULT NULL;

-- Step 2: Backfill existing records from paper_positions (for any still-open positions)
-- Note: Most closed positions are already deleted from paper_positions,
-- so this will only backfill trades that have matching open positions.
-- Historical trades without SL data will remain NULL.
UPDATE paper_trade_history pth
SET
  stop_loss = pp.stop_loss,
  take_profit = pp.take_profit
FROM paper_positions pp
WHERE pth.position_id = pp.position_id
  AND pth.user_id = pp.user_id
  AND pth.stop_loss IS NULL;

-- Step 3: Verify
SELECT
  COUNT(*) AS total_trades,
  COUNT(stop_loss) AS trades_with_sl,
  COUNT(take_profit) AS trades_with_tp
FROM paper_trade_history;
