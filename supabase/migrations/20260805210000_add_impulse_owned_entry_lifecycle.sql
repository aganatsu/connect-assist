-- One frozen impulse owns an ordered set of replaceable entry-zone candidates.
-- This migration is observation-first: existing execution paths are unchanged
-- until a user's effective lifecycle mode is explicitly set to enforce.

CREATE TABLE IF NOT EXISTS public.impulse_entry_lifecycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  setup_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  impulse_id TEXT NOT NULL,
  impulse_timeframe TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'observe' CHECK (mode IN ('off', 'observe', 'enforce')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'entered', 'invalidated', 'expired', 'exhausted')
  ),
  active_candidate_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  lifecycle JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT impulse_entry_lifecycle_setup_unique UNIQUE (user_id, bot_id, setup_id),
  CONSTRAINT impulse_entry_lifecycle_contract_valid CHECK (
    lifecycle ->> 'contractVersion' = 'impulse-entry-lifecycle.v1'
    AND lifecycle ->> 'mode' = mode
    AND lifecycle #>> '{impulse,id}' = impulse_id
    AND lifecycle #>> '{impulse,direction}' = direction
    AND lifecycle #>> '{impulse,timeframe}' = impulse_timeframe
    AND lifecycle ->> 'status' = status
    AND (lifecycle ->> 'revision')::INTEGER = revision
    AND COALESCE(lifecycle ->> 'activeCandidateId', '') = COALESCE(active_candidate_id, '')
  )
);

CREATE TABLE IF NOT EXISTS public.impulse_entry_lifecycle_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES public.impulse_entry_lifecycles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_revision INTEGER NOT NULL,
  to_revision INTEGER NOT NULL CHECK (to_revision = from_revision + 1),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'zone_touched', 'candidate_failed', 'trigger_locked',
    'confirmation_passed', 'impulse_invalidated', 'expired'
  )),
  from_candidate_id TEXT,
  to_candidate_id TEXT,
  reason TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  lifecycle_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT impulse_entry_transition_revision_unique UNIQUE (lifecycle_id, to_revision),
  CONSTRAINT impulse_entry_transition_snapshot_valid CHECK (
    lifecycle_snapshot ->> 'contractVersion' = 'impulse-entry-lifecycle.v1'
    AND (lifecycle_snapshot ->> 'revision')::INTEGER = to_revision
  )
);

