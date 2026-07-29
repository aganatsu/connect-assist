-- Phase 5A: durable scanner runtime timeline and scoped lease authority.
--
-- Migration order:
--   1. Apply this migration.
--   2. Deploy bot-scanner, zone-confirmation-scanner, and scheduled-tasks.
--   3. Publish the frontend.
--
-- Runtime rows intentionally do not reference auth.users. Operational telemetry
-- must still be able to explain failures for an orphaned bot account.

CREATE TABLE IF NOT EXISTS public.scanner_operation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bot_id text NOT NULL DEFAULT 'smc',
  function_name text NOT NULL,
  operation text NOT NULL
    CHECK (operation IN ('scan', 'manage', 'zone_confirmation')),
  trigger_source text NOT NULL
    CHECK (trigger_source IN ('cron', 'manual')),
  status text NOT NULL DEFAULT 'invoked'
    CHECK (status IN ('invoked', 'running', 'completed', 'failed', 'skipped')),
  phase text NOT NULL DEFAULT 'cron_invoked',
  scan_cycle_id uuid,
  invoked_at timestamptz NOT NULL DEFAULT now(),
  scan_started_at timestamptz,
  pair_processing_completed_at timestamptz,
  scan_completed_at timestamptz,
  position_management_completed_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expected_pairs integer,
  processed_pairs integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scanner_operation_runs_user_task
  ON public.scanner_operation_runs
    (user_id, bot_id, function_name, operation, invoked_at DESC);

CREATE INDEX IF NOT EXISTS idx_scanner_operation_runs_incomplete
  ON public.scanner_operation_runs (heartbeat_at)
  WHERE status IN ('invoked', 'running');

ALTER TABLE public.scanner_operation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own scanner operation runs"
  ON public.scanner_operation_runs;
CREATE POLICY "Users read own scanner operation runs"
  ON public.scanner_operation_runs
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.scanner_operation_runs FROM anon;
GRANT SELECT ON public.scanner_operation_runs TO authenticated;
GRANT ALL ON public.scanner_operation_runs TO service_role;

CREATE TABLE IF NOT EXISTS public.scanner_runtime_locks (
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  lock_scope text NOT NULL,
  lease_token uuid NOT NULL,
  run_id uuid,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL,
  PRIMARY KEY (user_id, bot_id, lock_scope)
);

ALTER TABLE public.scanner_runtime_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scanner_runtime_locks FROM anon, authenticated;
GRANT ALL ON public.scanner_runtime_locks TO service_role;

CREATE OR REPLACE FUNCTION public.claim_scanner_runtime_lock(
  p_user_id uuid,
  p_bot_id text,
  p_lock_scope text,
  p_lease_token uuid,
  p_run_id uuid,
  p_lease_seconds integer DEFAULT 180
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer := 0;
BEGIN
  INSERT INTO public.scanner_runtime_locks (
    user_id,
    bot_id,
    lock_scope,
    lease_token,
    run_id,
    acquired_at,
    heartbeat_at,
    lease_until
  )
  VALUES (
    p_user_id,
    p_bot_id,
    p_lock_scope,
    p_lease_token,
    p_run_id,
    now(),
    now(),
    now() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 600)))
  )
  ON CONFLICT (user_id, bot_id, lock_scope)
  DO UPDATE SET
    lease_token = EXCLUDED.lease_token,
    run_id = EXCLUDED.run_id,
    acquired_at = now(),
    heartbeat_at = now(),
    lease_until = EXCLUDED.lease_until
  WHERE public.scanner_runtime_locks.lease_until <= now()
     OR public.scanner_runtime_locks.lease_token = p_lease_token;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_scanner_runtime_lock(
  p_user_id uuid,
  p_bot_id text,
  p_lock_scope text,
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 180
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer := 0;
BEGIN
  UPDATE public.scanner_runtime_locks
  SET
    heartbeat_at = now(),
    lease_until = now() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 600)))
  WHERE user_id = p_user_id
    AND bot_id = p_bot_id
    AND lock_scope = p_lock_scope
    AND lease_token = p_lease_token;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_scanner_runtime_lock(
  p_user_id uuid,
  p_bot_id text,
  p_lock_scope text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer := 0;
BEGIN
  DELETE FROM public.scanner_runtime_locks
  WHERE user_id = p_user_id
    AND bot_id = p_bot_id
    AND lock_scope = p_lock_scope
    AND lease_token = p_lease_token;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_scanner_runtime_lock(
  uuid, text, text, uuid, uuid, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_scanner_runtime_lock(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_scanner_runtime_lock(
  uuid, text, text, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_scanner_runtime_lock(
  uuid, text, text, uuid, uuid, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_scanner_runtime_lock(
  uuid, text, text, uuid, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_scanner_runtime_lock(
  uuid, text, text, uuid
) TO service_role;
