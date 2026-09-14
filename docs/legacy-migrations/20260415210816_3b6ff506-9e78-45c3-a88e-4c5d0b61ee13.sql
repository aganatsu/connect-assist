
-- Timestamp update function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- ══════════════════════════════════════════════════════════════
-- 1. TRADES (Trade Journal)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  entry_price TEXT NOT NULL,
  exit_price TEXT,
  stop_loss TEXT,
  take_profit TEXT,
  position_size TEXT,
  risk_reward TEXT,
  risk_percent TEXT,
  pnl_pips TEXT,
  pnl_amount TEXT,
  timeframe TEXT,
  followed_strategy BOOLEAN,
  setup_type TEXT,
  notes TEXT,
  deviations TEXT,
  improvements TEXT,
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ,
  screenshot_url TEXT,
  confluence_score INTEGER,
  reasoning_json JSONB,
  post_mortem_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own trades" ON public.trades FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON public.trades FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX idx_trades_user_entry ON public.trades (user_id, entry_time DESC);

-- ══════════════════════════════════════════════════════════════
-- 2. BROKER CONNECTIONS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.broker_connections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  broker_type TEXT NOT NULL CHECK (broker_type IN ('oanda', 'metaapi')),
  display_name TEXT NOT NULL,
  api_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  is_live BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.broker_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own broker connections" ON public.broker_connections FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_broker_connections_updated_at BEFORE UPDATE ON public.broker_connections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ══════════════════════════════════════════════════════════════
-- 3. BOT CONFIGS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.bot_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own bot config" ON public.bot_configs FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_bot_configs_updated_at BEFORE UPDATE ON public.bot_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ══════════════════════════════════════════════════════════════
-- 4. TRADE REASONINGS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.trade_reasonings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  position_id TEXT NOT NULL,
  trade_id UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  confluence_score INTEGER NOT NULL,
  session TEXT,
  timeframe TEXT,
  bias TEXT,
  factors_json JSONB,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trade_reasonings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own trade reasonings" ON public.trade_reasonings FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_trade_reasonings_position ON public.trade_reasonings (position_id);

-- ══════════════════════════════════════════════════════════════
-- 5. TRADE POST-MORTEMS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.trade_post_mortems (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  position_id TEXT NOT NULL,
  trade_id UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  exit_reason TEXT NOT NULL,
  what_worked TEXT,
  what_failed TEXT,
  lesson_learned TEXT,
  exit_price TEXT,
  pnl TEXT,
  detail_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trade_post_mortems ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own post mortems" ON public.trade_post_mortems FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_trade_post_mortems_position ON public.trade_post_mortems (position_id);

-- ══════════════════════════════════════════════════════════════
-- 6. USER SETTINGS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.user_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  risk_settings_json JSONB,
  preferences_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own settings" ON public.user_settings FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ══════════════════════════════════════════════════════════════
-- 7. PAPER ACCOUNTS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.paper_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  balance TEXT NOT NULL DEFAULT '10000',
  peak_balance TEXT NOT NULL DEFAULT '10000',
  is_running BOOLEAN NOT NULL DEFAULT false,
  is_paused BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  scan_count INTEGER NOT NULL DEFAULT 0,
  signal_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  daily_pnl_base TEXT NOT NULL DEFAULT '10000',
  daily_pnl_date TEXT NOT NULL DEFAULT '',
  execution_mode TEXT NOT NULL DEFAULT 'paper' CHECK (execution_mode IN ('paper', 'live')),
  kill_switch_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own paper account" ON public.paper_accounts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_paper_accounts_updated_at BEFORE UPDATE ON public.paper_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ══════════════════════════════════════════════════════════════
-- 8. PAPER POSITIONS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.paper_positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  position_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  size TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  current_price TEXT NOT NULL,
  stop_loss TEXT,
  take_profit TEXT,
  open_time TEXT NOT NULL,
  signal_reason TEXT,
  signal_score TEXT NOT NULL DEFAULT '0',
  order_id TEXT NOT NULL,
  position_status TEXT NOT NULL DEFAULT 'open' CHECK (position_status IN ('open', 'pending')),
  trigger_price TEXT,
  order_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own paper positions" ON public.paper_positions FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_paper_positions_user ON public.paper_positions (user_id, position_status);

-- ══════════════════════════════════════════════════════════════
-- 9. PAPER TRADE HISTORY
-- ══════════════════════════════════════════════════════════════
CREATE TABLE public.paper_trade_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  position_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  size TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  exit_price TEXT NOT NULL,
  pnl TEXT NOT NULL,
  pnl_pips TEXT NOT NULL,
  open_time TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  close_reason TEXT NOT NULL,
  signal_reason TEXT,
  signal_score TEXT NOT NULL DEFAULT '0',
  order_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.paper_trade_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own paper trade history" ON public.paper_trade_history FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_paper_trade_history_user ON public.paper_trade_history (user_id, created_at DESC);
