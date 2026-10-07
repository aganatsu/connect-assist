-- STEP 15 PR 3 — dry-run (hypothetical) outcome resolution.
--
-- Two service-role-only functions, called by the attribution-outcome-resolver
-- Edge Function. They write ONLY trade_attribution section G (write-once, for
-- hypothetical fills) and trade_attribution_events. Nothing here touches an
-- order, a position, an account, the ledger or trade history.
--
--   attribution_resolve_hypothetical(signal_id, outcome)
--     writes the hypothetical close ONCE (advisory lock per signal; only while
--     fill_kind = 'hypothetical' AND closed_at IS NULL; the write-once guard
--     refuses any second value) + event outcome_resolved.
--   attribution_defer_hypothetical(signal_id, gap_start, detail)
--     records why it could not resolve yet (missing non-weekend 5m bar, or
--     invalid inputs) as outcome_deferred_data_gap, deduplicated per gap.

CREATE OR REPLACE FUNCTION public.attribution_resolve_hypothetical(p_signal_id uuid, p_outcome jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_n int;
  v_reason text := p_outcome ->> 'exit_reason';
BEGIN
  IF v_reason NOT IN ('hypothetical_stop', 'hypothetical_target', 'hypothetical_gap_through_stop', 'open_at_horizon') THEN
    RAISE EXCEPTION 'attribution_resolve_hypothetical: exit_reason % is not a hypothetical outcome', v_reason;
  END IF;
  IF (p_outcome ->> 'closed_at') IS NULL OR (p_outcome ->> 'exit_price') IS NULL OR (p_outcome ->> 'r_gross') IS NULL THEN
    RAISE EXCEPTION 'attribution_resolve_hypothetical: closed_at, exit_price and r_gross are required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('attribution_resolve:' || p_signal_id::text));
  UPDATE public.trade_attribution SET
    outcome_kind = 'hypothetical',
    outcome_method = COALESCE(p_outcome ->> 'method', 'bar_replay_5m.v1'),
    closed_at = (p_outcome ->> 'closed_at')::timestamptz,
    exit_price = (p_outcome ->> 'exit_price')::numeric,
    exit_reason = v_reason,
    close_source = 'attribution_outcome_resolver',
    realized_pnl_usd = NULLIF(p_outcome ->> 'pnl_usd', '')::numeric,
    realized_r_gross = (p_outcome ->> 'r_gross')::numeric,
    realized_r_net = NULLIF(p_outcome ->> 'r_net', '')::numeric
  WHERE signal_id = p_signal_id AND fill_kind = 'hypothetical' AND closed_at IS NULL
    AND (p_outcome ->> 'closed_at')::timestamptz >= filled_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN 'not_resolved'; END IF;   -- already resolved, not hypothetical, or closed before the fill
  PERFORM public.ta_event(p_signal_id, 'outcome_resolved', 'attribution_outcome_resolver', p_outcome, 'outcome');
  RETURN 'resolved';
END $function$;

CREATE OR REPLACE FUNCTION public.attribution_defer_hypothetical(p_signal_id uuid, p_gap_start timestamptz, p_detail jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.trade_attribution
                  WHERE signal_id = p_signal_id AND fill_kind = 'hypothetical' AND closed_at IS NULL) THEN
    RETURN 'not_applicable';
  END IF;
  PERFORM public.ta_event(p_signal_id, 'outcome_deferred_data_gap', 'attribution_outcome_resolver',
    COALESCE(p_detail, '{}'::jsonb) || jsonb_build_object('gap_start', p_gap_start),
    'deferred:' || COALESCE(to_char(p_gap_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'), COALESCE(p_detail ->> 'reason', 'unknown')));
  RETURN 'deferred';
END $function$;

REVOKE ALL ON FUNCTION public.attribution_resolve_hypothetical(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attribution_defer_hypothetical(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_resolve_hypothetical(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.attribution_defer_hypothetical(uuid, timestamptz, jsonb) TO service_role;
