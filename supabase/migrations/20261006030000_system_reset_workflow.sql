-- System reset workflow: admin authorization, permanent audit trail, in-DB
-- pre-reset snapshot, and a server-side execution switch that ships OFF.
--
-- The reset itself is orchestrated by the system-reset Edge Function, called
-- from the admin card in the web app. It never runs automatically: it needs a
-- signed-in user listed in app_admins, the typed confirmation, a readiness
-- fingerprint that still matches, AND system_reset_controls.execute_enabled.
-- That last flag is false here and is flipped by a separate, hand-applied
-- change once the user has reviewed the readiness screen and the flow.

-- ── Admins ──────────────────────────────────────────────────────────────────
-- There was no role model before this: every check was "signed in" + row
-- ownership. Admin is a server-side fact, not a frontend flag.
CREATE TABLE IF NOT EXISTS public.app_admins (
  user_id uuid PRIMARY KEY,
  granted_at timestamptz NOT NULL DEFAULT now(),
  note text
);
INSERT INTO public.app_admins (user_id, note)
VALUES ('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'account owner; granted with the system reset workflow')
ON CONFLICT (user_id) DO NOTHING;
ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_admins FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_app_admin(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.app_admins WHERE user_id = p_user_id)
$function$;
REVOKE ALL ON FUNCTION public.is_app_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_admin(uuid) TO authenticated, service_role;

-- ── Execution switch (ships OFF) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.system_reset_controls (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  execute_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  note text
);
INSERT INTO public.system_reset_controls (id, execute_enabled, note)
VALUES (1, false, 'off until the readiness screen and flow are reviewed')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.system_reset_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.system_reset_controls FROM anon, authenticated;

-- ── Audit trail ─────────────────────────────────────────────────────────────
-- One row per reset attempt, including attempts aborted before they started.
-- Never deleted; immutable once it reaches a terminal status.
CREATE TABLE IF NOT EXISTS public.account_reset_runs (
  reset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  failed_step text,
  failure_reason text,
  readiness jsonb NOT NULL DEFAULT '{}'::jsonb,
  pre_reset_balance numeric(20,8),
  pre_reset_equity numeric(20,8),
  old_period_realized_pnl numeric(20,8),
  positions_closed jsonb NOT NULL DEFAULT '[]'::jsonb,
  orders_cancelled jsonb NOT NULL DEFAULT '[]'::jsonb,
  setups_cancelled jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot_id bigint,
  post_reset_balance numeric(20,8),
  reconciliation jsonb,
  verification jsonb,
  success boolean,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb
);
-- One reset at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_reset_runs_one_running
  ON public.account_reset_runs (account_id) WHERE status = 'running';

CREATE OR REPLACE FUNCTION public.account_reset_runs_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'account_reset_runs is permanent (% refused)', TG_OP;
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'reset run % is % and immutable', OLD.reset_id, OLD.status;
  END IF;
  IF NEW.reset_id IS DISTINCT FROM OLD.reset_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'reset run identity fields are immutable';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_account_reset_runs_guard ON public.account_reset_runs;
CREATE TRIGGER trg_account_reset_runs_guard
  BEFORE UPDATE OR DELETE ON public.account_reset_runs
  FOR EACH ROW EXECUTE FUNCTION public.account_reset_runs_guard();
DROP TRIGGER IF EXISTS trg_account_reset_runs_no_truncate ON public.account_reset_runs;
CREATE TRIGGER trg_account_reset_runs_no_truncate
  BEFORE TRUNCATE ON public.account_reset_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.account_reset_runs_guard();

ALTER TABLE public.account_reset_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read reset runs" ON public.account_reset_runs;
CREATE POLICY "Admins read reset runs" ON public.account_reset_runs
  FOR SELECT TO authenticated USING (public.is_app_admin(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.account_reset_runs FROM anon, authenticated;
GRANT SELECT ON public.account_reset_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.account_reset_runs TO service_role;

-- ── In-database pre-reset snapshot ──────────────────────────────────────────
-- Taken by the reset after the old period is flattened and before the balance
-- is reset. Complements, does not replace, the offline research snapshot.
CREATE TABLE IF NOT EXISTS public.account_reset_snapshots (
  id bigserial PRIMARY KEY,
  reset_id uuid NOT NULL REFERENCES public.account_reset_runs(reset_id),
  taken_at timestamptz NOT NULL DEFAULT now(),
  account jsonb NOT NULL,
  ledger jsonb NOT NULL,
  reconciliation jsonb NOT NULL,
  period_history jsonb NOT NULL,
  closed_positions jsonb NOT NULL,
  cancelled_orders jsonb NOT NULL,
  cancelled_setups jsonb NOT NULL,
  config jsonb,
  config_hash text,
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION public.account_reset_snapshots_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'account_reset_snapshots is append-only (% refused)', TG_OP;
END $function$;
DROP TRIGGER IF EXISTS trg_account_reset_snapshots_append_only ON public.account_reset_snapshots;
CREATE TRIGGER trg_account_reset_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.account_reset_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.account_reset_snapshots_append_only();
DROP TRIGGER IF EXISTS trg_account_reset_snapshots_no_truncate ON public.account_reset_snapshots;
CREATE TRIGGER trg_account_reset_snapshots_no_truncate
  BEFORE TRUNCATE ON public.account_reset_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.account_reset_snapshots_append_only();

ALTER TABLE public.account_reset_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read reset snapshots" ON public.account_reset_snapshots;
CREATE POLICY "Admins read reset snapshots" ON public.account_reset_snapshots
  FOR SELECT TO authenticated USING (public.is_app_admin(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.account_reset_snapshots FROM anon, authenticated;
GRANT SELECT ON public.account_reset_snapshots TO authenticated;
GRANT SELECT, INSERT ON public.account_reset_snapshots TO service_role;
GRANT USAGE ON SEQUENCE public.account_reset_snapshots_id_seq TO service_role;

-- ── Accounting objects present? (readiness prerequisite) ────────────────────
CREATE OR REPLACE FUNCTION public.accounting_objects_present()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'paper_account_ledger', to_regclass('public.paper_account_ledger') IS NOT NULL,
    'paper_account_reconciliation', to_regclass('public.paper_account_reconciliation') IS NOT NULL,
    'paper_ledger_guard', to_regclass('public.paper_ledger_guard') IS NOT NULL,
    'paper_balance_unledgered_writes', to_regclass('public.paper_balance_unledgered_writes') IS NOT NULL,
    'settlement_monitor_runs', to_regclass('public.settlement_monitor_runs') IS NOT NULL,
    'settle_paper_position', to_regprocedure('public.settle_paper_position(uuid,uuid,text,jsonb,text)') IS NOT NULL,
    'settle_paper_partial', to_regprocedure('public.settle_paper_partial(uuid,uuid,text,numeric,text,jsonb,text)') IS NOT NULL,
    'reset_paper_account', to_regprocedure('public.reset_paper_account(uuid,text,numeric,text)') IS NOT NULL,
    'balance_guard_trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_paper_accounts_balance_guard' AND NOT tgisinternal),
    'closed_at_timestamptz', EXISTS (SELECT 1 FROM information_schema.columns
                                      WHERE table_schema = 'public' AND table_name = 'paper_trade_history'
                                        AND column_name = 'closed_at' AND data_type = 'timestamp with time zone')
  )
$function$;
REVOKE ALL ON FUNCTION public.accounting_objects_present() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_objects_present() TO service_role;
