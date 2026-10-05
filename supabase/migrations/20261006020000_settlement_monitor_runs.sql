-- Results table for the settlement-monitor Edge Function.
--
-- The monitor is read-only against trading state. This table is the ONLY thing
-- it writes: one row per run, PASS or FAIL, with every check and the exact
-- failure. It replaces a laptop-bound check during the 24h observation window
-- after the settlement ledger (20261006010000) went live, and stays useful
-- after it: the same checks guard every later period.
--
-- Append-only, like the ledger it watches.

CREATE TABLE IF NOT EXISTS public.settlement_monitor_runs (
  id bigserial PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  mode text NOT NULL CHECK (mode IN ('periodic', 'final')),
  account_id uuid,
  epoch_id uuid,
  pass boolean NOT NULL,
  checks jsonb NOT NULL,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_settlement_monitor_runs_run_at
  ON public.settlement_monitor_runs (run_at DESC);

-- One final verdict per ledger epoch: a re-fired final job records nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_monitor_runs_one_final
  ON public.settlement_monitor_runs (epoch_id) WHERE mode = 'final';

CREATE OR REPLACE FUNCTION public.settlement_monitor_runs_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'settlement_monitor_runs is append-only (% refused)', TG_OP;
END $function$;

DROP TRIGGER IF EXISTS trg_settlement_monitor_runs_append_only ON public.settlement_monitor_runs;
CREATE TRIGGER trg_settlement_monitor_runs_append_only
  BEFORE UPDATE OR DELETE ON public.settlement_monitor_runs
  FOR EACH ROW EXECUTE FUNCTION public.settlement_monitor_runs_append_only();

ALTER TABLE public.settlement_monitor_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.settlement_monitor_runs FROM anon, authenticated;
GRANT SELECT, INSERT ON public.settlement_monitor_runs TO service_role;
GRANT USAGE ON SEQUENCE public.settlement_monitor_runs_id_seq TO service_role;
