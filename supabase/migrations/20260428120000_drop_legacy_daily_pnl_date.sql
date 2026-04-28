-- Migration: Drop legacy daily_pnl_date column from paper_accounts
-- Branch: manus/fix-reset-daily-baseline-v2
--
-- Context: The column daily_pnl_date was the original column for tracking
-- the date of the last daily PnL base reset. It was superseded by
-- daily_pnl_base_date (added in an earlier migration) but never dropped.
-- All code paths now use daily_pnl_base_date exclusively.
-- This migration removes the orphaned column to prevent future confusion.

ALTER TABLE paper_accounts DROP COLUMN IF EXISTS daily_pnl_date;
