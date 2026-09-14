
-- New audit log table
CREATE TABLE public.close_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  position_id text NOT NULL,
  symbol text NOT NULL,
  broker_connection_id uuid NULL,
  close_reason text NOT NULL,
  close_source text NOT NULL,
  pnl text NULL,
  exit_price text NULL,
  scan_cycle_id uuid NULL,
  detail_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.close_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own close audit log"
  ON public.close_audit_log
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_close_audit_log_user_created
  ON public.close_audit_log (user_id, created_at DESC);

CREATE INDEX idx_close_audit_log_position
  ON public.close_audit_log (position_id);

-- Track close reason on live positions
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS close_reason text NULL;

-- Track which broker connections this position was mirrored to
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS mirrored_connection_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- Per-user scan lock to prevent overlap
ALTER TABLE public.paper_accounts
  ADD COLUMN IF NOT EXISTS scan_lock_until timestamptz NULL;

ALTER TABLE public.paper_accounts
  ADD COLUMN IF NOT EXISTS enable_orphan_close boolean NOT NULL DEFAULT false;
