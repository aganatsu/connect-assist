-- ============================================================
-- Migration: Unified Advisor
-- Adds new columns to bot_recommendations for the unified advisor
-- All changes are ADDITIVE (nullable columns, new indexes)
-- Safe to apply to production with existing data
-- ============================================================

-- 1. Add review_type column (replaces implicit type from function name)
ALTER TABLE bot_recommendations
ADD COLUMN IF NOT EXISTS review_type TEXT DEFAULT 'daily';

-- 2. Add diagnosis column (separate from overall_assessment for longer analysis)
ALTER TABLE bot_recommendations
ADD COLUMN IF NOT EXISTS diagnosis TEXT;

-- 3. Add feature_gaps column (array of missing capabilities)
ALTER TABLE bot_recommendations
ADD COLUMN IF NOT EXISTS feature_gaps JSONB DEFAULT '[]'::jsonb;

-- 4. Add llm_model column (track which model generated the recommendation)
ALTER TABLE bot_recommendations
ADD COLUMN IF NOT EXISTS llm_model TEXT;

-- 5. Add resolved_at column (when the recommendation was approved/dismissed)
ALTER TABLE bot_recommendations
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- 6. Dedup index: prevent multiple pending recommendations of same type per bot per day
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_recs_dedup
ON bot_recommendations (user_id, bot_id, review_type, (created_at::date))
WHERE status = 'pending';

-- 7. Performance index for fetching recent recommendations
CREATE INDEX IF NOT EXISTS idx_bot_recs_recent
ON bot_recommendations (user_id, bot_id, created_at DESC);

-- 8. Backfill review_type for existing rows based on source
-- (Run this manually after applying the migration)
-- UPDATE bot_recommendations SET review_type = 'daily' WHERE review_type IS NULL AND source = 'bot-daily-review';
-- UPDATE bot_recommendations SET review_type = 'weekly' WHERE review_type IS NULL AND source = 'bot-weekly-advisor';
-- UPDATE bot_recommendations SET review_type = 'on_demand' WHERE review_type IS NULL AND source = 'strategy-advisor';

-- 9. RLS policies (only if not already set up)
-- These ensure users can only see their own recommendations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bot_recommendations' AND policyname = 'users_own_recommendations'
  ) THEN
    ALTER TABLE bot_recommendations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY users_own_recommendations ON bot_recommendations
      FOR ALL USING (auth.uid()::text = user_id);
  END IF;
END $$;

-- 10. Grant service role full access (for edge functions)
GRANT ALL ON bot_recommendations TO service_role;
