ALTER TABLE public.trades
  ALTER COLUMN entry_price_old DROP NOT NULL,
  ALTER COLUMN exit_price_old DROP NOT NULL,
  ALTER COLUMN stop_loss_old DROP NOT NULL,
  ALTER COLUMN take_profit_old DROP NOT NULL,
  ALTER COLUMN position_size_old DROP NOT NULL,
  ALTER COLUMN risk_reward_old DROP NOT NULL,
  ALTER COLUMN risk_percent_old DROP NOT NULL,
  ALTER COLUMN pnl_pips_old DROP NOT NULL,
  ALTER COLUMN pnl_amount_old DROP NOT NULL;