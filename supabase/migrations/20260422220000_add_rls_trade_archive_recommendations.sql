-- Audit Fix #1: Add Row Level Security to trade_archive and bot_recommendations
-- Handles type mismatch: trade_archive.user_id is UUID, bot_recommendations.user_id may be text

-- ═══ trade_archive (user_id is UUID — direct comparison with auth.uid()) ═══
ALTER TABLE trade_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can select own archived trades" ON trade_archive;
DROP POLICY IF EXISTS "Users can insert own archived trades" ON trade_archive;
DROP POLICY IF EXISTS "Users can delete own archived trades" ON trade_archive;

CREATE POLICY "Users can select own archived trades"
  ON trade_archive FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own archived trades"
  ON trade_archive FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own archived trades"
  ON trade_archive FOR DELETE
  USING (auth.uid() = user_id);

-- ═══ bot_recommendations (user_id may be text — cast both sides to text) ═══
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE tablename = 'bot_recommendations' AND rowsecurity = true
  ) THEN
    EXECUTE 'ALTER TABLE bot_recommendations ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DROP POLICY IF EXISTS "Users can select own recommendations" ON bot_recommendations;
DROP POLICY IF EXISTS "Users can insert own recommendations" ON bot_recommendations;
DROP POLICY IF EXISTS "Users can update own recommendations" ON bot_recommendations;
DROP POLICY IF EXISTS "Users can delete own recommendations" ON bot_recommendations;

CREATE POLICY "Users can select own recommendations"
  ON bot_recommendations FOR SELECT
  USING (auth.uid()::text = user_id::text);

CREATE POLICY "Users can insert own recommendations"
  ON bot_recommendations FOR INSERT
  WITH CHECK (auth.uid()::text = user_id::text);

CREATE POLICY "Users can update own recommendations"
  ON bot_recommendations FOR UPDATE
  USING (auth.uid()::text = user_id::text)
  WITH CHECK (auth.uid()::text = user_id::text);

CREATE POLICY "Users can delete own recommendations"
  ON bot_recommendations FOR DELETE
  USING (auth.uid()::text = user_id::text);
