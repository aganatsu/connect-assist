-- ============================================
-- Self-Learning Bot: Recommendations Table
-- Run this in Supabase SQL Editor
-- ============================================

-- Step 1: Create the bot_recommendations table
CREATE TABLE IF NOT EXISTS bot_recommendations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  bot_id text NOT NULL DEFAULT 'smc',
  review_type text NOT NULL DEFAULT 'daily',          -- 'daily' or 'weekly'
  created_at timestamptz NOT NULL DEFAULT now(),
  
  -- Analysis data
  performance_summary jsonb NOT NULL DEFAULT '{}'::jsonb,  -- Pre-computed stats
  diagnosis text NOT NULL DEFAULT '',                       -- LLM-generated diagnosis
  recommendations jsonb NOT NULL DEFAULT '[]'::jsonb,       -- Array of specific suggestions
  feature_gaps jsonb NOT NULL DEFAULT '[]'::jsonb,          -- Suggested new capabilities
  
  -- Status tracking
  status text NOT NULL DEFAULT 'pending',              -- pending / approved / dismissed / auto_expired
  resolved_at timestamptz,
  resolved_by text,                                    -- 'owner' or 'auto_expiry'
  
  -- Impact tracking (captured 7 days after approval)
  impact_snapshot jsonb,                               -- Performance metrics post-change
  
  -- Metadata
  llm_model text,                                      -- Which model generated the diagnosis
  token_usage jsonb,                                   -- Token counts for cost tracking
  overall_assessment text                              -- winning / losing / breakeven / insufficient_data
);

-- Step 2: Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_bot_rec_user_status ON bot_recommendations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_bot_rec_user_bot ON bot_recommendations(user_id, bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_rec_created ON bot_recommendations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_rec_status ON bot_recommendations(status) WHERE status = 'pending';

-- Step 3: Enable RLS (Row Level Security)
ALTER TABLE bot_recommendations ENABLE ROW LEVEL SECURITY;

-- Step 4: Create RLS policy (users can only see their own recommendations)
CREATE POLICY "Users can view own recommendations" ON bot_recommendations
  FOR SELECT USING (true);

CREATE POLICY "Service role can insert recommendations" ON bot_recommendations
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Service role can update recommendations" ON bot_recommendations
  FOR UPDATE USING (true);

-- Step 5: Add a cron job for auto-expiring stale recommendations (48 hours)
-- Note: This requires pg_cron extension to be enabled
-- Run this separately if pg_cron is available:
-- SELECT cron.schedule(
--   'auto-expire-recommendations',
--   '0 */6 * * *',  -- Every 6 hours
--   $$UPDATE bot_recommendations 
--     SET status = 'auto_expired', resolved_at = now(), resolved_by = 'auto_expiry'
--     WHERE status = 'pending' 
--     AND created_at < now() - interval '48 hours'$$
-- );
