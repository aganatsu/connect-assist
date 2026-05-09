-- Prop Firm Risk Management Tables
-- Implements FTMO 2-Step Swing compliance tracking with 3-layer firewall.
-- Tables: prop_firm_config, prop_firm_daily_state, prop_firm_events

-- ─── Table 1: prop_firm_config ────────────────────────────────────────────────
-- Stores the prop firm rules for each user/bot combination.
-- One active config per user/bot pair.

CREATE TABLE public.prop_firm_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc-bot-v1',

  -- Firm identification
  firm_type TEXT NOT NULL DEFAULT 'ftmo_2step'
    CHECK (firm_type IN ('ftmo_2step', 'ftmo_1step', 'generic')),
  account_stage TEXT NOT NULL DEFAULT 'challenge'
    CHECK (account_stage IN ('challenge', 'verification', 'funded')),

  -- Account parameters
  initial_balance NUMERIC NOT NULL DEFAULT 100000,
  account_currency TEXT NOT NULL DEFAULT 'USD',

  -- Limits (as fractions of 1, e.g., 0.05 = 5%)
  max_daily_loss_pct NUMERIC NOT NULL DEFAULT 0.05,
  max_overall_loss_pct NUMERIC NOT NULL DEFAULT 0.10,
  profit_target_pct NUMERIC DEFAULT 0.10,  -- NULL for funded accounts
  best_day_rule_pct NUMERIC,               -- NULL unless 1-step (0.50)

  -- Drawdown type
  trailing_drawdown BOOLEAN NOT NULL DEFAULT FALSE,

  -- Safety margins
  safety_buffer_pct NUMERIC NOT NULL DEFAULT 0.008,      -- stop 0.8% before actual limit
  emergency_close_pct NUMERIC NOT NULL DEFAULT 0.002,    -- close-all 0.2% before breach

  -- Behavior
  close_on_breach BOOLEAN NOT NULL DEFAULT TRUE,
  reduce_size_near_limit BOOLEAN NOT NULL DEFAULT TRUE,
  size_reduction_threshold_pct NUMERIC NOT NULL DEFAULT 0.60,  -- reduce at 60% of limit used

  -- Timezone (FTMO uses CEST: UTC+2 summer, UTC+1 winter)
  day_reset_hour_utc INTEGER NOT NULL DEFAULT 22,  -- 00:00 CEST = 22:00 UTC (summer)

  -- State
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, bot_id)
);

ALTER TABLE public.prop_firm_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own prop firm config"
  ON public.prop_firm_config FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role bypass for edge functions
CREATE POLICY "Service role full access on prop_firm_config"
  ON public.prop_firm_config FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER update_prop_firm_config_updated_at
  BEFORE UPDATE ON public.prop_firm_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Table 2: prop_firm_daily_state ───────────────────────────────────────────
-- Tracks daily metrics for compliance monitoring.
-- One row per config per trading day.

CREATE TABLE public.prop_firm_daily_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES public.prop_firm_config(id) ON DELETE CASCADE,

  -- Day identification (in CEST timezone)
  trading_day DATE NOT NULL,

  -- Reference values (set at day start)
  day_start_balance NUMERIC NOT NULL,
  day_start_equity NUMERIC NOT NULL,

  -- Intraday tracking (updated every scan cycle)
  highest_equity_today NUMERIC NOT NULL,
  lowest_equity_today NUMERIC NOT NULL,
  current_equity NUMERIC,

  -- End-of-day values (filled at CEST midnight)
  end_of_day_balance NUMERIC,

  -- Running peak for trailing drawdown (highest EOD balance ever seen)
  highest_eod_balance_ever NUMERIC NOT NULL,

  -- Daily P&L
  realized_pnl_today NUMERIC NOT NULL DEFAULT 0,
  trade_count_today INTEGER NOT NULL DEFAULT 0,

  -- Lock state
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMPTZ,
  lock_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(config_id, trading_day)
);

ALTER TABLE public.prop_firm_daily_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own prop firm daily state"
  ON public.prop_firm_daily_state FOR SELECT
  USING (config_id IN (SELECT id FROM public.prop_firm_config WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access on prop_firm_daily_state"
  ON public.prop_firm_daily_state FOR ALL
  USING (auth.role() = 'service_role');

-- Index for fast lookup of current day's state
CREATE INDEX idx_prop_firm_daily_state_config_day
  ON public.prop_firm_daily_state(config_id, trading_day DESC);

-- ─── Table 3: prop_firm_events ────────────────────────────────────────────────
-- Audit trail of all compliance events (warnings, locks, breaches).

CREATE TABLE public.prop_firm_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES public.prop_firm_config(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL CHECK (event_type IN (
    'daily_warning', 'daily_soft_lock', 'daily_hard_lock',
    'drawdown_warning', 'drawdown_breach',
    'target_reached', 'target_warning',
    'emergency_close', 'size_reduction',
    'day_reset', 'best_day_warning'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),

  -- Snapshot at event time
  balance_at_event NUMERIC,
  equity_at_event NUMERIC,
  daily_loss_at_event NUMERIC,
  drawdown_at_event NUMERIC,

  -- Details
  message TEXT NOT NULL,
  details JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.prop_firm_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own prop firm events"
  ON public.prop_firm_events FOR SELECT
  USING (config_id IN (SELECT id FROM public.prop_firm_config WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access on prop_firm_events"
  ON public.prop_firm_events FOR ALL
  USING (auth.role() = 'service_role');

-- Index for fast event queries by config and time
CREATE INDEX idx_prop_firm_events_config_time
  ON public.prop_firm_events(config_id, created_at DESC);

-- Index for filtering by severity (for dashboard alerts)
CREATE INDEX idx_prop_firm_events_severity
  ON public.prop_firm_events(severity, created_at DESC);
