-- Explicit Watchlist phase observability.
--
-- `status` remains the database workflow state and `lifecycle_reason_code`
-- remains the reason for a decision. `lifecycle_phase` records how far the
-- market story actually progressed. This prevents labels such as AT ZONE from
-- overwriting the reason a setup was retained or invalidated.

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS lifecycle_phase TEXT;

ALTER TABLE public.setup_lifecycle_events
  ADD COLUMN IF NOT EXISTS lifecycle_phase TEXT;

ALTER TABLE public.staged_setups
  DROP CONSTRAINT IF EXISTS staged_setups_lifecycle_phase_check;
ALTER TABLE public.staged_setups
  ADD CONSTRAINT staged_setups_lifecycle_phase_check CHECK (
    lifecycle_phase IS NULL OR lifecycle_phase IN (
      'monitoring_pre_zone',
      'zone_discovered',
      'approaching_zone',
      'at_zone',
      'local_trigger_active',
      'local_trigger_swept',
      'sweep_rejected',
      'confirmation_ready',
      'entry_authorized',
      'position_managing'
    )
  );

CREATE INDEX IF NOT EXISTS idx_staged_setups_lifecycle_phase
  ON public.staged_setups (
    user_id,
    bot_id,
    lifecycle_phase,
    updated_at DESC
  );

UPDATE public.staged_setups
   SET lifecycle_phase = CASE
     WHEN status = 'filled' AND position_id IS NOT NULL
       THEN 'position_managing'
     WHEN status = 'filled'
       THEN 'entry_authorized'
     WHEN status IN ('qualified', 'pending', 'awaiting_confirmation')
       THEN 'confirmation_ready'
     WHEN lifecycle_evidence->>'phase' IS NOT NULL
       THEN lifecycle_evidence->>'phase'
     WHEN execution_eligible = false
       THEN 'monitoring_pre_zone'
     ELSE 'zone_discovered'
   END
 WHERE lifecycle_phase IS NULL;

UPDATE public.setup_lifecycle_events event
   SET lifecycle_phase = COALESCE(
     event.lifecycle_phase,
     event.evidence #>> '{lifecycleEvidence,phase}',
     setup.lifecycle_phase
   )
  FROM public.staged_setups setup
 WHERE setup.id = event.staged_setup_id
   AND event.lifecycle_phase IS NULL;

CREATE OR REPLACE FUNCTION public.populate_staged_setup_lifecycle_phase()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phase TEXT;
  v_milestones JSONB;
BEGIN
  IF NEW.status = 'filled' AND NEW.position_id IS NOT NULL THEN
    v_phase := 'position_managing';
    NEW.lifecycle_reason_code := 'position_managing';
    NEW.lifecycle_reason := COALESCE(
      NEW.lifecycle_reason,
      'Position successfully created and is under management'
    );
  ELSIF NEW.status = 'filled' THEN
    v_phase := 'entry_authorized';
    NEW.lifecycle_reason_code := 'entry_authorized';
    NEW.lifecycle_reason := COALESCE(
      NEW.lifecycle_reason,
      'Entry authorization completed'
    );
  ELSE
    v_phase := COALESCE(
      NULLIF(NEW.lifecycle_evidence->>'phase', ''),
      NEW.lifecycle_phase,
      CASE
        WHEN NEW.status IN (
          'qualified',
          'pending',
          'awaiting_confirmation'
        ) THEN 'confirmation_ready'
        WHEN NEW.execution_eligible = false THEN 'monitoring_pre_zone'
        ELSE 'zone_discovered'
      END
    );
  END IF;

  NEW.lifecycle_phase := v_phase;
  v_milestones := CASE
    WHEN jsonb_typeof(NEW.lifecycle_evidence->'milestones') = 'array'
      THEN NEW.lifecycle_evidence->'milestones'
    ELSE '[]'::JSONB
  END;

  IF NEW.status = 'filled' AND NOT (v_milestones ? 'entry_authorized') THEN
    v_milestones := v_milestones || '"entry_authorized"'::JSONB;
  END IF;
  IF v_phase = 'position_managing' AND
     NOT (v_milestones ? 'position_managing') THEN
    v_milestones := v_milestones || '"position_managing"'::JSONB;
  END IF;
  IF jsonb_array_length(v_milestones) = 0 THEN
    v_milestones := jsonb_build_array(v_phase);
  END IF;

  NEW.lifecycle_evidence := jsonb_set(
    jsonb_set(
      jsonb_set(
        COALESCE(NEW.lifecycle_evidence, '{}'::JSONB),
        '{phase}',
        to_jsonb(v_phase),
        true
      ),
      '{milestones}',
      v_milestones,
      true
    ),
    '{reasonCode}',
    to_jsonb(COALESCE(NEW.lifecycle_reason_code, 'legacy_transition')),
    true
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_staged_setup_lifecycle_phase
  ON public.staged_setups;
CREATE TRIGGER populate_staged_setup_lifecycle_phase
  BEFORE INSERT OR UPDATE OF
    status,
    lifecycle_evidence,
    lifecycle_phase,
    position_id
  ON public.staged_setups
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_staged_setup_lifecycle_phase();

CREATE OR REPLACE FUNCTION public.audit_staged_setup_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR
     NEW.status IS DISTINCT FROM OLD.status OR
     NEW.lifecycle_phase IS DISTINCT FROM OLD.lifecycle_phase OR
     NEW.lifecycle_reason_code IS DISTINCT FROM OLD.lifecycle_reason_code THEN
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
      lifecycle_phase,
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
      NEW.lifecycle_phase,
      jsonb_strip_nulls(jsonb_build_object(
        'lifecycleVersion', NEW.lifecycle_version,
        'lifecyclePhase', NEW.lifecycle_phase,
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

DROP TRIGGER IF EXISTS audit_staged_setup_transition
  ON public.staged_setups;
CREATE TRIGGER audit_staged_setup_transition
  AFTER INSERT OR UPDATE OF
    status,
    lifecycle_phase,
    lifecycle_reason_code
  ON public.staged_setups
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_staged_setup_transition();

-- A pending fill may mark the setup `filled` before the position row is
-- inserted. Permit the position insert to advance that same setup from
-- ENTRY AUTHORIZED to POSITION MANAGING without changing workflow status.
CREATE OR REPLACE FUNCTION public.sync_staged_setup_from_position()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.staged_setup_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.staged_setups
     SET status = 'filled',
         lifecycle_reason = 'Position successfully created',
         position_id = NEW.id,
         authorization_result = COALESCE(
           NEW.final_authorization,
           authorization_result
         ),
         resolved_at = COALESCE(resolved_at, now()),
         updated_at = now()
   WHERE id = NEW.staged_setup_id
     AND status IN (
       'qualified',
       'pending',
       'awaiting_confirmation',
       'filled'
     );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  public.populate_staged_setup_lifecycle_phase() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.audit_staged_setup_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.sync_staged_setup_from_position() FROM PUBLIC;

COMMENT ON COLUMN public.staged_setups.lifecycle_phase IS
  'Furthest directly observed phase in the frozen Watchlist market story.';
COMMENT ON COLUMN public.setup_lifecycle_events.lifecycle_phase IS
  'Immutable phase recorded when the Watchlist story advanced or resolved.';
