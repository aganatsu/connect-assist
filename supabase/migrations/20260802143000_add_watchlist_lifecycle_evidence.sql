-- Canonical Watchlist lifecycle evidence.
--
-- A pre-entry Watchlist invalidation is not a trade stop-loss event. Persist
-- the machine-readable reason and the exact evidence used by the transition so
-- history and UI can distinguish structural invalidation, expiry, dismissal,
-- retention, sweep waiting and confirmation waiting.

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS lifecycle_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_evidence JSONB NOT NULL
    DEFAULT '{}'::JSONB;

ALTER TABLE public.setup_lifecycle_events
  ADD COLUMN IF NOT EXISTS reason_code TEXT;

UPDATE public.staged_setups
   SET lifecycle_reason_code = CASE
         WHEN lifecycle_reason_code IS NOT NULL
           THEN lifecycle_reason_code
         WHEN status = 'expired'
           THEN 'ttl_expired'
         WHEN COALESCE(invalidation_reason, lifecycle_reason, '') ILIKE
              '%manually dismissed%'
           THEN 'manual_dismissal'
         WHEN COALESCE(invalidation_reason, lifecycle_reason, '') ILIKE
              '%structural%'
           THEN 'structural_boundary_breached'
         ELSE 'legacy_transition'
       END,
       lifecycle_evidence = CASE
         WHEN lifecycle_evidence <> '{}'::JSONB
           THEN lifecycle_evidence
         ELSE jsonb_strip_nulls(jsonb_build_object(
           'version', 'watchlist-lifecycle-evidence.v1',
           'reasonCode', CASE
             WHEN status = 'expired'
               THEN 'ttl_expired'
             WHEN COALESCE(invalidation_reason, lifecycle_reason, '') ILIKE
                  '%manually dismissed%'
               THEN 'manual_dismissal'
             WHEN COALESCE(invalidation_reason, lifecycle_reason, '') ILIKE
                  '%structural%'
               THEN 'structural_boundary_breached'
             ELSE 'legacy_transition'
           END,
           'observedAt', COALESCE(
             resolved_at,
             last_eval_at,
             updated_at,
             created_at
           ),
           'frozenDirection', direction,
           'boundary', CASE
             WHEN sl_level IS NULL THEN NULL
             ELSE jsonb_build_object(
               'level', sl_level,
               'source', 'legacy_stored_level',
               'bufferPrice', 0,
               'zone', originating_zone
             )
           END,
           'detail', jsonb_build_object(
             'historicalBackfill', true
           )
         ))
       END
 WHERE lifecycle_reason_code IS NULL
    OR lifecycle_evidence = '{}'::JSONB;

UPDATE public.setup_lifecycle_events event
   SET reason_code = COALESCE(
     event.reason_code,
     setup.lifecycle_reason_code,
     'legacy_transition'
   ),
       evidence = event.evidence || jsonb_build_object(
         'lifecycleEvidence',
         setup.lifecycle_evidence
       )
  FROM public.staged_setups setup
 WHERE setup.id = event.staged_setup_id
   AND (
     event.reason_code IS NULL OR
     NOT (event.evidence ? 'lifecycleEvidence')
   );

