-- C3: Convert monetary TEXT columns to NUMERIC for data integrity
-- ⚠️ IMPORTANT: Run this on a staging database first!
-- ⚠️ Keep _old columns for at least 1 week before dropping them.
--
-- This migration uses a safe 3-step approach:
-- 1. Add new NUMERIC columns alongside existing TEXT columns
-- 2. Copy data with CAST (handling nulls and empty strings)
-- 3. Rename old columns to _old, rename new columns to original names
--
-- After verifying everything works, run the cleanup migration to drop _old columns.

-- ═══════════════════════════════════════════════════════════════════
-- Step 1: paper_positions
-- Actual columns: entry_price, current_price, size, stop_loss, take_profit, signal_score
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS entry_price_new NUMERIC(20, 8);
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS size_new NUMERIC(20, 8);
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS stop_loss_new NUMERIC(20, 8);
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS take_profit_new NUMERIC(20, 8);
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS current_price_new NUMERIC(20, 8);

UPDATE paper_positions SET
  entry_price_new = CASE WHEN entry_price IS NOT NULL AND entry_price != '' THEN CAST(entry_price AS NUMERIC) ELSE 0 END,
  size_new = CASE WHEN size IS NOT NULL AND size != '' THEN CAST(size AS NUMERIC) ELSE 0 END,
  stop_loss_new = CASE WHEN stop_loss IS NOT NULL AND stop_loss != '' THEN CAST(stop_loss AS NUMERIC) ELSE NULL END,
  take_profit_new = CASE WHEN take_profit IS NOT NULL AND take_profit != '' THEN CAST(take_profit AS NUMERIC) ELSE NULL END,
  current_price_new = CASE WHEN current_price IS NOT NULL AND current_price != '' THEN CAST(current_price AS NUMERIC) ELSE NULL END;

ALTER TABLE paper_positions RENAME COLUMN entry_price TO entry_price_old;
ALTER TABLE paper_positions RENAME COLUMN entry_price_new TO entry_price;
ALTER TABLE paper_positions RENAME COLUMN size TO size_old;
ALTER TABLE paper_positions RENAME COLUMN size_new TO size;
ALTER TABLE paper_positions RENAME COLUMN stop_loss TO stop_loss_old;
ALTER TABLE paper_positions RENAME COLUMN stop_loss_new TO stop_loss;
ALTER TABLE paper_positions RENAME COLUMN take_profit TO take_profit_old;
ALTER TABLE paper_positions RENAME COLUMN take_profit_new TO take_profit;
ALTER TABLE paper_positions RENAME COLUMN current_price TO current_price_old;
ALTER TABLE paper_positions RENAME COLUMN current_price_new TO current_price;

-- ═══════════════════════════════════════════════════════════════════
-- Step 2: paper_trade_history
-- Actual columns: entry_price, exit_price, size, pnl, pnl_pips
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE paper_trade_history ADD COLUMN IF NOT EXISTS entry_price_new NUMERIC(20, 8);
ALTER TABLE paper_trade_history ADD COLUMN IF NOT EXISTS exit_price_new NUMERIC(20, 8);
ALTER TABLE paper_trade_history ADD COLUMN IF NOT EXISTS size_new NUMERIC(20, 8);
ALTER TABLE paper_trade_history ADD COLUMN IF NOT EXISTS pnl_new NUMERIC(20, 8);
ALTER TABLE paper_trade_history ADD COLUMN IF NOT EXISTS pnl_pips_new NUMERIC(20, 4);

UPDATE paper_trade_history SET
  entry_price_new = CASE WHEN entry_price IS NOT NULL AND entry_price != '' THEN CAST(entry_price AS NUMERIC) ELSE 0 END,
  exit_price_new = CASE WHEN exit_price IS NOT NULL AND exit_price != '' THEN CAST(exit_price AS NUMERIC) ELSE NULL END,
  size_new = CASE WHEN size IS NOT NULL AND size != '' THEN CAST(size AS NUMERIC) ELSE 0 END,
  pnl_new = CASE WHEN pnl IS NOT NULL AND pnl != '' THEN CAST(pnl AS NUMERIC) ELSE 0 END,
  pnl_pips_new = CASE WHEN pnl_pips IS NOT NULL AND pnl_pips != '' THEN CAST(pnl_pips AS NUMERIC) ELSE 0 END;

ALTER TABLE paper_trade_history RENAME COLUMN entry_price TO entry_price_old;
ALTER TABLE paper_trade_history RENAME COLUMN entry_price_new TO entry_price;
ALTER TABLE paper_trade_history RENAME COLUMN exit_price TO exit_price_old;
ALTER TABLE paper_trade_history RENAME COLUMN exit_price_new TO exit_price;
ALTER TABLE paper_trade_history RENAME COLUMN size TO size_old;
ALTER TABLE paper_trade_history RENAME COLUMN size_new TO size;
ALTER TABLE paper_trade_history RENAME COLUMN pnl TO pnl_old;
ALTER TABLE paper_trade_history RENAME COLUMN pnl_new TO pnl;
ALTER TABLE paper_trade_history RENAME COLUMN pnl_pips TO pnl_pips_old;
ALTER TABLE paper_trade_history RENAME COLUMN pnl_pips_new TO pnl_pips;

