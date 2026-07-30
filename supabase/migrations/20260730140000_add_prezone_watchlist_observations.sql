-- Slice 7.1 — expose viable pre-zone candidates without weakening execution.
--
-- A pre-zone row is observation-only. It cannot be converted in place or
-- referenced by a pending order/position. When a complete zone appears, the
-- scanner resolves it and creates a fresh execution-eligible candidate with a
-- new frozen strategy context.

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS execution_eligible BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS observation_parent_id UUID
    REFERENCES public.staged_setups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS observation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_staged_setups_observation_parent
  ON public.staged_setups (observation_parent_id)
  WHERE observation_parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staged_setups_execution_visibility
  ON public.staged_setups (
    user_id,
    bot_id,
    execution_eligible,
    status
  );

ALTER TABLE public.staged_setups
  DROP CONSTRAINT IF EXISTS staged_prezone_observation_shape;
ALTER TABLE public.staged_setups
  ADD CONSTRAINT staged_prezone_observation_shape
  CHECK (
    execution_eligible OR
    setup_type = 'waiting_for_unified_zone'
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.protect_prezone_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.execution_eligible = false
     AND NEW.execution_eligible = true THEN
    RAISE EXCEPTION
      'pre-zone observation % cannot become execution eligible; create a fresh candidate',
      OLD.id;
  END IF;

  IF NEW.execution_eligible = false
     AND NEW.setup_type IS DISTINCT FROM 'waiting_for_unified_zone' THEN
    RAISE EXCEPTION
      'non-executable staged setup must use waiting_for_unified_zone';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_protect_prezone_observation
  ON public.staged_setups;
CREATE TRIGGER zz_protect_prezone_observation
  BEFORE INSERT OR UPDATE OF execution_eligible, setup_type
  ON public.staged_setups
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_prezone_observation();

CREATE OR REPLACE FUNCTION public.guard_prezone_observation_execution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_signal JSONB := '{}'::JSONB;
  v_staged_id UUID;
  v_candidate_id UUID;
  v_observation_id UUID;
BEGIN
  BEGIN
    v_signal := CASE
      WHEN v_row->'signal_reason' IS NULL THEN '{}'::JSONB
      WHEN jsonb_typeof(v_row->'signal_reason') = 'object'
        THEN v_row->'signal_reason'
      WHEN jsonb_typeof(v_row->'signal_reason') = 'string'
        AND left(ltrim(v_row#>>'{signal_reason}'), 1) = '{'
        THEN (v_row#>>'{signal_reason}')::JSONB
      ELSE '{}'::JSONB
    END;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_signal := '{}'::JSONB;
  END;

  BEGIN
    v_staged_id := COALESCE(
      NULLIF(v_row->>'staged_setup_id', '')::UUID,
      NULLIF(v_signal#>>'{watchlistLifecycle,setupId}', '')::UUID
    );
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_staged_id := NULL;
  END;

  BEGIN
    v_candidate_id := COALESCE(
      NULLIF(v_row->>'candidate_id', '')::UUID,
      NULLIF(v_signal#>>'{watchlistLifecycle,candidateId}', '')::UUID,
      NULLIF(v_signal->>'candidateId', '')::UUID
    );
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_candidate_id := NULL;
  END;

  SELECT setup.id
    INTO v_observation_id
    FROM public.staged_setups AS setup
   WHERE setup.user_id = NEW.user_id
     AND setup.bot_id = NEW.bot_id
     AND setup.execution_eligible = false
     AND (
       (v_staged_id IS NOT NULL AND setup.id = v_staged_id)
       OR (
         v_candidate_id IS NOT NULL
         AND setup.candidate_id = v_candidate_id
       )
     )
   LIMIT 1;

  IF v_observation_id IS NOT NULL THEN
    RAISE EXCEPTION
      'pre-zone observation % cannot create an order or position',
      v_observation_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzz_guard_pending_prezone_execution
  ON public.pending_orders;
CREATE TRIGGER zzz_guard_pending_prezone_execution
  BEFORE INSERT OR UPDATE OF
    staged_setup_id,
    candidate_id,
    signal_reason
  ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_prezone_observation_execution();

DROP TRIGGER IF EXISTS zzz_guard_position_prezone_execution
  ON public.paper_positions;
CREATE TRIGGER zzz_guard_position_prezone_execution
  BEFORE INSERT OR UPDATE OF
    staged_setup_id,
    candidate_id,
    signal_reason
  ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_prezone_observation_execution();

REVOKE ALL ON FUNCTION public.protect_prezone_observation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_prezone_observation_execution()
  FROM PUBLIC;

COMMENT ON COLUMN public.staged_setups.execution_eligible IS
  'False for observation-only pre-zone candidates. Such a row can never authorize execution.';
COMMENT ON COLUMN public.staged_setups.observation_parent_id IS
  'The resolved observation that preceded this fresh frozen candidate.';
COMMENT ON COLUMN public.staged_setups.observation_reason IS
  'Why the candidate is visible while remaining ineligible for execution.';
