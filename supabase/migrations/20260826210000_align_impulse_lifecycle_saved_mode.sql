-- Align the atomic pending-order retarget with the runtime contract introduced
-- after the original certificate-gated rollout. The lifecycle row stores the
-- mode frozen when the setup was created; that frozen mode is the authority for
-- the setup. Evidence certificates remain available for review, but no longer
-- act as a second, hidden runtime switch.

CREATE OR REPLACE FUNCTION public.retarget_pending_to_impulse_candidate(
  p_pending_id UUID,
  p_user_id UUID,
  p_bot_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pending public.pending_orders%ROWTYPE;
  v_authority public.impulse_entry_lifecycles%ROWTYPE;
  v_candidate JSONB;
  v_entry NUMERIC;
  v_stop NUMERIC;
BEGIN
  SELECT * INTO v_pending FROM public.pending_orders
   WHERE id = p_pending_id AND user_id = p_user_id AND bot_id = p_bot_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('retargeted', false, 'code', 'order_missing'); END IF;

  SELECT * INTO v_authority FROM public.impulse_entry_lifecycles
   WHERE id = v_pending.impulse_entry_lifecycle_id FOR UPDATE;
  IF NOT FOUND OR v_authority.mode <> 'enforce' OR v_authority.status <> 'active' THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'authority_not_enforcing');
  END IF;

  SELECT candidate INTO v_candidate
    FROM jsonb_array_elements(v_authority.lifecycle -> 'candidates') candidate
   WHERE candidate ->> 'id' = v_authority.active_candidate_id;
  IF v_candidate IS NULL THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'candidate_missing');
  END IF;

  v_entry := CASE WHEN v_pending.direction = 'long'
    THEN (v_candidate ->> 'high')::NUMERIC ELSE (v_candidate ->> 'low')::NUMERIC END;
  v_stop := (v_authority.lifecycle #>> '{impulse,protectedLevel}')::NUMERIC;
  IF (v_pending.direction = 'long' AND v_stop >= v_entry)
    OR (v_pending.direction = 'short' AND v_stop <= v_entry) THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'invalid_stop_orientation');
  END IF;

  UPDATE public.pending_orders SET
    entry_zone_type = v_candidate ->> 'type',
    entry_zone_low = (v_candidate ->> 'low')::NUMERIC,
    entry_zone_high = (v_candidate ->> 'high')::NUMERIC,
    refined_zone_low = NULL,
    refined_zone_high = NULL,
    entry_price = v_entry,
    stop_loss = v_stop,
    status = 'pending',
    zone_touch_time = NULL,
    confirmation_attempts = 0,
    cancel_reason = NULL,
    resolved_at = NULL,
    signal_reason = COALESCE(v_pending.signal_reason, '{}'::JSONB) || jsonb_build_object(
      'impulseLifecycleRetarget', jsonb_build_object(
        'candidateId', v_authority.active_candidate_id,
        'generation', v_authority.lifecycle #>> '{confirmation,generation}',
        'authorizedBy', 'frozen_setup_config',
        'retargetedAt', now()
      )
    )
  WHERE id = v_pending.id;

  RETURN jsonb_build_object(
    'retargeted', true, 'candidate_id', v_authority.active_candidate_id,
    'entry_price', v_entry, 'stop_loss', v_stop
  );
END; $$;

COMMENT ON FUNCTION public.retarget_pending_to_impulse_candidate(UUID, UUID, TEXT) IS
  'Retargets an armed order using its locked impulse lifecycle. The lifecycle mode is frozen at setup creation; evidence certificates are advisory.';

REVOKE ALL ON FUNCTION public.retarget_pending_to_impulse_candidate(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retarget_pending_to_impulse_candidate(UUID, UUID, TEXT)
  TO service_role;
