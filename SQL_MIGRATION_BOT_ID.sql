-- ============================================
-- Bot #2 (FOTSI) Account Separation Migration
-- Run this in Supabase SQL Editor BEFORE deploying the updated Edge Functions
-- ============================================

-- Step 1: Add bot_id column to paper_accounts
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS bot_id text DEFAULT 'smc';

-- Step 2: Add bot_id column to paper_positions
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS bot_id text DEFAULT 'smc';

-- Step 3: Add bot_id column to paper_trade_history
ALTER TABLE paper_trade_history ADD COLUMN IF NOT EXISTS bot_id text DEFAULT 'smc';

-- Step 4: Tag existing SMC account
UPDATE paper_accounts SET bot_id = 'smc' WHERE bot_id IS NULL;

-- Step 5: Create Bot #2 (FOTSI) paper account for each user that has an SMC account
-- This duplicates the account structure with a fresh $10,000 balance
INSERT INTO paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base, daily_pnl_date, is_running, is_paused, scan_count, signal_count, rejected_count, execution_mode, kill_switch_active)
SELECT user_id, 'fotsi_mr', '10000', '10000', '10000', '', false, false, 0, 0, 0, 'paper', false
FROM paper_accounts
WHERE bot_id = 'smc'
ON CONFLICT DO NOTHING;

-- Step 6: Create index for faster bot_id lookups
CREATE INDEX IF NOT EXISTS idx_paper_accounts_bot_id ON paper_accounts(user_id, bot_id);
CREATE INDEX IF NOT EXISTS idx_paper_positions_bot_id ON paper_positions(user_id, bot_id);
CREATE INDEX IF NOT EXISTS idx_paper_trade_history_bot_id ON paper_trade_history(user_id, bot_id);

-- Step 7: Insert FOTSI config if not already present
-- (Check if fotsi_mr key exists in config_json; if not, add it)
-- NOTE: This is a template — adjust the user_id filter if needed
UPDATE bot_configs
SET config_json = jsonb_set(
  COALESCE(config_json::jsonb, '{}'::jsonb),
  '{fotsi_mr}',
  '{
    "minDivergenceSpread": 40,
    "hookRequired": true,
    "hookBars": 3,
    "minExtremeLevel": 25,
    "riskPerTrade": 1.0,
    "maxConcurrent": 3,
    "cooldownMinutes": 240,
    "maxDailyLoss": 5.0,
    "maxDailyTrades": 5,
    "slMethod": "atr",
    "slATRMultiplier": 2.0,
    "minRR": 2.0,
    "tp1Method": "ema50",
    "tp2Method": "ema100",
    "partialClosePercent": 50,
    "maxHoldHours": 48,
    "breakEvenAfterTP1": true,
    "sessions": { "london": true, "newYork": true, "asian": false, "sydney": false },
    "killZoneOnly": false,
    "entryTimeframe": "4h"
  }'::jsonb
)
WHERE NOT (config_json::jsonb ? 'fotsi_mr');

-- Done! Verify with:
-- SELECT user_id, bot_id, balance, is_running FROM paper_accounts ORDER BY user_id, bot_id;
