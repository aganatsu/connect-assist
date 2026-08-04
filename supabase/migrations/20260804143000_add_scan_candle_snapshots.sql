CREATE TABLE IF NOT EXISTS public.scan_candle_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  scan_cycle_id text NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  provider text NOT NULL,
  observed_at timestamptz NOT NULL,
  completed_candle_cutoff timestamptz,
  candle_count integer NOT NULL,
  candles jsonb NOT NULL,
  contract_version text NOT NULL DEFAULT 'scan-candles.v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_candle_snapshots_count_chk CHECK (candle_count >= 0 AND candle_count <= 500),
  CONSTRAINT scan_candle_snapshots_candles_chk CHECK (jsonb_typeof(candles) = 'array'),
  UNIQUE (user_id, bot_id, scan_cycle_id, symbol, timeframe)
);

ALTER TABLE public.scan_candle_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.scan_candle_snapshots TO authenticated;
GRANT ALL ON public.scan_candle_snapshots TO service_role;

DROP POLICY IF EXISTS "Users read own scan candle snapshots" ON public.scan_candle_snapshots;
CREATE POLICY "Users read own scan candle snapshots"
ON public.scan_candle_snapshots FOR SELECT TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages scan candle snapshots" ON public.scan_candle_snapshots;
CREATE POLICY "Service role manages scan candle snapshots"
ON public.scan_candle_snapshots FOR ALL TO service_role
USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS scan_candle_snapshots_lookup_idx
  ON public.scan_candle_snapshots (user_id, symbol, timeframe, observed_at DESC);
CREATE INDEX IF NOT EXISTS scan_candle_snapshots_retention_idx
  ON public.scan_candle_snapshots (created_at);

CREATE OR REPLACE FUNCTION public.protect_scan_candle_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'scan candle snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_scan_candle_snapshot_trg ON public.scan_candle_snapshots;
CREATE TRIGGER protect_scan_candle_snapshot_trg
BEFORE UPDATE ON public.scan_candle_snapshots
FOR EACH ROW EXECUTE FUNCTION public.protect_scan_candle_snapshot();

REVOKE EXECUTE ON FUNCTION public.protect_scan_candle_snapshot() FROM anon, authenticated;
COMMENT ON TABLE public.scan_candle_snapshots IS
  'Immutable completed-candle inputs captured from a finished scanner pair evaluation for exact Bot Evidence chart replay.';
