-- Allow the scanner's silent-stall alert type 'all_pairs_blocked'.
--
-- bot-scanner (_shared/blockStall.ts) writes it through the existing
-- upsert_scanner_operational_alert / resolve_scanner_operational_alert RPCs when
-- every pair is skipped for the same reason; at 6h of blocked market time it
-- sends one Telegram message. Background: 2026-10-28/30, requireUnifiedZone vs
-- the hidden simplification.unifiedModifiersEnabled switch blocked every pair
-- for ~36h and nothing reported it.
--
-- PRECHECK: the live constraint must allow exactly the baseline types (plus,
-- on a re-run, this one). If a type was added elsewhere, this stops instead of
-- silently dropping it. Idempotent.

DO $precheck$
DECLARE
  def text;
  live text[];
  expected text[] := ARRAY['authorization_error', 'candle_source_exhaustion', 'metaapi_certificate_failure',
                           'metaapi_connection_failure', 'migration_drift', 'scan_incomplete',
                           'scanner_heartbeat_missing', 'stuck_confirmation_order'];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.scanner_operational_alerts'::regclass
    AND c.conname = 'scanner_operational_alerts_alert_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'scanner_operational_alerts_alert_type_check not found — not changing anything';
  END IF;
  SELECT array_agg(m[1] ORDER BY m[1]) INTO live
  FROM regexp_matches(def, '''([a-z_]+)''::text', 'g') AS m
  WHERE m[1] <> 'all_pairs_blocked';
  IF live IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'alert_type constraint differs from the baseline (live: %) — not overwriting', def;
  END IF;
END $precheck$;

ALTER TABLE public.scanner_operational_alerts
  DROP CONSTRAINT scanner_operational_alerts_alert_type_check;

ALTER TABLE public.scanner_operational_alerts
  ADD CONSTRAINT scanner_operational_alerts_alert_type_check CHECK ((alert_type = ANY (ARRAY[
    'scanner_heartbeat_missing'::text, 'scan_incomplete'::text, 'metaapi_certificate_failure'::text,
    'metaapi_connection_failure'::text, 'candle_source_exhaustion'::text, 'stuck_confirmation_order'::text,
    'authorization_error'::text, 'migration_drift'::text, 'all_pairs_blocked'::text])));
