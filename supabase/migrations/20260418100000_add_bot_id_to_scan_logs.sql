-- Add bot_id column to scan_logs for multi-bot filtering
-- Bot #1 (SMC Scanner) = 'smc_scanner' or NULL (backward compatible)
-- Bot #2 (FOTSI Mean Reversion) = 'fotsi_mr'

ALTER TABLE public.scan_logs
ADD COLUMN IF NOT EXISTS bot_id text;

-- Create index for efficient bot-specific log queries
CREATE INDEX IF NOT EXISTS idx_scan_logs_bot_id ON public.scan_logs (bot_id);

-- Backfill existing logs as Bot #1
UPDATE public.scan_logs SET bot_id = 'smc_scanner' WHERE bot_id IS NULL;
