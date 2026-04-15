
CREATE TABLE public.scan_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  pairs_scanned integer NOT NULL DEFAULT 0,
  signals_found integer NOT NULL DEFAULT 0,
  trades_placed integer NOT NULL DEFAULT 0,
  details_json jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.scan_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own scan logs" ON public.scan_logs
  FOR ALL TO public
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
