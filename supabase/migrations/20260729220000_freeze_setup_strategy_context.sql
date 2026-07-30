-- Corrective Slice 7 — freeze strategy policy and narrative evidence through
-- Watchlist -> pending -> confirmation -> fill.
--
-- The frozen context is immutable origin evidence. Fresh account, broker,
-- spread, prop-firm, thesis and current-direction safety checks still run at
-- fill time; they cannot rewrite the setup that originally qualified.

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS frozen_strategy_context JSONB,
  ADD COLUMN IF NOT EXISTS frozen_strategy_hash TEXT,
  ADD COLUMN IF NOT EXISTS policy_frozen_at TIMESTAMPTZ;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS frozen_strategy_context JSONB,
  ADD COLUMN IF NOT EXISTS frozen_strategy_hash TEXT,
  ADD COLUMN IF NOT EXISTS policy_frozen_at TIMESTAMPTZ;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS frozen_strategy_context JSONB,
  ADD COLUMN IF NOT EXISTS frozen_strategy_hash TEXT,
  ADD COLUMN IF NOT EXISTS policy_frozen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_staged_setups_frozen_strategy
  ON public.staged_setups (user_id, bot_id, frozen_strategy_hash)
  WHERE frozen_strategy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_orders_frozen_strategy
  ON public.pending_orders (user_id, bot_id, frozen_strategy_hash)
  WHERE frozen_strategy_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paper_positions_frozen_strategy
  ON public.paper_positions (user_id, bot_id, frozen_strategy_hash)
  WHERE frozen_strategy_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.freeze_setup_strategy_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_signal JSONB := '{}'::JSONB;
  v_context JSONB;
  v_staged_context JSONB;
  v_pending_context JSONB;
  v_staged_id UUID;
  v_pending_id UUID;
  v_frozen_at TIMESTAMPTZ;
