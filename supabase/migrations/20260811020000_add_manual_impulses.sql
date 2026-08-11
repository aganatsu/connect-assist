-- Hand-marked impulses.
--
-- You mark an impulse on TradingView and the bot does the rest. Everything
-- downstream of impulse selection takes an ImpulseLeg and does not care where it
-- came from, so an active row here substitutes for findStructuralLeg().
--
-- Policy (chosen 2026-08-11):
--   OVERRIDE — while a row is active for a symbol, auto-detection is not
--   consulted for that symbol. Gates still apply in full, and the Direction
--   Verdict may still veto.
--
-- One active marking per user/bot/symbol at a time: two competing hand-marked
-- impulses on the same pair has no sensible meaning, and the partial unique
-- index below makes it impossible rather than a race.

CREATE TABLE IF NOT EXISTS public.manual_impulses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1H' CHECK (timeframe IN ('D', '4H', '1H')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invalidated', 'expired', 'cancelled', 'filled')),
  -- Why the scanner retired it, so the UI can explain rather than just vanish.
  resolution_reason TEXT,
  -- Set when the scanner last resolved it against candles; null until first scan.
  last_resolved_at TIMESTAMPTZ,
  last_resolution_detail TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (high > low)
);

-- At most one live marking per symbol.
CREATE UNIQUE INDEX IF NOT EXISTS manual_impulses_one_active_per_symbol
  ON public.manual_impulses (user_id, bot_id, symbol)
  WHERE status = 'active';

-- The scanner's hot path: "is there a live marking for this pair right now?"
CREATE INDEX IF NOT EXISTS manual_impulses_active_lookup
  ON public.manual_impulses (user_id, bot_id, status, expires_at);

ALTER TABLE public.manual_impulses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own manual impulses" ON public.manual_impulses;
CREATE POLICY "Users manage own manual impulses"
  ON public.manual_impulses FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages manual impulses" ON public.manual_impulses;
CREATE POLICY "Service role manages manual impulses"
  ON public.manual_impulses FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.manual_impulses TO authenticated;

DROP TRIGGER IF EXISTS set_manual_impulses_updated_at ON public.manual_impulses;
CREATE TRIGGER set_manual_impulses_updated_at
  BEFORE UPDATE ON public.manual_impulses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
