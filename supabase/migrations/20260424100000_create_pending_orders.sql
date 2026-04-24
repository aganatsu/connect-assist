-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Pending Orders (Limit Order System)                             ║
-- ║  Stores limit/stop orders placed by the bot-scanner that        ║
-- ║  haven't been filled yet. Monitored on each scan cycle.         ║
-- ╚═══════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.pending_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id          TEXT NOT NULL DEFAULT 'smc',

  -- Order identification
  order_id        TEXT NOT NULL,                -- Unique order reference (e.g. "LMT-EUR/USD-1719312000")
  symbol          TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  order_type      TEXT NOT NULL DEFAULT 'limit' CHECK (order_type IN ('limit', 'stop')),

  -- Price levels
  entry_price     NUMERIC(20,10) NOT NULL,      -- The limit price (OB edge / FVG CE)
  current_price   NUMERIC(20,10) NOT NULL,      -- Last known market price
  stop_loss       NUMERIC(20,10) NOT NULL,
  take_profit     NUMERIC(20,10) NOT NULL,
  size            NUMERIC(20,8) NOT NULL,        -- Lot size

  -- Zone context (where the limit price came from)
  entry_zone_type TEXT,                          -- 'order_block', 'fvg_ce', 'breaker', 'liquidity'
  entry_zone_low  NUMERIC(20,10),
  entry_zone_high NUMERIC(20,10),

  -- Order lifecycle
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'filled', 'expired', 'cancelled', 'invalidated')),
  expiry_minutes  INT NOT NULL DEFAULT 60,
  fill_reason     TEXT,                          -- Why it was filled (e.g. "price reached 1.38500")
  cancel_reason   TEXT,                          -- Why it was cancelled/invalidated

  -- Signal context (same as paper_positions)
  signal_reason   JSONB,
  signal_score    NUMERIC(6,2),
  setup_type      TEXT,
  setup_confidence NUMERIC(4,2),

  -- Staging origin (if promoted from watchlist)
  from_watchlist  BOOLEAN NOT NULL DEFAULT false,
  staged_cycles   INT,
  staged_initial_score NUMERIC(6,2),

  -- Exit flags (pre-computed, applied when order fills)
  exit_flags      JSONB,

  -- Timestamps
  placed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  filled_at       TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active pending orders (most common query)
CREATE INDEX idx_pending_orders_active
  ON public.pending_orders (user_id, bot_id, status)
  WHERE status = 'pending';

-- Symbol lookup for duplicate prevention
CREATE INDEX idx_pending_orders_symbol
  ON public.pending_orders (user_id, symbol, direction, status)
  WHERE status = 'pending';

-- Expiry check (find orders past their expiry time)
CREATE INDEX idx_pending_orders_expiry
  ON public.pending_orders (expires_at, status)
  WHERE status = 'pending';

-- Unique active order per symbol+direction (prevent duplicate limit orders)
CREATE UNIQUE INDEX idx_pending_orders_unique_active
  ON public.pending_orders (user_id, bot_id, symbol, direction)
  WHERE status = 'pending';

-- Auto-update updated_at
CREATE TRIGGER set_pending_orders_updated_at
  BEFORE UPDATE ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE public.pending_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own pending orders"
  ON public.pending_orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own pending orders"
  ON public.pending_orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own pending orders"
  ON public.pending_orders FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own pending orders"
  ON public.pending_orders FOR DELETE
  USING (auth.uid() = user_id);
