ALTER TABLE public.paper_positions
  ALTER COLUMN size_old DROP NOT NULL,
  ALTER COLUMN entry_price_old DROP NOT NULL,
  ALTER COLUMN current_price_old DROP NOT NULL;

ALTER TABLE public.paper_trade_history
  ALTER COLUMN size_old DROP NOT NULL,
  ALTER COLUMN entry_price_old DROP NOT NULL,
  ALTER COLUMN exit_price_old DROP NOT NULL,
  ALTER COLUMN pnl_old DROP NOT NULL,
  ALTER COLUMN pnl_pips_old DROP NOT NULL;