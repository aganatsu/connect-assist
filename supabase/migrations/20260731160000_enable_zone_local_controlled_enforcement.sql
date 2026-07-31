-- Phase 5 — controlled runtime activation for evidence-backed strategy policy.
--
-- Bot Config may request Observe / Soft / Hard, but runtime code only honors a
-- mode at or below an evidence-approved activation registry row. This RPC is
-- the explicit final switch for that registry row. It cannot promote stages.

CREATE OR REPLACE FUNCTION public.set_strategy_runtime_enforcement(
  p_user_id UUID,
  p_bot_id TEXT,
  p_feature_key TEXT,
  p_variant_key TEXT,
  p_activation_scope JSONB,
  p_enabled BOOLEAN,
  p_reason TEXT,
  p_actor_id UUID DEFAULT NULL,
  p_expected_revision INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_scope JSONB := COALESCE(p_activation_scope, '{}'::JSONB);
  v_scope_hash TEXT;
  v_row public.strategy_activation_registry%ROWTYPE;
  v_previous_enforced BOOLEAN;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(trim(COALESCE(p_bot_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_feature_key, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_variant_key, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION
      'User, bot, feature, variant and reason are required';
  END IF;

  v_scope_hash := public.strategy_activation_json_hash(v_scope);
  SELECT *
    INTO v_row
    FROM public.strategy_activation_registry
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = trim(p_variant_key)
     AND activation_scope_hash = v_scope_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Strategy activation record does not exist';
  END IF;
  IF p_expected_revision IS NOT NULL
     AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION
      'Activation revision conflict: expected %, found %',
      p_expected_revision,
      v_row.revision;
  END IF;
  IF p_enabled AND (
    v_row.authority_stage NOT IN ('soft_adjustment', 'hard_block')
    OR v_row.runtime_scope NOT IN ('paper', 'live_canary', 'live')
    OR v_row.approved_at IS NULL
    OR v_row.approved_by IS NULL
    OR v_row.evidence_window_start IS NULL
    OR v_row.evidence_window_end IS NULL
    OR v_row.evidence_snapshot = '{}'::JSONB
  ) THEN
    RAISE EXCEPTION
      'Runtime enforcement requires approved Soft/Hard authority, paper-or-later scope and a dated evidence snapshot';
  END IF;

  v_previous_enforced := v_row.runtime_enforced;
  IF v_previous_enforced = p_enabled THEN
    RETURN jsonb_build_object(
      'changed', false,
      'code', 'already_at_requested_runtime_state',
      'row', to_jsonb(v_row)
    );
  END IF;

  UPDATE public.strategy_activation_registry
     SET runtime_enforced = p_enabled,
         transition_reason = trim(p_reason),
         approved_by = COALESCE(p_actor_id, approved_by),
         approved_at = CASE
           WHEN p_enabled THEN COALESCE(approved_at, now())
           ELSE approved_at
         END,
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
    v_row.authority_stage,
    v_row.authority_stage,
    v_row.runtime_scope,
    v_row.runtime_scope,
    v_row.evidence_contract_version,
    v_row.evidence_snapshot,
    v_row.evidence_hash,
    trim(p_reason) || CASE
      WHEN p_enabled THEN ' [runtime enabled]'
      ELSE ' [runtime disabled]'
    END,
    p_actor_id,
    v_row.revision
  );

  RETURN jsonb_build_object(
    'changed', true,
    'code', CASE
      WHEN p_enabled THEN 'runtime_enabled'
      ELSE 'runtime_disabled'
    END,
    'row', to_jsonb(v_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) IS
  'Explicitly enables or disables a previously evidence-approved runtime authority. Never promotes authority stage or runtime scope.';
