-- backtest_runs: stores background backtest jobs and their results
CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | running | completed | failed
  progress INTEGER NOT NULL DEFAULT 0,             -- 0-100 percent
  progress_message TEXT,                           -- e.g. "Fetching EUR/USD candles..."
  config JSONB NOT NULL DEFAULT '{}'::jsonb,       -- full request body snapshot
  results JSONB,                                   -- full response payload on completion
  error_message TEXT,                              -- error details on failure
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Index for polling: user looks up their latest runs
CREATE INDEX IF NOT EXISTS idx_backtest_runs_user_status
  ON backtest_runs (user_id, status, created_at DESC);

-- RLS: users can only see their own runs
ALTER TABLE backtest_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own backtest runs"
  ON backtest_runs FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert/update (edge function uses service role key)
CREATE POLICY "Service role full access"
  ON backtest_runs FOR ALL
  USING (true)
  WITH CHECK (true);
