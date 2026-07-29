-- Phase 5B: automatic scanner health evaluation and durable alerts.
--
-- Migration order:
--   1. Apply this migration.
--   2. Deploy bot-scanner, zone-confirmation-scanner, and scheduled-tasks.
--   3. Publish the frontend.
--
-- This migration does not change strategy, trade authorization, execution
-- mode, or cron frequency. Health evaluation is observational only.

CREATE TABLE IF NOT EXISTS public.scanner_operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bot_id text NOT NULL DEFAULT 'smc',
  alert_type text NOT NULL CHECK (
    alert_type IN (
      'scanner_heartbeat_missing',
      'scan_incomplete',
      'metaapi_certificate_failure',
      'metaapi_connection_failure',
      'candle_source_exhaustion',
      'stuck_confirmation_order',
      'authorization_error',
      'migration_drift'
    )
  ),
  dedupe_key text NOT NULL DEFAULT 'default',
  severity text NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved')),
  title text NOT NULL,
  message text NOT NULL,
  run_id uuid,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences integer NOT NULL DEFAULT 1,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scanner_alerts_one_active
  ON public.scanner_operational_alerts
    (user_id, bot_id, alert_type, dedupe_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_scanner_alerts_user_status
  ON public.scanner_operational_alerts
    (user_id, bot_id, status, severity, last_detected_at DESC);

ALTER TABLE public.scanner_operational_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own scanner operational alerts"
  ON public.scanner_operational_alerts;
CREATE POLICY "Users read own scanner operational alerts"
  ON public.scanner_operational_alerts
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.scanner_operational_alerts FROM anon;
GRANT SELECT ON public.scanner_operational_alerts TO authenticated;
GRANT ALL ON public.scanner_operational_alerts TO service_role;

CREATE TABLE IF NOT EXISTS public.scanner_authorization_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  function_name text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_scanner_auth_failures_function_time
  ON public.scanner_authorization_failures (function_name, occurred_at DESC);

ALTER TABLE public.scanner_authorization_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scanner_authorization_failures FROM anon, authenticated;
GRANT ALL ON public.scanner_authorization_failures TO service_role;

CREATE TABLE IF NOT EXISTS public.scanner_health_monitor_state (
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bot_id)
);

ALTER TABLE public.scanner_health_monitor_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scanner_health_monitor_state FROM anon, authenticated;
GRANT ALL ON public.scanner_health_monitor_state TO service_role;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS last_confirmation_checked_at timestamptz;

