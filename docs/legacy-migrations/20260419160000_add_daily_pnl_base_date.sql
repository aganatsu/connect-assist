-- H17: Add daily_pnl_base_date column to paper_accounts
-- This column tracks when the daily PnL base was last reset.
-- The paper-trading status handler uses it to reset daily_pnl_base at the start of each new day.

ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS daily_pnl_base_date TEXT;

-- Initialize existing rows with today's date
UPDATE paper_accounts SET daily_pnl_base_date = CURRENT_DATE::TEXT WHERE daily_pnl_base_date IS NULL;