CREATE INDEX IF NOT EXISTS idx_impulse_entry_lifecycle_monitor
  ON public.impulse_entry_lifecycles (user_id, bot_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_impulse_entry_lifecycle_impulse
  ON public.impulse_entry_lifecycles (user_id, bot_id, symbol, impulse_id);
CREATE INDEX IF NOT EXISTS idx_impulse_entry_transition_history
  ON public.impulse_entry_lifecycle_transitions (lifecycle_id, to_revision);

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS impulse_entry_lifecycle_id UUID
    REFERENCES public.impulse_entry_lifecycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS impulse_entry_lifecycle JSONB
    GENERATED ALWAYS AS (frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}') STORED;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS impulse_entry_lifecycle_id UUID
    REFERENCES public.impulse_entry_lifecycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS impulse_entry_lifecycle JSONB
    GENERATED ALWAYS AS (frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}') STORED;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS impulse_entry_lifecycle_id UUID
    REFERENCES public.impulse_entry_lifecycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS impulse_entry_lifecycle JSONB
    GENERATED ALWAYS AS (frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}') STORED;

ALTER TABLE public.staged_setups DROP CONSTRAINT IF EXISTS staged_impulse_entry_lifecycle_valid;
ALTER TABLE public.staged_setups ADD CONSTRAINT staged_impulse_entry_lifecycle_valid CHECK (
  impulse_entry_lifecycle IS NULL OR
  impulse_entry_lifecycle ->> 'contractVersion' = 'impulse-entry-lifecycle.v1'
);
ALTER TABLE public.pending_orders DROP CONSTRAINT IF EXISTS pending_impulse_entry_lifecycle_valid;
ALTER TABLE public.pending_orders ADD CONSTRAINT pending_impulse_entry_lifecycle_valid CHECK (
  impulse_entry_lifecycle IS NULL OR
  impulse_entry_lifecycle ->> 'contractVersion' = 'impulse-entry-lifecycle.v1'
);
ALTER TABLE public.paper_positions DROP CONSTRAINT IF EXISTS position_impulse_entry_lifecycle_valid;
ALTER TABLE public.paper_positions ADD CONSTRAINT position_impulse_entry_lifecycle_valid CHECK (
  impulse_entry_lifecycle IS NULL OR
  impulse_entry_lifecycle ->> 'contractVersion' = 'impulse-entry-lifecycle.v1'
);

CREATE OR REPLACE FUNCTION public.attach_impulse_entry_lifecycle()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lifecycle JSONB;
  v_id UUID;
  v_created BOOLEAN := false;
  v_setup_id TEXT;
BEGIN
  v_lifecycle := NEW.frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}';
  IF v_lifecycle IS NULL OR v_lifecycle ->> 'mode' = 'off' THEN RETURN NEW; END IF;
  v_setup_id := NEW.frozen_strategy_context ->> 'setupId';
  IF v_setup_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.impulse_entry_lifecycles (
    user_id, bot_id, setup_id, symbol, direction, impulse_id, impulse_timeframe,
    mode, status, active_candidate_id, revision, lifecycle
  ) VALUES (
    NEW.user_id, COALESCE(NEW.bot_id, 'smc'), v_setup_id, NEW.symbol, NEW.direction,
    v_lifecycle #>> '{impulse,id}', v_lifecycle #>> '{impulse,timeframe}',
    v_lifecycle ->> 'mode', v_lifecycle ->> 'status',
    v_lifecycle ->> 'activeCandidateId',
    (v_lifecycle ->> 'revision')::INTEGER, v_lifecycle
  ) ON CONFLICT (user_id, bot_id, setup_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    v_created := true;
  ELSE
    SELECT id INTO v_id FROM public.impulse_entry_lifecycles
      WHERE user_id = NEW.user_id AND bot_id = COALESCE(NEW.bot_id, 'smc')
        AND setup_id = v_setup_id;
  END IF;
  NEW.impulse_entry_lifecycle_id := v_id;
  IF v_created THEN
    INSERT INTO public.impulse_entry_lifecycle_transitions (
      lifecycle_id, user_id, from_revision, to_revision, event_type,
      to_candidate_id, reason, lifecycle_snapshot
    ) VALUES (
      v_id, NEW.user_id, 0, 1, 'created',
      v_lifecycle ->> 'activeCandidateId',
      COALESCE(v_lifecycle ->> 'lastTransitionReason', 'Lifecycle created'),
      v_lifecycle
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attach_impulse_entry_lifecycle ON public.staged_setups;
CREATE TRIGGER attach_impulse_entry_lifecycle
  BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.staged_setups
  FOR EACH ROW EXECUTE FUNCTION public.attach_impulse_entry_lifecycle();
DROP TRIGGER IF EXISTS attach_impulse_entry_lifecycle ON public.pending_orders;
CREATE TRIGGER attach_impulse_entry_lifecycle
  BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.attach_impulse_entry_lifecycle();
DROP TRIGGER IF EXISTS attach_impulse_entry_lifecycle ON public.paper_positions;
CREATE TRIGGER attach_impulse_entry_lifecycle
  BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.attach_impulse_entry_lifecycle();

CREATE OR REPLACE FUNCTION public.advance_impulse_entry_lifecycle(
  p_lifecycle_id UUID,
  p_expected_revision INTEGER,
  p_event_type TEXT,
  p_reason TEXT,
  p_event_payload JSONB,
  p_next_lifecycle JSONB
) RETURNS public.impulse_entry_lifecycles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_current public.impulse_entry_lifecycles;
  v_updated public.impulse_entry_lifecycles;
  v_next_revision INTEGER;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  SELECT * INTO v_current FROM public.impulse_entry_lifecycles
    WHERE id = p_lifecycle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle not found'; END IF;
  IF v_current.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale lifecycle revision: expected %, current %',
      p_expected_revision, v_current.revision;
  END IF;
  v_next_revision := p_expected_revision + 1;
  IF p_next_lifecycle ->> 'contractVersion' <> 'impulse-entry-lifecycle.v1'
    OR (p_next_lifecycle ->> 'revision')::INTEGER <> v_next_revision
    OR p_next_lifecycle #>> '{impulse,id}' <> v_current.impulse_id
    OR p_next_lifecycle #>> '{impulse,direction}' <> v_current.direction THEN
    RAISE EXCEPTION 'invalid next lifecycle contract';
  END IF;

  UPDATE public.impulse_entry_lifecycles SET
    mode = p_next_lifecycle ->> 'mode',
    status = p_next_lifecycle ->> 'status',
    active_candidate_id = p_next_lifecycle ->> 'activeCandidateId',
    revision = v_next_revision,
    lifecycle = p_next_lifecycle,
    updated_at = now()
  WHERE id = p_lifecycle_id RETURNING * INTO v_updated;

  INSERT INTO public.impulse_entry_lifecycle_transitions (
    lifecycle_id, user_id, from_revision, to_revision, event_type,
    from_candidate_id, to_candidate_id, reason, event_payload, lifecycle_snapshot
  ) VALUES (
    v_current.id, v_current.user_id, p_expected_revision, v_next_revision,
    p_event_type, v_current.active_candidate_id, v_updated.active_candidate_id,
    p_reason, COALESCE(p_event_payload, '{}'::JSONB), p_next_lifecycle
  );
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_impulse_entry_lifecycle(UUID, INTEGER, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_impulse_entry_lifecycle(UUID, INTEGER, TEXT, TEXT, JSONB, JSONB)
  TO service_role;

ALTER TABLE public.impulse_entry_lifecycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impulse_entry_lifecycle_transitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own impulse entry lifecycles" ON public.impulse_entry_lifecycles;
CREATE POLICY "Users read own impulse entry lifecycles"
  ON public.impulse_entry_lifecycles FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages impulse entry lifecycles" ON public.impulse_entry_lifecycles;
CREATE POLICY "Service manages impulse entry lifecycles"
  ON public.impulse_entry_lifecycles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Users read own impulse entry transitions" ON public.impulse_entry_lifecycle_transitions;
CREATE POLICY "Users read own impulse entry transitions"
  ON public.impulse_entry_lifecycle_transitions FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages impulse entry transitions" ON public.impulse_entry_lifecycle_transitions;
CREATE POLICY "Service manages impulse entry transitions"
  ON public.impulse_entry_lifecycle_transitions FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON public.impulse_entry_lifecycles,
  public.impulse_entry_lifecycle_transitions TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.impulse_entry_lifecycles,
  public.impulse_entry_lifecycle_transitions TO service_role;

COMMENT ON TABLE public.impulse_entry_lifecycles IS
  'Frozen impulse authority with ordered, replaceable entry zones and one confirmation contract per active candidate.';
