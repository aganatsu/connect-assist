-- ══════════════════════════════════════════════════════════════
-- Optimizer Tables: config_backups + optimizer_runs
-- ══════════════════════════════════════════════════════════════
-- config_backups: stores snapshots of bot_configs.config_json before
-- the optimizer auto-applies a new configuration. Enables rollback.
--
-- optimizer_runs: tracks weekly optimizer execution history for
-- deduplication (prevent double-runs) and audit trail.
-- ══════════════════════════════════════════════════════════════

-- 1. CONFIG BACKUPS
CREATE TABLE IF NOT EXISTS config_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id TEXT NOT NULL UNIQUE,                     -- e.g. "backup_1721836800000"
  user_id UUID NOT NULL,
  config_id UUID NOT NULL,                            -- references bot_configs.id
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,  -- full config_json at time of backup
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for looking up backups by user (most recent first)
CREATE INDEX IF NOT EXISTS idx_config_backups_user
  ON config_backups (user_id, created_at DESC);

-- RLS: users can view their own backups
ALTER TABLE config_backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own config backups"
  ON config_backups FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert/read (optimizer uses service role key)
CREATE POLICY "Service role full access on config_backups"
  ON config_backups FOR ALL
  USING (true)
  WITH CHECK (true);


-- 2. OPTIMIZER RUNS
CREATE TABLE IF NOT EXISTS optimizer_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',              -- running | completed | failed
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  trials_count INTEGER DEFAULT 0,
  baseline_score DOUBLE PRECISION,
  best_score DOUBLE PRECISION,
  improvement_percent DOUBLE PRECISION,
  auto_applied BOOLEAN DEFAULT false,
  reject_reason TEXT,
  config_snapshot JSONB,                              -- optimizer config used for this run
  result_summary JSONB,                               -- condensed results (not full trial data)
  error_message TEXT
);

-- Index for deduplication: check if a run happened this week
CREATE INDEX IF NOT EXISTS idx_optimizer_runs_user_started
  ON optimizer_runs (user_id, started_at DESC);

-- RLS: users can view their own runs
ALTER TABLE optimizer_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own optimizer runs"
  ON optimizer_runs FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert/update (optimizer uses service role key)
CREATE POLICY "Service role full access on optimizer_runs"
  ON optimizer_runs FOR ALL
  USING (true)
  WITH CHECK (true);
