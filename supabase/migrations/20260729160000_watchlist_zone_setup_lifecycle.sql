-- Phase 4 — Watchlist and Zone Setup lifecycle
--
-- New setups follow one auditable state machine:
-- watching -> qualified -> pending -> awaiting_confirmation -> filled
-- with terminal invalidated / expired / cancelled outcomes and an explicit
-- blocked_after_qualification outcome.

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS candidate_id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS lifecycle_version TEXT NOT NULL DEFAULT 'phase4.v1',
  ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT,
  ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_order_id UUID
    REFERENCES public.pending_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS position_id UUID
    REFERENCES public.paper_positions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS game_plan_id UUID
    REFERENCES public.active_game_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS game_plan_version TEXT,
  ADD COLUMN IF NOT EXISTS direction_verdict_id UUID
    REFERENCES public.active_direction_verdicts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS direction_verdict JSONB,
  ADD COLUMN IF NOT EXISTS thesis_version TEXT,
  ADD COLUMN IF NOT EXISTS originating_zone JSONB,
  ADD COLUMN IF NOT EXISTS confirmation_method TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS authorization_result JSONB;

UPDATE public.staged_setups
   SET candidate_id = gen_random_uuid()
 WHERE candidate_id IS NULL;

ALTER TABLE public.staged_setups
  ALTER COLUMN candidate_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN candidate_id SET NOT NULL;

ALTER TABLE public.staged_setups
  DROP CONSTRAINT IF EXISTS staged_setups_status_check;

ALTER TABLE public.staged_setups
  ADD CONSTRAINT staged_setups_status_check
  CHECK (
    status IN (
      'watching',
      'qualified',
      'pending',
      'awaiting_confirmation',
      'filled',
      'blocked_after_qualification',
      'invalidated',
      'expired',
      'cancelled',
      -- Historical rows may retain this old terminal label. Phase 4 code never
      -- creates it.
      'promoted'
    )
  );

ALTER TABLE public.staged_setups
  DROP CONSTRAINT IF EXISTS staged_setups_confirmation_method_check;

