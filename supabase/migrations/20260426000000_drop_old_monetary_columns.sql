-- C3 CLEANUP: Drop _old TEXT columns after verifying NUMERIC migration works
-- ⚠️ DO NOT RUN THIS until at least 1 week after 20260419170000_monetary_text_to_numeric.sql
-- ⚠️ Verify all Edge Functions work correctly with NUMERIC columns first

-- paper_positions
ALTER TABLE paper_positions DROP COLUMN IF EXISTS entry_price_old;
ALTER TABLE paper_positions DROP COLUMN IF EXISTS size_old;
ALTER TABLE paper_positions DROP COLUMN IF EXISTS stop_loss_old;
ALTER TABLE paper_positions DROP COLUMN IF EXISTS take_profit_old;
ALTER TABLE paper_positions DROP COLUMN IF EXISTS current_price_old;

-- paper_trade_history
ALTER TABLE paper_trade_history DROP COLUMN IF EXISTS entry_price_old;
ALTER TABLE paper_trade_history DROP COLUMN IF EXISTS exit_price_old;
ALTER TABLE paper_trade_history DROP COLUMN IF EXISTS size_old;
ALTER TABLE paper_trade_history DROP COLUMN IF EXISTS pnl_old;
ALTER TABLE paper_trade_history DROP COLUMN IF EXISTS pnl_pips_old;

-- paper_accounts
ALTER TABLE paper_accounts DROP COLUMN IF EXISTS balance_old;
ALTER TABLE paper_accounts DROP COLUMN IF EXISTS peak_balance_old;
ALTER TABLE paper_accounts DROP COLUMN IF EXISTS daily_pnl_base_old;

-- trades
ALTER TABLE trades DROP COLUMN IF EXISTS entry_price_old;
ALTER TABLE trades DROP COLUMN IF EXISTS exit_price_old;
ALTER TABLE trades DROP COLUMN IF EXISTS stop_loss_old;
ALTER TABLE trades DROP COLUMN IF EXISTS take_profit_old;
ALTER TABLE trades DROP COLUMN IF EXISTS position_size_old;
ALTER TABLE trades DROP COLUMN IF EXISTS risk_reward_old;
ALTER TABLE trades DROP COLUMN IF EXISTS risk_percent_old;
ALTER TABLE trades DROP COLUMN IF EXISTS pnl_pips_old;
ALTER TABLE trades DROP COLUMN IF EXISTS pnl_amount_old;