CREATE OR REPLACE FUNCTION public.upsert_scanner_operational_alert(
  p_user_id uuid,
  p_bot_id text,
  p_alert_type text,
  p_dedupe_key text,
  p_severity text,
  p_title text,
  p_message text,
  p_run_id uuid DEFAULT NULL,
  p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alert_id uuid;
BEGIN
  INSERT INTO public.scanner_operational_alerts (
    user_id,
    bot_id,
    alert_type,
    dedupe_key,
    severity,
    status,
    title,
    message,
    run_id,
    evidence,
    occurrences,
    first_detected_at,
    last_detected_at,
    updated_at
  )
  VALUES (
    p_user_id,
    COALESCE(NULLIF(p_bot_id, ''), 'smc'),
    p_alert_type,
    COALESCE(NULLIF(p_dedupe_key, ''), 'default'),
    p_severity,
    'active',
    p_title,
    p_message,
    p_run_id,
    COALESCE(p_evidence, '{}'::jsonb),
    1,
    now(),
    now(),
    now()
  )
  ON CONFLICT (user_id, bot_id, alert_type, dedupe_key)
    WHERE status = 'active'
  DO UPDATE SET
    severity = EXCLUDED.severity,
    title = EXCLUDED.title,
    message = EXCLUDED.message,
    run_id = EXCLUDED.run_id,
    evidence = EXCLUDED.evidence,
    occurrences = public.scanner_operational_alerts.occurrences + 1,
    last_detected_at = now(),
    updated_at = now()
  RETURNING id INTO alert_id;

  RETURN alert_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_scanner_operational_alert(
  p_user_id uuid,
  p_bot_id text,
  p_alert_type text,
  p_dedupe_key text DEFAULT 'default'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer := 0;
BEGIN
  UPDATE public.scanner_operational_alerts
  SET
    status = 'resolved',
    resolved_at = now(),
    updated_at = now()
  WHERE user_id = p_user_id
    AND bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
    AND alert_type = p_alert_type
    AND dedupe_key = COALESCE(NULLIF(p_dedupe_key, ''), 'default')
    AND status = 'active';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_scanner_operational_alert(
  uuid, text, text, text, text, text, text, uuid, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_scanner_operational_alert(
  uuid, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_scanner_operational_alert(
  uuid, text, text, text, text, text, text, uuid, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_scanner_operational_alert(
  uuid, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.evaluate_scanner_operational_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  account_row record;
  operation_row record;
  latest_invocation timestamptz;
  stale_run_id uuid;
  stale_run_phase text;
  stale_run_heartbeat timestamptz;
  stale_confirmation_count integer;
  auth_failure_count integer;
  drift_items text[];
  grace_complete boolean;
  active_alerts integer;
BEGIN
  DELETE FROM public.scanner_authorization_failures
  WHERE occurred_at < now() - interval '24 hours';

  FOR account_row IN
    SELECT
      user_id,
      COALESCE(NULLIF(bot_id, ''), 'smc') AS bot_id
    FROM public.paper_accounts
    WHERE is_running = true
      AND kill_switch_active = false
  LOOP
    INSERT INTO public.scanner_health_monitor_state (
      user_id,
      bot_id,
      first_observed_at,
      last_evaluated_at
    )
    VALUES (account_row.user_id, account_row.bot_id, now(), now())
    ON CONFLICT (user_id, bot_id)
    DO UPDATE SET last_evaluated_at = now();

    SELECT first_observed_at <= now() - interval '12 minutes'
    INTO grace_complete
    FROM public.scanner_health_monitor_state
    WHERE user_id = account_row.user_id
      AND bot_id = account_row.bot_id;

    FOR operation_row IN
      SELECT *
      FROM (
        VALUES
          ('bot-scanner', 'scan', 5),
          ('bot-scanner', 'manage', 1),
          ('zone-confirmation-scanner', 'zone_confirmation', 1)
      ) AS operations(function_name, operation, default_interval)
    LOOP
      SELECT sor.invoked_at
      INTO latest_invocation
      FROM public.scanner_operation_runs sor
      WHERE sor.user_id = account_row.user_id
        AND sor.bot_id = account_row.bot_id
        AND sor.function_name = operation_row.function_name
        AND sor.operation = operation_row.operation
        AND sor.trigger_source = 'cron'
      ORDER BY sor.invoked_at DESC
      LIMIT 1;

      IF grace_complete AND (
        latest_invocation IS NULL
        OR latest_invocation < now() - make_interval(
          mins => GREATEST(operation_row.default_interval * 2 + 1, 3)
        )
      ) THEN
        PERFORM public.upsert_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scanner_heartbeat_missing',
          operation_row.function_name || ':' || operation_row.operation,
          CASE WHEN operation_row.operation = 'scan' THEN 'critical' ELSE 'warning' END,
          'Scanner heartbeat missing',
          operation_row.function_name || ' ' || operation_row.operation ||
            ' has not been invoked within its expected window.',
          NULL,
          jsonb_build_object(
            'function_name', operation_row.function_name,
            'operation', operation_row.operation,
            'latest_invocation', latest_invocation
          )
        );
      ELSE
        PERFORM public.resolve_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scanner_heartbeat_missing',
          operation_row.function_name || ':' || operation_row.operation
        );
      END IF;

      SELECT sor.id, sor.phase, sor.heartbeat_at
      INTO stale_run_id, stale_run_phase, stale_run_heartbeat
      FROM public.scanner_operation_runs sor
      WHERE sor.user_id = account_row.user_id
        AND sor.bot_id = account_row.bot_id
        AND sor.function_name = operation_row.function_name
        AND sor.operation = operation_row.operation
        AND sor.status IN ('invoked', 'running')
        AND sor.heartbeat_at < now() - interval '3 minutes'
      ORDER BY sor.heartbeat_at ASC
      LIMIT 1;

      IF stale_run_id IS NOT NULL THEN
        PERFORM public.upsert_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scan_incomplete',
          operation_row.function_name || ':' || operation_row.operation,
          'critical',
          'Scanner run stopped before completion',
          'The last durable heartbeat stopped at phase "' ||
            COALESCE(stale_run_phase, 'unknown') || '".',
          stale_run_id,
          jsonb_build_object(
            'phase', stale_run_phase,
            'heartbeat_at', stale_run_heartbeat
          )
        );
      ELSE
        PERFORM public.resolve_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scan_incomplete',
          operation_row.function_name || ':' || operation_row.operation
        );
      END IF;
      stale_run_id := NULL;
      stale_run_phase := NULL;
      stale_run_heartbeat := NULL;
    END LOOP;

    SELECT count(*)
    INTO stale_confirmation_count
    FROM public.pending_orders po
    WHERE po.user_id = account_row.user_id
      AND po.bot_id = account_row.bot_id
      AND po.status = 'awaiting_confirmation'
      AND po.expires_at > now()
      AND COALESCE(
        po.last_confirmation_checked_at,
        po.zone_touch_time,
        po.updated_at
      ) < now() - interval '3 minutes';

    IF stale_confirmation_count > 0 THEN
      PERFORM public.upsert_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'stuck_confirmation_order',
        'awaiting_confirmation',
        'critical',
        'Confirmation order is not being checked',
        stale_confirmation_count || ' awaiting-confirmation order(s) have not ' ||
          'been checked for more than three minutes.',
        NULL,
        jsonb_build_object('stale_order_count', stale_confirmation_count)
      );
    ELSE
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'stuck_confirmation_order',
        'awaiting_confirmation'
      );
    END IF;

    FOR operation_row IN
      SELECT function_name, count(*)::integer AS failure_count
      FROM public.scanner_authorization_failures
      WHERE occurred_at >= now() - interval '10 minutes'
      GROUP BY function_name
    LOOP
      auth_failure_count := operation_row.failure_count;
      IF auth_failure_count >= 3 THEN
        PERFORM public.upsert_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'authorization_error',
          operation_row.function_name,
          'critical',
          'Repeated scanner authorization failures',
          operation_row.function_name || ' rejected ' || auth_failure_count ||
            ' scheduler request(s) in the last ten minutes.',
          NULL,
          jsonb_build_object(
            'function_name', operation_row.function_name,
            'failures_10m', auth_failure_count
          )
        );
      END IF;
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM public.scanner_authorization_failures
      WHERE function_name = 'bot-scanner'
        AND occurred_at >= now() - interval '10 minutes'
      GROUP BY function_name
      HAVING count(*) >= 3
    ) THEN
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'authorization_error',
        'bot-scanner'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.scanner_authorization_failures
      WHERE function_name = 'zone-confirmation-scanner'
        AND occurred_at >= now() - interval '10 minutes'
      GROUP BY function_name
      HAVING count(*) >= 3
    ) THEN
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'authorization_error',
        'zone-confirmation-scanner'
      );
    END IF;

    drift_items := ARRAY[]::text[];
    IF to_regclass('public.scanner_operation_runs') IS NULL THEN
      drift_items := array_append(drift_items, 'scanner_operation_runs');
    END IF;
    IF to_regclass('public.scanner_runtime_locks') IS NULL THEN
      drift_items := array_append(drift_items, 'scanner_runtime_locks');
    END IF;
    IF to_regclass('public.scanner_operational_alerts') IS NULL THEN
      drift_items := array_append(drift_items, 'scanner_operational_alerts');
    END IF;
    IF to_regprocedure(
      'public.claim_scanner_runtime_lock(uuid,text,text,uuid,uuid,integer)'
    ) IS NULL THEN
      drift_items := array_append(drift_items, 'claim_scanner_runtime_lock');
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pending_orders'
        AND column_name = 'last_confirmation_checked_at'
    ) THEN
      drift_items := array_append(
        drift_items,
        'pending_orders.last_confirmation_checked_at'
      );
    END IF;

    IF cardinality(drift_items) > 0 THEN
      PERFORM public.upsert_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'migration_drift',
        'phase5_objects',
        'critical',
        'Scanner database migration mismatch',
        'Required runtime objects are missing: ' || array_to_string(drift_items, ', '),
        NULL,
        jsonb_build_object('missing_objects', to_jsonb(drift_items))
      );
    ELSE
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'migration_drift',
        'phase5_objects'
      );
    END IF;
  END LOOP;

  SELECT count(*)
  INTO active_alerts
  FROM public.scanner_operational_alerts
  WHERE status = 'active';

  RETURN jsonb_build_object(
    'evaluated_at', now(),
    'active_alerts', active_alerts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_scanner_operational_health()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_scanner_operational_health()
  TO service_role;

SELECT cron.schedule(
  'scanner-operational-health-1min',
  '* * * * *',
  $$SELECT public.evaluate_scanner_operational_health();$$
);
