CREATE TABLE IF NOT EXISTS public.trade_review_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'reviewed')),
  notes TEXT,
  lesson TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, position_id)
);

ALTER TABLE public.trade_review_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own trade review notes" ON public.trade_review_notes;
CREATE POLICY "Users manage own trade review notes"
  ON public.trade_review_notes FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_review_notes TO authenticated;

DROP TRIGGER IF EXISTS set_trade_review_notes_updated_at ON public.trade_review_notes;
CREATE TRIGGER set_trade_review_notes_updated_at
  BEFORE UPDATE ON public.trade_review_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
