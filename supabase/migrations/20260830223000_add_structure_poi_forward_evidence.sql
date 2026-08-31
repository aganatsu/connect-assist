-- Forward-only evidence for the existing ICT entry-zone selector's
-- `structure_poi` mode. This extends the existing observation table and
-- outcome tracker; it does not create another detector or execution route.

ALTER TABLE public.ict_entry_zone_authority_observations
  ADD COLUMN IF NOT EXISTS setup_family TEXT NOT NULL DEFAULT 'impulse',
  ADD COLUMN IF NOT EXISTS opportunity_key TEXT,
  ADD COLUMN IF NOT EXISTS comparison_status TEXT NOT NULL DEFAULT 'comparable',
  ADD COLUMN IF NOT EXISTS geometry_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS gross_risk_reward NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS effective_risk_reward NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS minimum_risk_reward NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS risk_reward_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS cost_assumptions JSONB,
  ADD COLUMN IF NOT EXISTS style_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS style_base_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS style_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS timeframe_roles JSONB,
  ADD COLUMN IF NOT EXISTS source_evidence_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS source_window JSONB,
  ADD COLUMN IF NOT EXISTS current_impulse_decision JSONB,
  ADD COLUMN IF NOT EXISTS decision_observations JSONB,
  ADD COLUMN IF NOT EXISTS timeframe_evidence_id TEXT,
  ADD COLUMN IF NOT EXISTS candle_snapshot_refs JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE public.ict_entry_zone_authority_observations
  ALTER COLUMN entry_price DROP NOT NULL,
  ALTER COLUMN stop_loss DROP NOT NULL,
  ALTER COLUMN take_profit DROP NOT NULL;

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_setup_family_check;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_setup_family_check CHECK (
    setup_family IN ('impulse', 'structure_poi')
  );

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_comparison_status_check;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_comparison_status_check CHECK (
    comparison_status IN ('comparable', 'geometry_unavailable')
  );

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_opportunity_key_check;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_opportunity_key_check CHECK (
    setup_family <> 'structure_poi' OR opportunity_key IS NOT NULL
  );

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_comparable_geometry_check;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_comparable_geometry_check CHECK (
    comparison_status = 'geometry_unavailable'
    OR (entry_price IS NOT NULL AND stop_loss IS NOT NULL AND take_profit IS NOT NULL)
  );

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_observations_outcome_status_check;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_observations_outcome_status_check CHECK (
    outcome_status IN (
      'pending', 'no_entry', 'inconclusive', 'would_have_won',
      'would_have_lost', 'unavailable'
    )
  );

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_one_scan;
ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_one_family_per_scan;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_one_family_per_scan
    UNIQUE (user_id, bot_id, scan_cycle_id, symbol, setup_family);

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_one_structure_opportunity;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_one_structure_opportunity
    UNIQUE (user_id, bot_id, setup_family, opportunity_key);

CREATE INDEX IF NOT EXISTS idx_ict_entry_zone_authority_family_outcome
  ON public.ict_entry_zone_authority_observations (
    user_id, bot_id, setup_family, evidence_source, outcome_status, observed_at
  );

DROP VIEW IF EXISTS public.ict_entry_zone_authority_validation_summary;

CREATE VIEW public.ict_entry_zone_authority_validation_summary
WITH (security_invoker = true)
AS
WITH comparisons AS (
  SELECT
    authority.*,
    COALESCE(authority.legacy_outcome_status, legacy.outcome_status)
      AS compared_legacy_outcome_status
  FROM public.ict_entry_zone_authority_observations authority
  LEFT JOIN public.zone_candidate_shadow_observations legacy
    ON authority.setup_family = 'impulse'
    AND legacy.user_id = authority.user_id
    AND legacy.bot_id = authority.bot_id
    AND legacy.scan_cycle_id = authority.scan_cycle_id
    AND legacy.symbol = authority.symbol
    AND legacy.candidate_id = authority.legacy_candidate_id
)
SELECT
  user_id, bot_id, trading_style, symbol, setup_family, evidence_source,
  activation_eligible,
  COUNT(DISTINCT replay_run_id) AS replay_runs,
  COUNT(*) AS observed_scans,
  COUNT(*) FILTER (WHERE comparison_status = 'comparable') AS comparable_scans,
  COUNT(*) FILTER (
    WHERE comparison_status = 'geometry_unavailable'
      OR outcome_status = 'unavailable'
  ) AS geometry_unavailable_scans,
  COUNT(*) FILTER (WHERE disagreed) AS disagreement_scans,
  COUNT(*) FILTER (
    WHERE comparison_status = 'comparable'
      AND outcome_status IN ('would_have_won', 'would_have_lost')
  ) AS resolved_authority_setups,
  COUNT(*) FILTER (WHERE disagreed AND outcome_status = 'would_have_won')
    AS authority_winners,
  COUNT(*) FILTER (WHERE disagreed AND outcome_status = 'would_have_lost')
    AS authority_losers,
  COUNT(*) FILTER (
    WHERE setup_family = 'impulse'
      AND disagreed
      AND compared_legacy_outcome_status = 'would_have_won'
      AND outcome_status = 'would_have_won'
  ) AS winners_retained,
  COUNT(*) FILTER (
    WHERE setup_family = 'impulse'
      AND disagreed
      AND compared_legacy_outcome_status = 'would_have_lost'
      AND outcome_status = 'would_have_won'
  ) AS losers_avoided,
  COUNT(*) FILTER (
    WHERE disagreed AND (
      (setup_family = 'structure_poi' AND outcome_status = 'would_have_won')
      OR (
        setup_family = 'impulse'
        AND compared_legacy_outcome_status = 'would_have_won'
        AND outcome_status = 'would_have_lost'
      )
    )
  ) AS missed_opportunities,
  COUNT(*) FILTER (
    WHERE disagreed AND (
      (setup_family = 'structure_poi' AND outcome_status = 'would_have_lost')
      OR (
        setup_family = 'impulse'
        AND compared_legacy_outcome_status = 'would_have_lost'
        AND outcome_status = 'would_have_lost'
      )
    )
  ) AS false_positives,
  ROUND(AVG(mfe_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mfe_pips,
  ROUND(AVG(mae_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mae_pips,
  (
    activation_eligible
    AND evidence_source = 'forward_observation'
    AND CASE
      WHEN setup_family = 'structure_poi' THEN COUNT(*) FILTER (
        WHERE comparison_status = 'comparable'
          AND disagreed
          AND outcome_status IN ('would_have_won', 'would_have_lost')
      ) >= 30
      ELSE COUNT(*) FILTER (
        WHERE disagreed
          AND compared_legacy_outcome_status IN ('would_have_won', 'would_have_lost')
          AND outcome_status IN ('would_have_won', 'would_have_lost')
      ) >= 30
    END
  ) AS minimum_sample_ready,
  'observe_only'::TEXT AS enforcement
FROM comparisons
GROUP BY user_id, bot_id, trading_style, symbol, setup_family,
  evidence_source, activation_eligible;

GRANT SELECT ON public.ict_entry_zone_authority_validation_summary
  TO authenticated, service_role;

COMMENT ON COLUMN public.ict_entry_zone_authority_observations.setup_family IS
  'The existing selector family being observed. structure_poi remains observation-only.';
COMMENT ON COLUMN public.ict_entry_zone_authority_observations.candle_snapshot_refs IS
  'Composite references to immutable scan_candle_snapshots rows used by the observation.';
