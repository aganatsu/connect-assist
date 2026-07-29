-- Corrective Phase 2C / 3C, slice 1:
-- Persist the resolved trading-style policy as observe-only evidence.
-- All columns are nullable so legacy rows remain valid and no authorization,
-- sizing, lifecycle or management behavior changes in this migration.

ALTER TABLE public.active_game_plans
  ADD COLUMN IF NOT EXISTS style_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS style_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS style_policy JSONB;

ALTER TABLE public.active_direction_verdicts
  ADD COLUMN IF NOT EXISTS style_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS style_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS style_policy JSONB;

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS style_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS style_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS style_policy JSONB;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS style_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS style_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS style_policy JSONB;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS style_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS style_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS style_policy JSONB;

CREATE INDEX IF NOT EXISTS idx_active_game_plans_style_policy
  ON public.active_game_plans (user_id, bot_id, style_policy_hash)
  WHERE style_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_active_direction_verdicts_style_policy
  ON public.active_direction_verdicts (user_id, bot_id, style_policy_hash)
  WHERE style_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staged_setups_style_policy
  ON public.staged_setups (user_id, bot_id, style_policy_hash)
  WHERE style_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_orders_style_policy
  ON public.pending_orders (user_id, bot_id, style_policy_hash)
  WHERE style_policy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paper_positions_style_policy
  ON public.paper_positions (user_id, bot_id, style_policy_hash)
  WHERE style_policy_hash IS NOT NULL;

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
  NEW.style_policy_hash := NULLIF(v_policy->>'policyHash', '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_staged_setup_style_policy
  ON public.staged_setups;
CREATE TRIGGER populate_staged_setup_style_policy
  BEFORE INSERT OR UPDATE OF authorization_result, style_policy
  ON public.staged_setups
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_execution_style_policy();

DROP TRIGGER IF EXISTS populate_pending_order_style_policy
  ON public.pending_orders;
CREATE TRIGGER populate_pending_order_style_policy
  BEFORE INSERT OR UPDATE OF
    signal_reason,
    final_authorization,
    decision_context,
    style_policy
  ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_execution_style_policy();

DROP TRIGGER IF EXISTS populate_position_style_policy
  ON public.paper_positions;
CREATE TRIGGER populate_position_style_policy
  BEFORE INSERT OR UPDATE OF
    final_authorization,
    decision_context,
    style_policy
  ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_execution_style_policy();

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
  NEW.style_policy_hash := NULLIF(v_policy->>'policyHash', '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_game_plan_style_policy
  ON public.active_game_plans;
CREATE TRIGGER populate_game_plan_style_policy
  BEFORE INSERT OR UPDATE OF config_snapshot, style_policy
  ON public.active_game_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_strategy_style_policy();

DROP TRIGGER IF EXISTS populate_direction_verdict_style_policy
  ON public.active_direction_verdicts;
CREATE TRIGGER populate_direction_verdict_style_policy
  BEFORE INSERT OR UPDATE OF verdict_json, style_policy
  ON public.active_direction_verdicts
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_strategy_style_policy();

-- Backfill only rows that already contain policy evidence. Historical records
-- without a policy snapshot remain NULL instead of receiving invented data.
UPDATE public.active_game_plans
   SET style_policy = config_snapshot->'stylePolicy'
 WHERE style_policy IS NULL
   AND jsonb_typeof(config_snapshot->'stylePolicy') = 'object';

UPDATE public.active_direction_verdicts
   SET style_policy = verdict_json->'stylePolicy'
 WHERE style_policy IS NULL
   AND jsonb_typeof(verdict_json->'stylePolicy') = 'object';

UPDATE public.pending_orders
   SET style_policy = COALESCE(
     decision_context->'stylePolicy',
     final_authorization->'decisionContext'->'stylePolicy'
   )
 WHERE style_policy IS NULL
   AND COALESCE(
     decision_context->'stylePolicy',
     final_authorization->'decisionContext'->'stylePolicy'
   ) IS NOT NULL;
UPDATE public.paper_positions
   SET style_policy = COALESCE(
     decision_context->'stylePolicy',
     final_authorization->'decisionContext'->'stylePolicy'
   )
 WHERE style_policy IS NULL
   AND COALESCE(
     decision_context->'stylePolicy',
     final_authorization->'decisionContext'->'stylePolicy'
   ) IS NOT NULL;
