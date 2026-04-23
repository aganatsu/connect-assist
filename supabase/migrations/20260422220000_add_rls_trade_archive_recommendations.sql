-- Audit Fix #1: Add Row Level Security to trade_archive and bot_recommendations
-- These tables were missing RLS, allowing any authenticated user to access all rows.

-- trade_archive: stores archived paper_trade_history rows (>90 days old)
ALTER TABLE trade_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own archived trades"
  ON trade_archive FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert own archived trades"
  ON trade_archive FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can delete own archived trades"
  ON trade_archive FOR DELETE
  USING (auth.uid()::text = user_id);

-- bot_recommendations: stores AI-generated trade recommendations
-- Note: IF NOT EXISTS guards in case RLS was already enabled via Dashboard
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE tablename = 'bot_recommendations' AND rowsecurity = true
  ) THEN
    EXECUTE 'ALTER TABLE bot_recommendations ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- Drop policies if they already exist (idempotent)
DROP POLICY IF EXISTS "Users can select own recommendations" ON bot_recommendations;
DROP POLICY IF EXISTS "Users can insert own recommendations" ON bot_recommendations;
DROP POLICY IF EXISTS "Users can update own recommendations" ON bot_recommendations;
DROP POLICY IF EXISTS "Users can delete own recommendations" ON bot_recommendations;

CREATE POLICY "Users can select own recommendations"
  ON bot_recommendations FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert own recommendations"
  ON bot_recommendations FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can update own recommendations"
  ON bot_recommendations FOR UPDATE
  USING (auth.uid()::text = user_id)
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can delete own recommendations"
  ON bot_recommendations FOR DELETE
  USING (auth.uid()::text = user_id);