BEGIN
  -- Once frozen, neither application code nor another trigger may silently
  -- replace the setup's origin evidence.
  IF TG_OP = 'UPDATE' AND OLD.frozen_strategy_context IS NOT NULL THEN
    IF NEW.frozen_strategy_context IS DISTINCT FROM
       OLD.frozen_strategy_context THEN
      RAISE EXCEPTION
        'frozen strategy context is immutable for %.%',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME;
    END IF;
    IF NEW.frozen_strategy_hash IS DISTINCT FROM OLD.frozen_strategy_hash THEN
      RAISE EXCEPTION
        'frozen strategy hash is immutable for %.%',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME;
    END IF;
    NEW.policy_frozen_at := OLD.policy_frozen_at;
    NEW.style_policy := OLD.style_policy;
    NEW.style_policy_version := OLD.style_policy_version;
    NEW.style_base_policy_hash := OLD.style_base_policy_hash;
    NEW.style_policy_hash := OLD.style_policy_hash;
    RETURN NEW;
  END IF;

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

  v_context := COALESCE(
    NULLIF(NEW.frozen_strategy_context, 'null'::JSONB),
    NULLIF(v_signal->'frozenStrategyContext', 'null'::JSONB),
    NULLIF(
      v_signal->'watchlistLifecycle'->'frozenStrategyContext',
      'null'::JSONB
    ),
    NULLIF(
      v_row->'authorization_result'->'frozenStrategyContext',
      'null'::JSONB
    ),
    NULLIF(
      v_row->'final_authorization'->'decisionContext'
        ->'frozenStrategyContext',
      'null'::JSONB
    )
  );

  BEGIN
    v_staged_id := NULLIF(v_row->>'staged_setup_id', '')::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_staged_id := NULL;
  END;
  IF v_context IS NULL AND v_staged_id IS NOT NULL THEN
    SELECT setup.frozen_strategy_context
      INTO v_staged_context
      FROM public.staged_setups AS setup
     WHERE setup.id = v_staged_id;
    v_context := v_staged_context;
  END IF;

  BEGIN
    v_pending_id := NULLIF(v_row->>'source_pending_order_id', '')::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_pending_id := NULL;
  END;
  IF v_context IS NULL AND v_pending_id IS NOT NULL THEN
    SELECT pending.frozen_strategy_context
      INTO v_pending_context
      FROM public.pending_orders AS pending
     WHERE pending.id = v_pending_id;
    v_context := v_pending_context;
  END IF;

  -- Historical rows can be upgraded from the evidence they already contain.
  -- They are labeled legacy rather than pretending a scenario was matched.
  IF v_context IS NULL
     AND jsonb_typeof(v_row->'style_policy') = 'object' THEN
    v_context := jsonb_strip_nulls(jsonb_build_object(
      'contractVersion', 'setup-policy-freeze.v1',
      'frozenAt', now(),
      'setupId', COALESCE(
        v_row->>'staged_setup_id',
        v_row->>'candidate_id',
        v_row->>'id'
      ),
      'candidateId', COALESCE(
        v_row->>'candidate_id',
        v_row->>'id'
      ),
      'symbol', v_row->>'symbol',
      'direction', v_row->>'direction',
      'stylePolicy', v_row->'style_policy',
      'decisionContext', v_row->'decision_context',
      'gamePlan', jsonb_strip_nulls(jsonb_build_object(
        'id', v_row->>'game_plan_id',
        'version', v_row->>'game_plan_version'
      )),
      'directionVerdict', v_row->'direction_verdict',
      'scenarioZoneStory', jsonb_build_object(
        'contractVersion', 'scenario-zone-story.v1',
        'enforcement', 'observe_only',
        'originatingZone', v_row->'originating_zone',
        'scenarioCandidates', '[]'::JSONB,
        'selectedScenarioIndex', NULL,
        'status', 'no_directional_scenario',
        'reason',
          'Historical row frozen from existing evidence; no scenario match was inferred'
      ),
      'confirmation', jsonb_strip_nulls(jsonb_build_object(
        'method', COALESCE(v_row->>'confirmation_method', 'choch'),
        'indicatorMinCount', COALESCE(
          v_row#>>'{confirmation_config,indicatorMinCount}',
          '3'
        ),
        'maxAttempts', COALESCE(
          v_row#>>'{confirmation_config,maxConfirmationAttempts}',
          v_row#>>'{style_policy,lifecycle,maxConfirmationAttempts}',
          '3'
        ),
        'timeframe',
          v_row#>>'{style_policy,timeframes,roles,confirmation}',
        'refinementTimeframe',
          v_row#>>'{style_policy,timeframes,roles,refinement}'
      ))
    ));
  END IF;

  IF v_context IS NULL THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(v_context) <> 'object' THEN
    RAISE EXCEPTION 'frozen strategy context must be a JSON object';
  END IF;
  IF v_context->>'contractVersion' <> 'setup-policy-freeze.v1' THEN
    RAISE EXCEPTION 'unsupported frozen strategy context version: %',
      COALESCE(v_context->>'contractVersion', 'missing');
  END IF;
  IF jsonb_typeof(v_context->'stylePolicy') IS DISTINCT FROM 'object'
     OR NULLIF(v_context->>'setupId', '') IS NULL
     OR NULLIF(v_context->>'candidateId', '') IS NULL
     OR NULLIF(v_context->>'symbol', '') IS NULL
     OR NULLIF(v_context->>'direction', '') IS NULL
     OR v_context->>'direction' NOT IN ('long', 'short')
     OR jsonb_typeof(v_context->'confirmation') IS DISTINCT FROM 'object'
     OR NULLIF(v_context#>>'{confirmation,method}', '') IS NULL
     OR v_context#>>'{confirmation,method}' NOT IN (
       'choch',
       'indicators',
       'choch_and_indicators'
     )
     OR NULLIF(v_context#>>'{confirmation,timeframe}', '') IS NULL
     OR NULLIF(
       v_context#>>'{confirmation,refinementTimeframe}',
       ''
     ) IS NULL
     OR (v_context#>>'{scenarioZoneStory,contractVersion}')
       IS DISTINCT FROM 'scenario-zone-story.v1'
     OR (v_context#>>'{scenarioZoneStory,enforcement}')
       IS DISTINCT FROM 'observe_only' THEN
    RAISE EXCEPTION 'frozen strategy context is incomplete';
  END IF;

  BEGIN
    v_frozen_at := NULLIF(v_context->>'frozenAt', '')::TIMESTAMPTZ;
  EXCEPTION
    WHEN invalid_datetime_format THEN
      v_frozen_at := NULL;
  END;
  NEW.frozen_strategy_context := v_context;
  NEW.frozen_strategy_hash := md5(v_context::TEXT);
  NEW.policy_frozen_at := COALESCE(v_frozen_at, now());
  NEW.style_policy := v_context->'stylePolicy';
  NEW.style_policy_version := NULLIF(
    v_context#>>'{stylePolicy,contractVersion}',
    ''
  );
  NEW.style_base_policy_hash := NULLIF(
    v_context#>>'{stylePolicy,basePolicyHash}',
    ''
  );
  NEW.style_policy_hash := NULLIF(
    v_context#>>'{stylePolicy,policyHash}',
    ''
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS freeze_staged_setup_strategy_context
  ON public.staged_setups;
DROP TRIGGER IF EXISTS zz_freeze_staged_setup_strategy_context
  ON public.staged_setups;
CREATE TRIGGER zz_freeze_staged_setup_strategy_context
  BEFORE INSERT OR UPDATE OF
    frozen_strategy_context,
    frozen_strategy_hash,
    policy_frozen_at,
    authorization_result,
    style_policy,
    style_policy_version,
    style_base_policy_hash,
    style_policy_hash
  ON public.staged_setups
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_setup_strategy_context();

DROP TRIGGER IF EXISTS freeze_pending_order_strategy_context
  ON public.pending_orders;
DROP TRIGGER IF EXISTS zz_freeze_pending_order_strategy_context
  ON public.pending_orders;
CREATE TRIGGER zz_freeze_pending_order_strategy_context
  BEFORE INSERT OR UPDATE OF
    frozen_strategy_context,
    frozen_strategy_hash,
    policy_frozen_at,
    signal_reason,
    final_authorization,
    decision_context,
    style_policy,
    style_policy_version,
    style_base_policy_hash,
    style_policy_hash
  ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_setup_strategy_context();

DROP TRIGGER IF EXISTS freeze_position_strategy_context
  ON public.paper_positions;
DROP TRIGGER IF EXISTS zz_freeze_position_strategy_context
  ON public.paper_positions;
CREATE TRIGGER zz_freeze_position_strategy_context
  BEFORE INSERT OR UPDATE OF
    frozen_strategy_context,
    frozen_strategy_hash,
    policy_frozen_at,
    signal_reason,
    final_authorization,
    decision_context,
    style_policy,
    style_policy_version,
    style_base_policy_hash,
    style_policy_hash
  ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_setup_strategy_context();

-- Trigger a safe one-time backfill for rows that already have truthful style
-- evidence. Rows without it remain explicitly legacy and are not fabricated.
UPDATE public.staged_setups
   SET frozen_strategy_context = frozen_strategy_context
 WHERE frozen_strategy_context IS NULL
   AND style_policy IS NOT NULL;

UPDATE public.pending_orders
   SET frozen_strategy_context = frozen_strategy_context
 WHERE frozen_strategy_context IS NULL
   AND style_policy IS NOT NULL;

UPDATE public.paper_positions
   SET frozen_strategy_context = frozen_strategy_context
 WHERE frozen_strategy_context IS NULL
   AND style_policy IS NOT NULL;

ALTER TABLE public.staged_setups
  DROP CONSTRAINT IF EXISTS staged_frozen_strategy_hash_matches;
ALTER TABLE public.staged_setups
  ADD CONSTRAINT staged_frozen_strategy_hash_matches
  CHECK (
    frozen_strategy_context IS NULL OR
    frozen_strategy_hash = md5(frozen_strategy_context::TEXT)
  ) NOT VALID;

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_frozen_strategy_hash_matches;
ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_frozen_strategy_hash_matches
  CHECK (
    frozen_strategy_context IS NULL OR
    frozen_strategy_hash = md5(frozen_strategy_context::TEXT)
  ) NOT VALID;

ALTER TABLE public.paper_positions
  DROP CONSTRAINT IF EXISTS position_frozen_strategy_hash_matches;
ALTER TABLE public.paper_positions
  ADD CONSTRAINT position_frozen_strategy_hash_matches
  CHECK (
    frozen_strategy_context IS NULL OR
    frozen_strategy_hash = md5(frozen_strategy_context::TEXT)
  ) NOT VALID;

REVOKE ALL ON FUNCTION public.freeze_setup_strategy_context()
  FROM PUBLIC;

COMMENT ON COLUMN public.staged_setups.frozen_strategy_context IS
  'Immutable style, scenario/zone story and confirmation policy captured when the setup first entered the Watchlist.';
COMMENT ON COLUMN public.pending_orders.frozen_strategy_context IS
  'Immutable strategy context inherited from qualification or captured when a standalone pending setup was created.';
COMMENT ON COLUMN public.paper_positions.frozen_strategy_context IS
  'Immutable strategy context inherited from the pending or immediate entry that created this position.';