-- ═══════════════════════════════════════════════════════════════════
-- Step 3: paper_accounts
-- Actual columns: balance, peak_balance, daily_pnl_base
-- (equity and total_pnl do NOT exist on this table)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS balance_new NUMERIC(20, 8);
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS peak_balance_new NUMERIC(20, 8);
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS daily_pnl_base_new NUMERIC(20, 8);

UPDATE paper_accounts SET
  balance_new = CASE WHEN balance IS NOT NULL AND balance != '' THEN CAST(balance AS NUMERIC) ELSE 10000 END,
  peak_balance_new = CASE WHEN peak_balance IS NOT NULL AND peak_balance != '' THEN CAST(peak_balance AS NUMERIC) ELSE 10000 END,
  daily_pnl_base_new = CASE WHEN daily_pnl_base IS NOT NULL AND daily_pnl_base != '' THEN CAST(daily_pnl_base AS NUMERIC) ELSE 10000 END;

ALTER TABLE paper_accounts RENAME COLUMN balance TO balance_old;
ALTER TABLE paper_accounts RENAME COLUMN balance_new TO balance;
ALTER TABLE paper_accounts RENAME COLUMN peak_balance TO peak_balance_old;
ALTER TABLE paper_accounts RENAME COLUMN peak_balance_new TO peak_balance;
ALTER TABLE paper_accounts RENAME COLUMN daily_pnl_base TO daily_pnl_base_old;
ALTER TABLE paper_accounts RENAME COLUMN daily_pnl_base_new TO daily_pnl_base;

-- ═══════════════════════════════════════════════════════════════════
-- Step 4: trades table
-- Actual columns: entry_price, exit_price, stop_loss, take_profit,
--   position_size, risk_reward, risk_percent, pnl_pips, pnl_amount
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_price_new NUMERIC(20, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_price_new NUMERIC(20, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS stop_loss_new NUMERIC(20, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS take_profit_new NUMERIC(20, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS position_size_new NUMERIC(20, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS risk_reward_new NUMERIC(10, 4);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS risk_percent_new NUMERIC(10, 4);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pnl_pips_new NUMERIC(20, 4);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pnl_amount_new NUMERIC(20, 8);

UPDATE trades SET
  entry_price_new = CASE WHEN entry_price IS NOT NULL AND entry_price != '' THEN CAST(entry_price AS NUMERIC) ELSE NULL END,
  exit_price_new = CASE WHEN exit_price IS NOT NULL AND exit_price != '' THEN CAST(exit_price AS NUMERIC) ELSE NULL END,
  stop_loss_new = CASE WHEN stop_loss IS NOT NULL AND stop_loss != '' THEN CAST(stop_loss AS NUMERIC) ELSE NULL END,
  take_profit_new = CASE WHEN take_profit IS NOT NULL AND take_profit != '' THEN CAST(take_profit AS NUMERIC) ELSE NULL END,
  position_size_new = CASE WHEN position_size IS NOT NULL AND position_size != '' THEN CAST(position_size AS NUMERIC) ELSE NULL END,
  risk_reward_new = CASE WHEN risk_reward IS NOT NULL AND risk_reward != '' THEN CAST(risk_reward AS NUMERIC) ELSE NULL END,
  risk_percent_new = CASE WHEN risk_percent IS NOT NULL AND risk_percent != '' THEN CAST(risk_percent AS NUMERIC) ELSE NULL END,
  pnl_pips_new = CASE WHEN pnl_pips IS NOT NULL AND pnl_pips != '' THEN CAST(pnl_pips AS NUMERIC) ELSE NULL END,
  pnl_amount_new = CASE WHEN pnl_amount IS NOT NULL AND pnl_amount != '' THEN CAST(pnl_amount AS NUMERIC) ELSE NULL END;

ALTER TABLE trades RENAME COLUMN entry_price TO entry_price_old;
ALTER TABLE trades RENAME COLUMN entry_price_new TO entry_price;
ALTER TABLE trades RENAME COLUMN exit_price TO exit_price_old;
ALTER TABLE trades RENAME COLUMN exit_price_new TO exit_price;
ALTER TABLE trades RENAME COLUMN stop_loss TO stop_loss_old;
ALTER TABLE trades RENAME COLUMN stop_loss_new TO stop_loss;
ALTER TABLE trades RENAME COLUMN take_profit TO take_profit_old;
ALTER TABLE trades RENAME COLUMN take_profit_new TO take_profit;
ALTER TABLE trades RENAME COLUMN position_size TO position_size_old;
ALTER TABLE trades RENAME COLUMN position_size_new TO position_size;
ALTER TABLE trades RENAME COLUMN risk_reward TO risk_reward_old;
ALTER TABLE trades RENAME COLUMN risk_reward_new TO risk_reward;
ALTER TABLE trades RENAME COLUMN risk_percent TO risk_percent_old;
ALTER TABLE trades RENAME COLUMN risk_percent_new TO risk_percent;
ALTER TABLE trades RENAME COLUMN pnl_pips TO pnl_pips_old;
ALTER TABLE trades RENAME COLUMN pnl_pips_new TO pnl_pips;
ALTER TABLE trades RENAME COLUMN pnl_amount TO pnl_amount_old;
ALTER TABLE trades RENAME COLUMN pnl_amount_new TO pnl_amount;
