-- Add heartbeat_at for stale-run detection and support cancel status
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

-- Allow users to cancel their own runs (update status to 'cancelled')
CREATE POLICY "Users can cancel own backtest runs"
  ON backtest_runs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND status = 'cancelled');