ALTER TABLE public.staged_setups
  ADD CONSTRAINT staged_setups_confirmation_method_check
  CHECK (
    confirmation_method IS NULL OR confirmation_method IN (
      'choch',
      'indicators',
      'choch_and_indicators'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_setups_candidate
  ON public.staged_setups (user_id, bot_id, candidate_id);

DROP INDEX IF EXISTS public.idx_staged_setups_unique_active;
CREATE UNIQUE INDEX idx_staged_setups_unique_active
  ON public.staged_setups (user_id, bot_id, symbol, direction)
  WHERE status IN (
    'watching',
    'qualified',
    'pending',
    'awaiting_confirmation'
  );

CREATE TABLE IF NOT EXISTS public.setup_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staged_setup_id UUID NOT NULL
    REFERENCES public.staged_setups(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_setup_lifecycle_events_setup
  ON public.setup_lifecycle_events (staged_setup_id, created_at);

CREATE INDEX IF NOT EXISTS idx_setup_lifecycle_events_candidate
  ON public.setup_lifecycle_events (user_id, bot_id, candidate_id, created_at);

ALTER TABLE public.setup_lifecycle_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own setup lifecycle events"
  ON public.setup_lifecycle_events;
CREATE POLICY "Users can view own setup lifecycle events"
  ON public.setup_lifecycle_events FOR SELECT
  USING (auth.uid() = user_id);

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
      jsonb_strip_nulls(jsonb_build_object(
        'lifecycleVersion', NEW.lifecycle_version,
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
  AFTER INSERT OR UPDATE OF status
  ON public.staged_setups
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_staged_setup_transition();

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
  evidence,
  created_at
)
SELECT
  setup.id,
  setup.candidate_id,
  setup.user_id,
  setup.bot_id,
  setup.symbol,
  setup.direction,
  NULL,
  setup.status,
  COALESCE(
    setup.lifecycle_reason,
    setup.invalidation_reason,
    setup.promotion_reason,
    'Lifecycle imported during Phase 4 migration'
  ),
  jsonb_build_object(
    'lifecycleVersion', setup.lifecycle_version,
    'historicalBackfill', true
  ),
  COALESCE(setup.created_at, now())
FROM public.staged_setups setup
WHERE NOT EXISTS (
  SELECT 1
  FROM public.setup_lifecycle_events event
  WHERE event.staged_setup_id = setup.id
);

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

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS candidate_id UUID,
  ADD COLUMN IF NOT EXISTS staged_setup_id UUID
    REFERENCES public.staged_setups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS originating_zone JSONB,
  ADD COLUMN IF NOT EXISTS thesis_version TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_method TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_config JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS candidate_id UUID,
  ADD COLUMN IF NOT EXISTS staged_setup_id UUID
    REFERENCES public.staged_setups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS originating_zone JSONB,
  ADD COLUMN IF NOT EXISTS thesis_version TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_method TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_config JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_status_check;
ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_orders_status_check
  CHECK (
    status IN (
      'pending',
      'awaiting_confirmation',
      'filled',
      'invalidated',
      'expired',
      'cancelled'
    )
  );

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_confirmation_method_check;
ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_orders_confirmation_method_check
  CHECK (
    confirmation_method IS NULL OR confirmation_method IN (
      'choch',
      'indicators',
      'choch_and_indicators'
    )
  );

DROP INDEX IF EXISTS public.idx_pending_orders_unique_active;
CREATE UNIQUE INDEX idx_pending_orders_unique_active
  ON public.pending_orders (user_id, bot_id, symbol, direction)
  WHERE status IN ('pending', 'awaiting_confirmation');

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_orders_candidate
  ON public.pending_orders (user_id, bot_id, candidate_id)
  WHERE candidate_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_positions_candidate_id
  ON public.paper_positions (user_id, bot_id, candidate_id)
  WHERE candidate_id IS NOT NULL;

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_watchlist_identity_required;
ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_watchlist_identity_required
  CHECK (
    NOT from_watchlist OR (
      staged_setup_id IS NOT NULL
      AND candidate_id IS NOT NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.populate_pending_lifecycle_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signal JSONB := COALESCE(NEW.signal_reason, '{}'::JSONB);
  v_lifecycle JSONB := COALESCE(
    v_signal->'watchlistLifecycle',
    '{}'::JSONB
  );
BEGIN
  NEW.staged_setup_id := COALESCE(
    NEW.staged_setup_id,
    NULLIF(v_lifecycle->>'setupId', '')::UUID
  );
  NEW.candidate_id := COALESCE(
    NEW.candidate_id,
    NULLIF(v_lifecycle->>'candidateId', '')::UUID,
    NULLIF(v_signal->>'candidateId', '')::UUID
  );
  NEW.originating_zone := COALESCE(
    NEW.originating_zone,
    v_lifecycle->'originatingZone',
    v_signal->'originatingZone'
  );
  NEW.thesis_version := COALESCE(
    NEW.thesis_version,
    v_lifecycle->>'thesisVersion',
    v_signal->>'thesisVersion'
  );
  NEW.confirmation_method := COALESCE(
    NEW.confirmation_method,
    v_lifecycle->>'confirmationMethod',
    v_signal->>'confirmationMethod'
  );
  NEW.confirmation_config := COALESCE(
    NULLIF(NEW.confirmation_config, '{}'::JSONB),
    v_lifecycle->'confirmationConfig',
    '{}'::JSONB
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_pending_lifecycle_context
  ON public.pending_orders;
CREATE TRIGGER populate_pending_lifecycle_context
  BEFORE INSERT OR UPDATE OF signal_reason
  ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_pending_lifecycle_context();

CREATE OR REPLACE FUNCTION public.populate_position_lifecycle_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signal JSONB := CASE
    WHEN NEW.signal_reason IS NULL OR NEW.signal_reason = '' THEN '{}'::JSONB
    ELSE NEW.signal_reason::JSONB
  END;
  v_lifecycle JSONB := COALESCE(
    v_signal->'watchlistLifecycle',
    '{}'::JSONB
  );
BEGIN
  NEW.staged_setup_id := COALESCE(
    NEW.staged_setup_id,
    NULLIF(v_lifecycle->>'setupId', '')::UUID
  );
  NEW.candidate_id := COALESCE(
    NEW.candidate_id,
    NULLIF(v_lifecycle->>'candidateId', '')::UUID,
    NULLIF(v_signal->>'candidateId', '')::UUID
  );
  NEW.originating_zone := COALESCE(
    NEW.originating_zone,
    v_lifecycle->'originatingZone',
    v_signal->'originatingZone'
  );
  NEW.thesis_version := COALESCE(
    NEW.thesis_version,
    v_lifecycle->>'thesisVersion',
    v_signal->>'thesisVersion'
  );
  NEW.confirmation_method := COALESCE(
    NEW.confirmation_method,
    v_lifecycle->>'confirmationMethod',
    v_signal->>'confirmationMethod'
  );
  NEW.confirmation_config := COALESCE(
    NULLIF(NEW.confirmation_config, '{}'::JSONB),
    v_lifecycle->'confirmationConfig',
    '{}'::JSONB
  );
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_position_lifecycle_context
  ON public.paper_positions;
CREATE TRIGGER populate_position_lifecycle_context
  BEFORE INSERT OR UPDATE OF signal_reason
  ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_position_lifecycle_context();

CREATE OR REPLACE FUNCTION public.sync_staged_setup_from_pending()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason TEXT;
BEGIN
  IF NEW.staged_setup_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_reason := COALESCE(
    NEW.fill_reason,
    NEW.cancel_reason,
    format('Pending order moved to %s', NEW.status)
  );

  UPDATE public.staged_setups
     SET status = NEW.status,
         lifecycle_reason = v_reason,
         pending_order_id = NEW.id,
         authorization_result = COALESCE(
           NEW.final_authorization,
           authorization_result
         ),
         originating_zone = COALESCE(
           NEW.originating_zone,
           originating_zone
         ),
         confirmation_method = COALESCE(
           NEW.confirmation_method,
           confirmation_method
         ),
         confirmation_config = COALESCE(
           NEW.confirmation_config,
           confirmation_config
         ),
         resolved_at = CASE
           WHEN NEW.status IN (
             'filled', 'invalidated', 'expired', 'cancelled'
           ) THEN COALESCE(resolved_at, now())
           ELSE NULL
         END,
         updated_at = now()
   WHERE id = NEW.staged_setup_id
     AND status IN (
       'qualified',
       'pending',
       'awaiting_confirmation'
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_staged_setup_from_pending
  ON public.pending_orders;
CREATE TRIGGER sync_staged_setup_from_pending
  AFTER INSERT OR UPDATE OF status, final_authorization
  ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_staged_setup_from_pending();

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
       'awaiting_confirmation'
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_staged_setup_from_position
  ON public.paper_positions;
CREATE TRIGGER sync_staged_setup_from_position
  AFTER INSERT
  ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_staged_setup_from_position();

REVOKE ALL ON FUNCTION public.audit_staged_setup_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.populate_pending_lifecycle_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.populate_position_lifecycle_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_staged_setup_from_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_staged_setup_from_position() FROM PUBLIC;

GRANT SELECT ON public.setup_lifecycle_events TO authenticated;
GRANT ALL ON public.setup_lifecycle_events TO service_role;
