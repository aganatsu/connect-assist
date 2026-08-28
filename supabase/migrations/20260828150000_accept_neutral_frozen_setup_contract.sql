-- Phase 2: allow the existing immutable setup-context trigger to persist the
-- neutral v2 entry-zone contract while continuing to accept historical v1
-- contexts. Stored v1 rows are not rewritten.

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
  v_entry_zone JSONB;
  v_staged_id UUID;
  v_pending_id UUID;
  v_frozen_at TIMESTAMPTZ;
  v_version TEXT;
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

  -- Historical rows can still be frozen from evidence they already contain.
  -- The generated package remains v1 so no migration invents neutral
  -- provenance that was not captured when the setup was created.
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

  v_version := v_context->>'contractVersion';
  IF v_version IS NULL OR v_version NOT IN (
    'setup-policy-freeze.v1',
    'setup-policy-freeze.v2'
  ) THEN
    RAISE EXCEPTION 'unsupported frozen strategy context version: %',
      COALESCE(v_version, 'missing');
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
     ) IS NULL THEN
    RAISE EXCEPTION 'frozen strategy context is incomplete';
  END IF;

  IF v_version = 'setup-policy-freeze.v1' AND (
    (v_context#>>'{scenarioZoneStory,contractVersion}')
      IS DISTINCT FROM 'scenario-zone-story.v1'
    OR (v_context#>>'{scenarioZoneStory,enforcement}')
      IS DISTINCT FROM 'observe_only'
  ) THEN
    RAISE EXCEPTION 'legacy frozen strategy context is incomplete';
  END IF;

  IF v_version = 'setup-policy-freeze.v2' THEN
    IF NULLIF(v_context->>'frozenAt', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,contractVersion}', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,basePolicyHash}', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,policyHash}', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,style}', '') IS NULL
       OR NOT (v_context ? 'entryZone')
       OR jsonb_typeof(v_context->'entryZone') NOT IN ('object', 'null')
       OR (v_context#>>'{scenarioStory,contractVersion}')
         IS DISTINCT FROM 'scenario-story.v1'
       OR (v_context#>>'{scenarioStory,enforcement}')
         IS DISTINCT FROM 'observe_only'
       OR jsonb_typeof(v_context#>'{scenarioStory,scenarioCandidates}')
         IS DISTINCT FROM 'array'
       OR (v_context#>'{scenarioStory,selectedScenarioIndex}')
         IS DISTINCT FROM 'null'::JSONB
       OR NULLIF(v_context#>>'{scenarioStory,status}', '') IS NULL
       OR v_context#>>'{scenarioStory,status}' NOT IN (
         'captured',
         'no_directional_scenario'
       ) THEN
      RAISE EXCEPTION 'neutral frozen strategy context is incomplete';
    END IF;

    IF jsonb_typeof(v_context->'entryZone') = 'object' THEN
      v_entry_zone := v_context->'entryZone';
      IF v_entry_zone->>'contractVersion' IS DISTINCT FROM
           'frozen-entry-zone.v1'
         OR v_entry_zone->>'enforcement' IS DISTINCT FROM 'observe_only'
         OR v_entry_zone->'affectsAuthorization' IS DISTINCT FROM 'false'::JSONB
         OR NULLIF(v_entry_zone->>'setupFamily', '') IS NULL
         OR v_entry_zone->>'setupFamily' NOT IN (
           'impulse',
           'cascade',
           'structure_poi'
         )
         OR v_entry_zone->>'direction' IS DISTINCT FROM
           v_context->>'direction'
         OR NULLIF(v_entry_zone->>'type', '') IS NULL
         OR jsonb_typeof(v_entry_zone->'sourceEvidenceIds')
           IS DISTINCT FROM 'array'
         OR jsonb_typeof(v_entry_zone->'bounds') IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_entry_zone#>'{bounds,low}')
           IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_entry_zone#>'{bounds,high}')
           IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_entry_zone->'geometry') IS DISTINCT FROM 'object'
         OR NOT (v_entry_zone->'geometry' ? 'entry')
         OR NOT (v_entry_zone->'geometry' ? 'structuralInvalidation')
         OR NOT (v_entry_zone->'geometry' ? 'positionStop')
         OR NOT (v_entry_zone->'geometry' ? 'target')
         OR jsonb_typeof(v_entry_zone#>'{geometry,entry}') NOT IN (
           'number',
           'null'
         )
         OR jsonb_typeof(v_entry_zone#>'{geometry,structuralInvalidation}')
           NOT IN ('number', 'null')
         OR jsonb_typeof(v_entry_zone#>'{geometry,positionStop}') NOT IN (
           'number',
           'null'
         )
         OR jsonb_typeof(v_entry_zone#>'{geometry,target}') NOT IN (
           'number',
           'null'
         )
         OR jsonb_typeof(v_entry_zone->'stylePolicy')
           IS DISTINCT FROM 'object'
         OR v_entry_zone#>>'{stylePolicy,version}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,contractVersion}'
         OR v_entry_zone#>>'{stylePolicy,basePolicyHash}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,basePolicyHash}'
         OR v_entry_zone#>>'{stylePolicy,policyHash}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,policyHash}'
         OR v_entry_zone#>>'{stylePolicy,style}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,style}'
         OR jsonb_typeof(v_entry_zone->'timeframeRoles')
           IS DISTINCT FROM 'object'
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,bias}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,structure}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,setup}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,confirmation}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,refinement}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,runtimeEntry}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,runtimeHTF}', '') IS NULL
         OR NULLIF(v_entry_zone->>'frozenAt', '') IS NULL
         OR v_entry_zone->>'frozenAt' IS DISTINCT FROM v_context->>'frozenAt'
         OR jsonb_typeof(v_entry_zone->'sourceWindow') IS NULL
         OR jsonb_typeof(v_entry_zone->'sourceWindow') NOT IN (
           'object',
           'null'
         ) THEN
        RAISE EXCEPTION 'frozen entry zone is incomplete';
      END IF;

      IF jsonb_typeof(v_entry_zone->'sourceWindow') = 'object' AND (
        NULLIF(v_entry_zone#>>'{sourceWindow,start}', '') IS NULL
        OR NULLIF(v_entry_zone#>>'{sourceWindow,end}', '') IS NULL
      ) THEN
        RAISE EXCEPTION 'frozen entry zone source window is incomplete';
      END IF;

      IF v_entry_zone->>'setupFamily' = 'structure_poi' AND (
        NULLIF(v_entry_zone->>'candidateId', '') IS NULL
        OR NULLIF(v_entry_zone->>'sourceContextId', '') IS NULL
        OR jsonb_array_length(v_entry_zone->'sourceEvidenceIds') = 0
        OR jsonb_typeof(v_entry_zone->'sourceWindow') <> 'object'
        OR NULLIF(v_entry_zone->>'timeframe', '') IS NULL
      ) THEN
        RAISE EXCEPTION 'structure POI entry zone provenance is incomplete';
      END IF;
    END IF;
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

REVOKE ALL ON FUNCTION public.freeze_setup_strategy_context()
  FROM PUBLIC;

COMMENT ON COLUMN public.staged_setups.frozen_strategy_context IS
  'Immutable style, entry-zone provenance, scenario narrative and confirmation policy captured when the setup first entered the Watchlist.';
COMMENT ON COLUMN public.pending_orders.frozen_strategy_context IS
  'Immutable strategy context inherited from qualification or captured when a standalone pending setup was created.';
COMMENT ON COLUMN public.paper_positions.frozen_strategy_context IS
  'Immutable strategy context inherited from the pending or immediate entry that created this position.';
