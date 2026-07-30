-- Phase 8A — strategy validation and controlled activation.
--
-- This migration creates the control plane for moving one strategy component
-- through evidence-backed rollout stages. Nothing in the scanner reads this
-- registry yet, so applying it cannot change scoring, authorization, sizing,
-- order placement, position management or execution.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.strategy_activation_json_hash(p_value JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(COALESCE(p_value, '{}'::JSONB)::TEXT, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

CREATE TABLE IF NOT EXISTS public.strategy_activation_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  feature_key TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT 'default',
  activation_scope JSONB NOT NULL DEFAULT '{}'::JSONB,
  activation_scope_hash TEXT NOT NULL,
  authority_stage TEXT NOT NULL DEFAULT 'shadow'
    CHECK (authority_stage IN (
      'shadow',
      'log_only',
      'soft_adjustment',
      'hard_block'
    )),
  runtime_scope TEXT NOT NULL DEFAULT 'observation'
    CHECK (runtime_scope IN (
      'observation',
      'paper',
      'live_canary',
      'live'
    )),
  evidence_contract_version TEXT NOT NULL DEFAULT 'strategy-evidence.v1',
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  evidence_hash TEXT NOT NULL,
  evidence_window_start TIMESTAMPTZ,
  evidence_window_end TIMESTAMPTZ,
  transition_reason TEXT,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  runtime_enforced BOOLEAN NOT NULL DEFAULT false,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(feature_key) BETWEEN 1 AND 100),
  CHECK (length(variant_key) BETWEEN 1 AND 100),
  CHECK (evidence_window_end IS NULL OR evidence_window_start IS NULL
    OR evidence_window_end >= evidence_window_start),
  CHECK (runtime_enforced = false OR (
    authority_stage IN ('soft_adjustment', 'hard_block')
    AND runtime_scope IN ('paper', 'live_canary', 'live')
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_activation_identity
  ON public.strategy_activation_registry (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope_hash
  );

CREATE INDEX IF NOT EXISTS idx_strategy_activation_status
  ON public.strategy_activation_registry (
    user_id,
    bot_id,
    authority_stage,
    runtime_scope
  );

CREATE TABLE IF NOT EXISTS public.strategy_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activation_id UUID NOT NULL
    REFERENCES public.strategy_activation_registry(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  from_authority_stage TEXT,
  to_authority_stage TEXT NOT NULL,
  from_runtime_scope TEXT,
  to_runtime_scope TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL,
  evidence_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strategy_activation_events_history
  ON public.strategy_activation_events (activation_id, revision, created_at);

CREATE INDEX IF NOT EXISTS idx_strategy_activation_events_owner
  ON public.strategy_activation_events (
    user_id,
    bot_id,
    feature_key,
    created_at DESC
  );

CREATE OR REPLACE FUNCTION public.populate_strategy_activation_hashes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  NEW.activation_scope := COALESCE(NEW.activation_scope, '{}'::JSONB);
  NEW.evidence_snapshot := COALESCE(NEW.evidence_snapshot, '{}'::JSONB);
  NEW.activation_scope_hash :=
    public.strategy_activation_json_hash(NEW.activation_scope);
  NEW.evidence_hash :=
    public.strategy_activation_json_hash(NEW.evidence_snapshot);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_strategy_activation_hashes
  ON public.strategy_activation_registry;
CREATE TRIGGER populate_strategy_activation_hashes
  BEFORE INSERT OR UPDATE OF activation_scope, evidence_snapshot
  ON public.strategy_activation_registry
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_strategy_activation_hashes();

ALTER TABLE public.strategy_activation_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_activation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own strategy activation registry"
  ON public.strategy_activation_registry;
CREATE POLICY "Users can view own strategy activation registry"
  ON public.strategy_activation_registry
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own strategy activation events"
  ON public.strategy_activation_events;
CREATE POLICY "Users can view own strategy activation events"
  ON public.strategy_activation_events
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.transition_strategy_activation(
  p_user_id UUID,
  p_bot_id TEXT,
  p_feature_key TEXT,
  p_variant_key TEXT,
  p_activation_scope JSONB,
  p_to_authority_stage TEXT,
  p_to_runtime_scope TEXT,
  p_reason TEXT,
  p_evidence_snapshot JSONB,
  p_evidence_window_start TIMESTAMPTZ DEFAULT NULL,
  p_evidence_window_end TIMESTAMPTZ DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL,
  p_expected_revision INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_row public.strategy_activation_registry%ROWTYPE;
  v_scope JSONB := COALESCE(p_activation_scope, '{}'::JSONB);
  v_evidence JSONB := COALESCE(p_evidence_snapshot, '{}'::JSONB);
  v_scope_hash TEXT;
  v_from_stage_rank INTEGER;
  v_to_stage_rank INTEGER;
  v_from_scope_rank INTEGER;
  v_to_scope_rank INTEGER;
  v_resolved INTEGER;
  v_changed INTEGER;
  v_coverage NUMERIC;
  v_beneficial_rate NUMERIC;
  v_paper_resolved INTEGER;
  v_canary_resolved INTEGER;
  v_expectancy_delta NUMERIC;
  v_drawdown_delta NUMERIC;
  v_retention NUMERIC;
  v_is_rollback BOOLEAN := false;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(trim(COALESCE(p_bot_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_feature_key, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_variant_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Activation user, bot, feature and variant are required';
  END IF;
  IF p_to_authority_stage NOT IN (
    'shadow', 'log_only', 'soft_adjustment', 'hard_block'
  ) THEN
    RAISE EXCEPTION 'Invalid authority stage: %', p_to_authority_stage;
  END IF;
  IF p_to_runtime_scope NOT IN (
    'observation', 'paper', 'live_canary', 'live'
  ) THEN
    RAISE EXCEPTION 'Invalid runtime scope: %', p_to_runtime_scope;
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Every activation transition requires a reason';
  END IF;
  IF p_evidence_window_start IS NOT NULL
     AND p_evidence_window_end IS NOT NULL
     AND p_evidence_window_end < p_evidence_window_start THEN
    RAISE EXCEPTION 'Evidence window end must not precede its start';
  END IF;

  v_scope_hash := public.strategy_activation_json_hash(v_scope);

  INSERT INTO public.strategy_activation_registry (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope,
    activation_scope_hash,
    authority_stage,
    runtime_scope,
    evidence_snapshot,
    evidence_hash,
    transition_reason
  ) VALUES (
    p_user_id,
    trim(p_bot_id),
    trim(p_feature_key),
    trim(p_variant_key),
    v_scope,
    v_scope_hash,
    'shadow',
    'observation',
    '{}'::JSONB,
    public.strategy_activation_json_hash('{}'::JSONB),
    'Initialized in safe Shadow / Observation state'
  )
  ON CONFLICT (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope_hash
  ) DO NOTHING;

  SELECT *
    INTO v_row
    FROM public.strategy_activation_registry
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = trim(p_variant_key)
     AND activation_scope_hash = v_scope_hash
   FOR UPDATE;

  IF p_expected_revision IS NOT NULL
     AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION
      'Activation revision conflict: expected %, found %',
      p_expected_revision,
      v_row.revision;
  END IF;

  IF v_row.authority_stage = p_to_authority_stage
     AND v_row.runtime_scope = p_to_runtime_scope THEN
    RETURN jsonb_build_object(
      'changed', false,
      'code', 'already_at_requested_state',
      'row', to_jsonb(v_row)
    );
  END IF;

  v_from_stage_rank := CASE v_row.authority_stage
    WHEN 'shadow' THEN 0
    WHEN 'log_only' THEN 1
    WHEN 'soft_adjustment' THEN 2
    WHEN 'hard_block' THEN 3
  END;
  v_to_stage_rank := CASE p_to_authority_stage
    WHEN 'shadow' THEN 0
    WHEN 'log_only' THEN 1
    WHEN 'soft_adjustment' THEN 2
    WHEN 'hard_block' THEN 3
  END;
  v_from_scope_rank := CASE v_row.runtime_scope
    WHEN 'observation' THEN 0
    WHEN 'paper' THEN 1
    WHEN 'live_canary' THEN 2
    WHEN 'live' THEN 3
  END;
  v_to_scope_rank := CASE p_to_runtime_scope
    WHEN 'observation' THEN 0
    WHEN 'paper' THEN 1
    WHEN 'live_canary' THEN 2
    WHEN 'live' THEN 3
  END;

  v_is_rollback :=
    v_to_stage_rank < v_from_stage_rank
    OR v_to_scope_rank < v_from_scope_rank;

  IF v_is_rollback THEN
    IF p_to_authority_stage <> 'shadow'
       OR p_to_runtime_scope <> 'observation' THEN
      RAISE EXCEPTION
        'Rollback must return directly to Shadow / Observation';
    END IF;
  ELSE
    IF (
      (v_to_stage_rank - v_from_stage_rank)
      + (v_to_scope_rank - v_from_scope_rank)
    ) <> 1 THEN
      RAISE EXCEPTION
        'Forward activation must advance exactly one stage or one runtime scope';
    END IF;

    v_resolved := COALESCE(
      NULLIF(v_evidence#>>'{sample,resolved}', '')::INTEGER,
      0
    );
    v_changed := COALESCE(
      NULLIF(v_evidence#>>'{sample,changed}', '')::INTEGER,
      0
    );
    v_coverage := COALESCE(
      NULLIF(v_evidence#>>'{sample,coveragePercent}', '')::NUMERIC,
      0
    );
    v_beneficial_rate := COALESCE(
      NULLIF(v_evidence#>>'{effect,beneficialRatePercent}', '')::NUMERIC,
      0
    );
    v_paper_resolved := COALESCE(
      NULLIF(v_evidence#>>'{sample,paperResolved}', '')::INTEGER,
      0
    );
    v_canary_resolved := COALESCE(
      NULLIF(v_evidence#>>'{sample,liveCanaryResolved}', '')::INTEGER,
      0
    );
    v_expectancy_delta := COALESCE(
      NULLIF(v_evidence#>>'{effect,expectancyDeltaR}', '')::NUMERIC,
      0
    );
    v_drawdown_delta := COALESCE(
      NULLIF(v_evidence#>>'{effect,maxDrawdownDeltaPercent}', '')::NUMERIC,
      0
    );
    v_retention := COALESCE(
      NULLIF(v_evidence#>>'{effect,goodTradeRetentionPercent}', '')::NUMERIC,
      0
    );

    IF v_row.authority_stage = 'shadow'
       AND p_to_authority_stage = 'log_only'
       AND (
         v_resolved < 30
         OR v_changed < 10
         OR v_coverage < 50
         OR v_beneficial_rate < 60
         OR COALESCE((v_evidence#>>'{validation,outOfSample}')::BOOLEAN, false) = false
         OR COALESCE((v_evidence#>>'{validation,walkForwardConsistent}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Log-only promotion requires 30 resolved, 10 changed, 50%% coverage, 60%% useful, out-of-sample and walk-forward evidence';
    END IF;

    IF v_row.runtime_scope = 'observation'
       AND p_to_runtime_scope = 'paper'
       AND (
         v_row.authority_stage <> 'log_only'
         OR COALESCE((v_evidence#>>'{approval,userConfirmed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Paper scope requires Log-only authority and explicit user approval';
    END IF;

    IF v_row.authority_stage = 'log_only'
       AND p_to_authority_stage = 'soft_adjustment'
       AND (
         v_row.runtime_scope <> 'paper'
         OR v_paper_resolved < 30
         OR v_expectancy_delta <= 0
         OR v_drawdown_delta > 0
         OR v_retention < 70
         OR COALESCE((v_evidence#>>'{validation,paperForwardPassed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Soft adjustment requires positive 30-sample paper-forward evidence without worse drawdown';
    END IF;

    IF v_row.runtime_scope = 'paper'
       AND p_to_runtime_scope = 'live_canary'
       AND (
         v_row.authority_stage <> 'soft_adjustment'
         OR v_paper_resolved < 30
         OR v_expectancy_delta <= 0
         OR COALESCE((v_evidence#>>'{approval,userConfirmed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Live canary requires proven soft adjustment in paper and explicit user approval';
    END IF;

    IF v_row.authority_stage = 'soft_adjustment'
       AND p_to_authority_stage = 'hard_block'
       AND (
         v_row.runtime_scope <> 'live_canary'
         OR v_canary_resolved < 20
         OR v_expectancy_delta <= 0
         OR v_drawdown_delta > 0
         OR v_retention < 70
         OR COALESCE((v_evidence#>>'{validation,liveCanaryPassed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Hard block requires positive 20-sample live-canary evidence without worse drawdown';
    END IF;

    IF v_row.runtime_scope = 'live_canary'
       AND p_to_runtime_scope = 'live'
       AND (
         v_row.authority_stage <> 'hard_block'
         OR v_canary_resolved < 20
         OR COALESCE((v_evidence#>>'{approval,userConfirmed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Full live scope requires canary-tested Hard-block authority and explicit user approval';
    END IF;
  END IF;

  UPDATE public.strategy_activation_registry
     SET authority_stage = p_to_authority_stage,
         runtime_scope = p_to_runtime_scope,
         evidence_snapshot = v_evidence,
         evidence_hash = public.strategy_activation_json_hash(v_evidence),
         evidence_window_start = p_evidence_window_start,
         evidence_window_end = p_evidence_window_end,
         transition_reason = trim(p_reason),
         approved_by = p_actor_id,
         approved_at = now(),
         runtime_enforced = false,
         revision = revision + 1,
         updated_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.strategy_activation_events (
    activation_id,
    user_id,
    bot_id,
    feature_key,
    variant_key,
    from_authority_stage,
    to_authority_stage,
    from_runtime_scope,
    to_runtime_scope,
    evidence_contract_version,
    evidence_snapshot,
    evidence_hash,
    reason,
    actor_id,
    revision
  ) VALUES (
    v_row.id,
    v_row.user_id,
    v_row.bot_id,
    v_row.feature_key,
    v_row.variant_key,
    CASE v_from_stage_rank
      WHEN 0 THEN 'shadow'
      WHEN 1 THEN 'log_only'
      WHEN 2 THEN 'soft_adjustment'
      WHEN 3 THEN 'hard_block'
    END,
    v_row.authority_stage,
    CASE v_from_scope_rank
      WHEN 0 THEN 'observation'
      WHEN 1 THEN 'paper'
      WHEN 2 THEN 'live_canary'
      WHEN 3 THEN 'live'
    END,
    v_row.runtime_scope,
    v_row.evidence_contract_version,
    v_row.evidence_snapshot,
    v_row.evidence_hash,
    trim(p_reason),
    p_actor_id,
    v_row.revision
  );

  RETURN jsonb_build_object(
    'changed', true,
    'code', CASE WHEN v_is_rollback THEN 'rolled_back' ELSE 'transitioned' END,
    'runtimeEnforced', false,
    'row', to_jsonb(v_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.strategy_activation_json_hash(JSONB)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_strategy_activation(
  UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, JSONB,
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER
) FROM PUBLIC;

GRANT SELECT ON public.strategy_activation_registry TO authenticated;
GRANT SELECT ON public.strategy_activation_events TO authenticated;
GRANT ALL ON public.strategy_activation_registry TO service_role;
GRANT ALL ON public.strategy_activation_events TO service_role;
GRANT EXECUTE ON FUNCTION public.strategy_activation_json_hash(JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_strategy_activation(
  UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, JSONB,
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER
) TO service_role;

COMMENT ON TABLE public.strategy_activation_registry IS
  'Phase 8 control plane. Records evidence-backed rollout state; not consumed by runtime execution until a later guarded wiring phase.';
COMMENT ON COLUMN public.strategy_activation_registry.runtime_enforced IS
  'False throughout Phase 8A. A later migration must explicitly wire and enable runtime enforcement.';
COMMENT ON TABLE public.strategy_activation_events IS
  'Append-only evidence certificate history for strategy rollout and rollback decisions.';
