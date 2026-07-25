-- Add progress tracking columns to optimizer_runs for chunked execution.
-- These mirror the backtest_runs pattern for resumable jobs.

ALTER TABLE optimizer_runs
  ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_message TEXT;
