-- Corrective Phase 2C / 3C, slice 1.1:
-- Separate the comparable global/base style fingerprint from the exact
-- pair-specific execution fingerprint.

ALTER TABLE public.active_game_plans
  ADD COLUMN IF NOT EXISTS style_base_policy_hash TEXT;

ALTER TABLE public.active_direction_verdicts
  ADD COLUMN IF NOT EXISTS style_base_policy_hash TEXT;

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS style_base_policy_hash TEXT;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS style_base_policy_hash TEXT;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS style_base_policy_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_active_game_plans_style_base_policy
  ON public.active_game_plans (user_id, bot_id, style_base_policy_hash)
  WHERE style_base_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_active_direction_verdicts_style_base_policy
  ON public.active_direction_verdicts
    (user_id, bot_id, style_base_policy_hash)
  WHERE style_base_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staged_setups_style_base_policy
  ON public.staged_setups (user_id, bot_id, style_base_policy_hash)
  WHERE style_base_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_orders_style_base_policy
  ON public.pending_orders (user_id, bot_id, style_base_policy_hash)
  WHERE style_base_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paper_positions_style_base_policy
  ON public.paper_positions (user_id, bot_id, style_base_policy_hash)
  WHERE style_base_policy_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.populate_execution_style_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_signal JSONB;
  v_policy JSONB;
BEGIN
  v_signal := CASE
    WHEN v_row->'signal_reason' IS NULL THEN NULL
    WHEN jsonb_typeof(v_row->'signal_reason') = 'object'
      THEN v_row->'signal_reason'
    WHEN jsonb_typeof(v_row->'signal_reason') = 'string'
      AND left(ltrim(v_row#>>'{signal_reason}'), 1) IN ('{', '[')
      THEN (v_row#>>'{signal_reason}')::JSONB
    ELSE NULL
  END;

  v_policy := COALESCE(
    v_row->'decision_context'->'stylePolicy',
    v_row->'final_authorization'->'decisionContext'->'stylePolicy',
    v_signal->'decisionContext'->'stylePolicy',
    v_signal->'stylePolicy',
    v_row->'authorization_result'->'stylePolicy',
    v_row->'style_policy'
  );

  IF v_policy IS NULL OR jsonb_typeof(v_policy) <> 'object' THEN
    RETURN NEW;
  END IF;

  NEW.style_policy := v_policy;
  NEW.style_policy_version := NULLIF(
    v_policy->>'contractVersion',
    ''
  );
  NEW.style_base_policy_hash := NULLIF(
    v_policy->>'basePolicyHash',
    ''
  );
  NEW.style_policy_hash := NULLIF(v_policy->>'policyHash', '');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.populate_strategy_style_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_policy JSONB;
BEGIN
  v_policy := COALESCE(
    v_row->'config_snapshot'->'stylePolicy',
    v_row->'verdict_json'->'stylePolicy',
    v_row->'style_policy'
  );

  IF v_policy IS NULL OR jsonb_typeof(v_policy) <> 'object' THEN
    RETURN NEW;
  END IF;

  NEW.style_policy := v_policy;
  NEW.style_policy_version := NULLIF(
    v_policy->>'contractVersion',
    ''
  );
  NEW.style_base_policy_hash := NULLIF(
    v_policy->>'basePolicyHash',
    ''
  );
  NEW.style_policy_hash := NULLIF(v_policy->>'policyHash', '');
  RETURN NEW;
END;
$$;

-- Only policy snapshots created by v1.1 or later contain a truthful base hash.
-- Older pair-specific hashes cannot be safely reverse-engineered in SQL.
UPDATE public.active_game_plans
   SET style_base_policy_hash = style_policy->>'basePolicyHash'
 WHERE style_base_policy_hash IS NULL
   AND NULLIF(style_policy->>'basePolicyHash', '') IS NOT NULL;

UPDATE public.active_direction_verdicts
   SET style_base_policy_hash = style_policy->>'basePolicyHash'
 WHERE style_base_policy_hash IS NULL
   AND NULLIF(style_policy->>'basePolicyHash', '') IS NOT NULL;

UPDATE public.staged_setups
   SET style_base_policy_hash = style_policy->>'basePolicyHash'
 WHERE style_base_policy_hash IS NULL
   AND NULLIF(style_policy->>'basePolicyHash', '') IS NOT NULL;

UPDATE public.pending_orders
   SET style_base_policy_hash = style_policy->>'basePolicyHash'
 WHERE style_base_policy_hash IS NULL
   AND NULLIF(style_policy->>'basePolicyHash', '') IS NOT NULL;

UPDATE public.paper_positions
   SET style_base_policy_hash = style_policy->>'basePolicyHash'
 WHERE style_base_policy_hash IS NULL
   AND NULLIF(style_policy->>'basePolicyHash', '') IS NOT NULL;