CREATE OR REPLACE FUNCTION public.audit_staged_setup_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.setup_lifecycle_events (
      staged_setup_id,
      candidate_id,
      user_id,
      bot_id,
      symbol,
      direction,
      from_status,
      to_status,
      reason,
      reason_code,
      evidence
    ) VALUES (
      NEW.id,
      NEW.candidate_id,
      NEW.user_id,
      NEW.bot_id,
      NEW.symbol,
      NEW.direction,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status,
      COALESCE(
        NEW.lifecycle_reason,
        NEW.invalidation_reason,
        NEW.promotion_reason
      ),
      COALESCE(NEW.lifecycle_reason_code, 'legacy_transition'),
      jsonb_strip_nulls(jsonb_build_object(
        'lifecycleVersion', NEW.lifecycle_version,
        'lifecycleEvidence', NEW.lifecycle_evidence,
        'gamePlanId', NEW.game_plan_id,
        'gamePlanVersion', NEW.game_plan_version,
        'directionVerdictId', NEW.direction_verdict_id,
        'directionVerdict', NEW.direction_verdict,
        'thesisVersion', NEW.thesis_version,
        'originatingZone', NEW.originating_zone,
        'confirmationMethod', NEW.confirmation_method,
        'confirmationConfig', NEW.confirmation_config,
        'authorizationResult', NEW.authorization_result,
        'pendingOrderId', NEW.pending_order_id,
        'positionId', NEW.position_id
      ))
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_staged_setup(
  p_setup_id UUID,
  p_user_id UUID,
  p_to_status TEXT,
  p_reason TEXT,
  p_evidence JSONB DEFAULT '{}'::JSONB,
  p_pending_order_id UUID DEFAULT NULL,
  p_position_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_setup public.staged_setups%ROWTYPE;
  v_allowed BOOLEAN := false;
BEGIN
  SELECT *
    INTO v_setup
    FROM public.staged_setups
   WHERE id = p_setup_id
     AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'transitioned', false,
      'code', 'setup_not_found',
      'reason', 'Watchlist setup was not found'
    );
  END IF;

  IF v_setup.status = p_to_status THEN
    v_allowed := true;
  ELSIF v_setup.status = 'watching' THEN
    v_allowed := p_to_status IN (
      'qualified', 'invalidated', 'expired', 'cancelled'
    );
  ELSIF v_setup.status = 'qualified' THEN
    v_allowed := p_to_status IN (
      'pending', 'filled', 'blocked_after_qualification',
      'invalidated', 'expired', 'cancelled'
    );
  ELSIF v_setup.status = 'pending' THEN
    v_allowed := p_to_status IN (
      'awaiting_confirmation', 'filled', 'invalidated',
      'expired', 'cancelled'
    );
  ELSIF v_setup.status = 'awaiting_confirmation' THEN
    v_allowed := p_to_status IN (
      'pending', 'filled', 'invalidated', 'expired', 'cancelled'
    );
  END IF;

  IF NOT v_allowed THEN
    RETURN jsonb_build_object(
      'transitioned', false,
      'code', 'invalid_transition',
      'reason', format(
        'Setup lifecycle cannot transition from %s to %s',
        v_setup.status,
        p_to_status
      )
    );
  END IF;

  UPDATE public.staged_setups
     SET status = p_to_status,
         lifecycle_reason = p_reason,
         lifecycle_reason_code = COALESCE(
           NULLIF(p_evidence->>'reasonCode', ''),
           'legacy_transition'
         ),
         lifecycle_evidence = COALESCE(
           p_evidence->'lifecycleEvidence',
           '{}'::JSONB
         ),
         qualified_at = CASE
           WHEN p_to_status = 'qualified'
             THEN COALESCE(qualified_at, now())
           ELSE qualified_at
         END,
         resolved_at = CASE
           WHEN p_to_status IN (
             'filled',
             'blocked_after_qualification',
             'invalidated',
             'expired',
             'cancelled'
           ) THEN COALESCE(resolved_at, now())
           ELSE NULL
         END,
         pending_order_id = COALESCE(
           p_pending_order_id,
           pending_order_id
         ),
         position_id = COALESCE(p_position_id, position_id),
         authorization_result = COALESCE(
           p_evidence->'authorizationResult',
           authorization_result
         ),
         originating_zone = COALESCE(
           p_evidence->'originatingZone',
           originating_zone
         ),
         confirmation_method = COALESCE(
           p_evidence->>'confirmationMethod',
           confirmation_method
         ),
         confirmation_config = COALESCE(
           p_evidence->'confirmationConfig',
           confirmation_config,
           '{}'::JSONB
         ),
         game_plan_id = COALESCE(
           NULLIF(p_evidence->>'gamePlanId', '')::UUID,
           game_plan_id
         ),
         game_plan_version = COALESCE(
           p_evidence->>'gamePlanVersion',
           game_plan_version
         ),
         direction_verdict_id = COALESCE(
           NULLIF(p_evidence->>'directionVerdictId', '')::UUID,
           direction_verdict_id
         ),
         direction_verdict = COALESCE(
           p_evidence->'directionVerdict',
           direction_verdict
         ),
         thesis_version = COALESCE(
           p_evidence->>'thesisVersion',
           thesis_version
         ),
         updated_at = now()
   WHERE id = v_setup.id
   RETURNING * INTO v_setup;

  RETURN jsonb_build_object(
    'transitioned', true,
    'code', 'transitioned',
    'row', to_jsonb(v_setup)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transition_staged_setup(
  UUID, UUID, TEXT, TEXT, JSONB, UUID, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_staged_setup(
  UUID, UUID, TEXT, TEXT, JSONB, UUID, UUID
) TO service_role;

COMMENT ON COLUMN public.staged_setups.lifecycle_reason_code IS
  'Canonical machine-readable reason for the latest Watchlist lifecycle decision.';
COMMENT ON COLUMN public.staged_setups.lifecycle_evidence IS
  'Exact frozen boundary, observed price, sweep and scan evidence used by the latest Watchlist lifecycle decision.';
COMMENT ON COLUMN public.setup_lifecycle_events.reason_code IS
  'Canonical machine-readable reason for this immutable lifecycle transition.';
