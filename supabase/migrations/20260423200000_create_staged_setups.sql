-- ============================================================================
-- Setup Staging / Watchlist Table
-- ============================================================================
-- Stores "almost ready" setups that the bot-scanner identifies but doesn't
-- trade immediately.  On subsequent scan cycles the bot re-evaluates staged
-- setups and promotes them to trades when they reach the confluence gate,
-- or discards them when they expire or become invalidated.
--
-- Lifecycle:  watching → promoted | expired | invalidated
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.staged_setups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id        TEXT NOT NULL DEFAULT 'smc',

  -- Setup identity
  symbol        TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('long', 'short')),

  -- Scoring snapshot at staging time
  initial_score NUMERIC(6,2) NOT NULL,         -- score when first staged
  current_score NUMERIC(6,2) NOT NULL,         -- latest re-evaluation score
  watch_threshold NUMERIC(6,2) NOT NULL,       -- threshold that triggered staging

  -- Factor snapshots (JSONB arrays of factor objects)
  initial_factors JSONB NOT NULL DEFAULT '[]',  -- factors present at staging
  current_factors JSONB NOT NULL DEFAULT '[]',  -- factors on last re-eval
  missing_factors JSONB NOT NULL DEFAULT '[]',  -- factors still needed

  -- Key price levels at staging time
  entry_price   NUMERIC(20,10),                -- price when staged
  sl_level      NUMERIC(20,10),                -- SL level for invalidation check
  tp_level      NUMERIC(20,10),                -- projected TP

  -- Staging metadata
  status        TEXT NOT NULL DEFAULT 'watching'
                CHECK (status IN ('watching', 'promoted', 'expired', 'invalidated')),
  scan_cycles   INT NOT NULL DEFAULT 1,        -- how many cycles this has been staged
  min_cycles    INT NOT NULL DEFAULT 1,         -- min cycles before promotion allowed
  ttl_minutes   INT NOT NULL DEFAULT 240,       -- time-to-live in minutes
  promotion_reason TEXT,                        -- why it was promoted (e.g., "score reached 45%")
  invalidation_reason TEXT,                     -- why it was invalidated (e.g., "SL breached")

  -- Setup classification snapshot
  setup_type    TEXT,                           -- e.g., "OB_retest", "FVG_fill"
  tier1_count   INT NOT NULL DEFAULT 0,
  tier2_count   INT NOT NULL DEFAULT 0,
  tier3_count   INT NOT NULL DEFAULT 0,

  -- Analysis snapshot for UI display
  analysis_snapshot JSONB,                      -- condensed analysis for the watching panel

  -- Timestamps
  staged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_eval_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,                   -- when promoted/expired/invalidated
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for the scan loop's hot path
CREATE INDEX idx_staged_setups_active
  ON public.staged_setups (user_id, bot_id, status)
  WHERE status = 'watching';

CREATE INDEX idx_staged_setups_symbol
  ON public.staged_setups (user_id, symbol, direction, status)
  WHERE status = 'watching';

-- Prevent duplicate active watches for the same symbol+direction per user+bot
CREATE UNIQUE INDEX idx_staged_setups_unique_active
  ON public.staged_setups (user_id, bot_id, symbol, direction)
  WHERE status = 'watching';

-- Auto-update updated_at
CREATE TRIGGER set_staged_setups_updated_at
  BEFORE UPDATE ON public.staged_setups
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE public.staged_setups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own staged setups"
  ON public.staged_setups FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own staged setups"
  ON public.staged_setups FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own staged setups"
  ON public.staged_setups FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own staged setups"
  ON public.staged_setups FOR DELETE
  USING (auth.uid() = user_id);

-- Add staging config fields to bot_configs (stored in config_json JSONB)
-- No schema change needed — config_json is a flexible JSONB blob.
-- New fields: stagingEnabled, watchThreshold, stagingTTLMinutes, minStagingCycles
-- These are read by loadConfig() in bot-scanner with sensible defaults.
