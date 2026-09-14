-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Rejected Setups — Outcome Tracking for Gate-Blocked Trades      ║
-- ║  Logs setups that passed confluence but were blocked by gates,   ║
-- ║  plus below-threshold setups with strong T1 factors.             ║
-- ║  Tracks counterfactual outcomes to measure gate effectiveness.   ║
-- ╚═══════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.rejected_setups (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id                TEXT NOT NULL DEFAULT 'smc',

  -- Setup identification
  symbol                TEXT NOT NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  rejected_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Rejection context
  rejection_type        TEXT NOT NULL CHECK (rejection_type IN ('gate_blocked', 'below_threshold_strong_t1')),
  failed_gates          TEXT[],                   -- gate names/reasons that blocked
  confluence_score      NUMERIC(6,2) NOT NULL,
  tier1_count           INT NOT NULL DEFAULT 0,
  tier1_factors         TEXT[],                   -- names of present T1 factors

  -- Trade parameters (what would have been taken)
  entry_price           NUMERIC(20,10) NOT NULL,
  stop_loss             NUMERIC(20,10),
  take_profit           NUMERIC(20,10),
  rr_ratio              NUMERIC(6,2),

  -- Market context at rejection
  session_name          TEXT,
  regime                TEXT,
  gp_bias               TEXT,
  gp_bias_confidence    INT,
  fotsi_base_tsi        NUMERIC(8,2),
  fotsi_quote_tsi       NUMERIC(8,2),
  price_at_rejection    NUMERIC(20,10),

  -- Outcome tracking (populated by outcome-tracker cron)
  outcome_status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (outcome_status IN ('pending', 'inconclusive', 'would_have_won', 'would_have_lost')),
  outcome_checked_at    TIMESTAMPTZ,
  price_reached_entry   BOOLEAN,
  tp_hit                BOOLEAN,
  sl_hit                BOOLEAN,
  tp_hit_time_minutes   INT,
  mfe_pips              NUMERIC(10,2),            -- Maximum Favorable Excursion
  mae_pips              NUMERIC(10,2),            -- Maximum Adverse Excursion

  -- Raw detail blob for debugging
  raw_detail            JSONB,

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query: recent rejections for a user/bot
CREATE INDEX idx_rejected_setups_user_recent
  ON public.rejected_setups (user_id, bot_id, rejected_at DESC);

-- Outcome tracker: find pending outcomes older than 1 hour
CREATE INDEX idx_rejected_setups_pending_outcome
  ON public.rejected_setups (outcome_status, rejected_at)
  WHERE outcome_status = 'pending';

-- Symbol lookup for outcome tracking candle fetches
CREATE INDEX idx_rejected_setups_symbol
  ON public.rejected_setups (symbol, rejected_at DESC);

-- RLS
ALTER TABLE public.rejected_setups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own rejected setups"
  ON public.rejected_setups FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage rejected setups"
  ON public.rejected_setups FOR ALL
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════
-- Add thesis_cancel_reason column to pending_orders
-- Stores the specific thesis validation check that triggered cancellation
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS thesis_cancel_reason TEXT;
