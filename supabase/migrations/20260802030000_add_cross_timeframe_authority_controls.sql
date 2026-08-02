-- Phase 7: expose Cross-Timeframe Authority configuration and activation state
-- as one read-only audit surface. This migration does not create an activation,
-- certify evidence, enable runtime enforcement or change any bot setting.

CREATE OR REPLACE VIEW public.cross_timeframe_authority_runtime_status
WITH (security_invoker = true)
AS
WITH configured AS (
  SELECT DISTINCT ON (cfg.user_id)
    cfg.user_id,
    COALESCE(
      cfg.config_json #>> '{strategy,crossTfAuthorityMode}',
      cfg.config_json ->> 'crossTfAuthorityMode',
      'observe'
    ) AS requested_mode,
    COALESCE(
      (cfg.config_json #>> '{strategy,crossTfRequireNestedImpulse}')::BOOLEAN,
      (cfg.config_json ->> 'crossTfRequireNestedImpulse')::BOOLEAN,
      true
    ) AS require_nested_impulse,
    COALESCE(
      (cfg.config_json #>> '{strategy,crossTfAllowStandaloneLowerTimeframe}')::BOOLEAN,
      (cfg.config_json ->> 'crossTfAllowStandaloneLowerTimeframe')::BOOLEAN,
      false
    ) AS allow_standalone_lower_timeframe,
    COALESCE(
      (cfg.config_json #>> '{strategy,crossTfMaximumZoneSeparationATR}')::NUMERIC,
      (cfg.config_json ->> 'crossTfMaximumZoneSeparationATR')::NUMERIC,
      0.25
    ) AS maximum_zone_separation_atr,
    COALESCE(
      (cfg.config_json #>> '{strategy,crossTfMinimumParentChildOverlapPercent}')::NUMERIC,
      (cfg.config_json ->> 'crossTfMinimumParentChildOverlapPercent')::NUMERIC,
      50
    ) AS minimum_parent_child_overlap_percent,
    COALESCE(
      (cfg.config_json #>> '{strategy,crossTfRequireSweepOrigin}')::BOOLEAN,
      (cfg.config_json ->> 'crossTfRequireSweepOrigin')::BOOLEAN,
      false
    ) AS require_sweep_origin,
    COALESCE(
      cfg.config_json #>> '{strategy,crossTfRetestQuality}',
      cfg.config_json ->> 'crossTfRetestQuality',
      'fresh_or_held'
    ) AS retest_quality,
    COALESCE(
      (cfg.config_json #>> '{strategy,crossTfMaximumCandidatesPerTimeframe}')::INTEGER,
      (cfg.config_json ->> 'crossTfMaximumCandidatesPerTimeframe')::INTEGER,
      3
    ) AS maximum_candidates_per_timeframe
  FROM public.bot_configs AS cfg
  ORDER BY
    cfg.user_id,
    (cfg.connection_id IS NULL) DESC,
    cfg.updated_at DESC
),
authority AS (
  SELECT
    activation.user_id,
    activation.bot_id,
    activation.authority_stage,
    activation.runtime_scope,
    activation.runtime_enforced,
    activation.revision,
    activation.evidence_hash,
    activation.updated_at
  FROM public.strategy_activation_registry AS activation
  WHERE activation.feature_key = 'cross_timeframe_authority'
    AND activation.variant_key = 'default'
    AND activation.activation_scope = '{}'::JSONB
)
SELECT
  account.user_id,
  account.bot_id,
  account.execution_mode AS runtime_target,
  COALESCE(configured.requested_mode, 'observe') AS requested_mode,
  CASE
    WHEN authority.runtime_enforced IS NOT TRUE THEN 'observe'
    WHEN account.execution_mode = 'live'
      AND authority.runtime_scope NOT IN ('live_canary', 'live') THEN 'observe'
    WHEN account.execution_mode <> 'live'
      AND authority.runtime_scope NOT IN ('paper', 'live_canary', 'live')
      THEN 'observe'
    WHEN authority.authority_stage = 'hard_block' THEN 'hard'
    WHEN authority.authority_stage = 'soft_adjustment' THEN 'soft'
    ELSE 'observe'
  END AS certified_maximum,
  CASE
    WHEN COALESCE(configured.requested_mode, 'observe') = 'observe'
      THEN 'observe'
    WHEN authority.runtime_enforced IS NOT TRUE THEN 'observe'
    WHEN account.execution_mode = 'live'
      AND authority.runtime_scope NOT IN ('live_canary', 'live') THEN 'observe'
    WHEN account.execution_mode <> 'live'
      AND authority.runtime_scope NOT IN ('paper', 'live_canary', 'live')
      THEN 'observe'
    WHEN COALESCE(configured.requested_mode, 'observe') = 'soft'
      AND authority.authority_stage IN ('soft_adjustment', 'hard_block')
      THEN 'soft'
    WHEN COALESCE(configured.requested_mode, 'observe') = 'hard'
      AND authority.authority_stage = 'hard_block' THEN 'hard'
    WHEN COALESCE(configured.requested_mode, 'observe') = 'hard'
      AND authority.authority_stage = 'soft_adjustment' THEN 'soft'
    ELSE 'observe'
  END AS effective_mode,
  true AS available,
  COALESCE(configured.require_nested_impulse, true)
    AS require_nested_impulse,
  COALESCE(configured.allow_standalone_lower_timeframe, false)
    AS allow_standalone_lower_timeframe,
  COALESCE(configured.maximum_zone_separation_atr, 0.25)
    AS maximum_zone_separation_atr,
  COALESCE(configured.minimum_parent_child_overlap_percent, 50)
    AS minimum_parent_child_overlap_percent,
  COALESCE(configured.require_sweep_origin, false)
    AS require_sweep_origin,
  COALESCE(configured.retest_quality, 'fresh_or_held') AS retest_quality,
  COALESCE(configured.maximum_candidates_per_timeframe, 3)
    AS maximum_candidates_per_timeframe,
  authority.authority_stage,
  authority.runtime_scope,
  COALESCE(authority.runtime_enforced, false) AS runtime_enforced,
  authority.revision,
  authority.evidence_hash,
  authority.updated_at AS activation_updated_at
FROM public.paper_accounts AS account
LEFT JOIN configured
  ON configured.user_id = account.user_id
LEFT JOIN authority
  ON authority.user_id = account.user_id
 AND authority.bot_id = account.bot_id;

REVOKE ALL ON public.cross_timeframe_authority_runtime_status FROM PUBLIC;
GRANT SELECT ON public.cross_timeframe_authority_runtime_status
  TO authenticated, service_role;

COMMENT ON VIEW public.cross_timeframe_authority_runtime_status IS
  'Read-only Cross-Timeframe Authority status. Separates available, requested, evidence-certified maximum and effective runtime mode.';
