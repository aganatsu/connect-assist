ALTER TABLE public.ict_entry_zone_authority_observations
  ADD COLUMN IF NOT EXISTS evidence_source TEXT NOT NULL DEFAULT 'forward_observation',
  ADD COLUMN IF NOT EXISTS replay_run_id UUID,
  ADD COLUMN IF NOT EXISTS replay_contract_version TEXT,
  ADD COLUMN IF NOT EXISTS activation_eligible BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS legacy_outcome_status TEXT;

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_evidence_source_check;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_evidence_source_check CHECK (
    evidence_source IN ('forward_observation', 'retrospective_replay')
  );

ALTER TABLE public.ict_entry_zone_authority_observations
  DROP CONSTRAINT IF EXISTS ict_entry_zone_authority_legacy_outcome_check;
ALTER TABLE public.ict_entry_zone_authority_observations
  ADD CONSTRAINT ict_entry_zone_authority_legacy_outcome_check CHECK (
    legacy_outcome_status IS NULL OR legacy_outcome_status IN (
      'no_entry', 'inconclusive', 'would_have_won', 'would_have_lost'
    )
  );

CREATE INDEX IF NOT EXISTS idx_ict_entry_zone_authority_replay
  ON public.ict_entry_zone_authority_observations (replay_run_id)
  WHERE evidence_source = 'retrospective_replay';

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
    ON legacy.user_id = authority.user_id
    AND legacy.bot_id = authority.bot_id
    AND legacy.scan_cycle_id = authority.scan_cycle_id
    AND legacy.symbol = authority.symbol
    AND legacy.candidate_id = authority.legacy_candidate_id
)
SELECT
  user_id, bot_id, trading_style, symbol, evidence_source,
  activation_eligible,
  COUNT(DISTINCT replay_run_id) AS replay_runs,
  COUNT(*) AS observed_scans,
  COUNT(*) FILTER (WHERE disagreed) AS disagreement_scans,
  COUNT(*) FILTER (WHERE outcome_status IN ('would_have_won', 'would_have_lost'))
    AS resolved_authority_setups,
  COUNT(*) FILTER (WHERE disagreed AND outcome_status = 'would_have_won')
    AS authority_winners,
  COUNT(*) FILTER (WHERE disagreed AND outcome_status = 'would_have_lost')
    AS authority_losers,
  COUNT(*) FILTER (
    WHERE disagreed AND compared_legacy_outcome_status = 'would_have_won'
      AND outcome_status = 'would_have_won'
  ) AS winners_retained,
  COUNT(*) FILTER (
    WHERE disagreed AND compared_legacy_outcome_status = 'would_have_lost'
      AND outcome_status = 'would_have_won'
  ) AS losers_avoided,
  COUNT(*) FILTER (
    WHERE disagreed AND compared_legacy_outcome_status = 'would_have_won'
      AND outcome_status = 'would_have_lost'
  ) AS missed_opportunities,
  COUNT(*) FILTER (
    WHERE disagreed AND compared_legacy_outcome_status = 'would_have_lost'
      AND outcome_status = 'would_have_lost'
  ) AS false_positives,
  ROUND(AVG(mfe_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mfe_pips,
  ROUND(AVG(mae_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mae_pips,
  (
    activation_eligible
    AND evidence_source = 'forward_observation'
    AND COUNT(*) FILTER (
      WHERE disagreed
        AND compared_legacy_outcome_status IN ('would_have_won', 'would_have_lost')
        AND outcome_status IN ('would_have_won', 'would_have_lost')
    ) >= 30
  ) AS minimum_sample_ready,
  'observe_only'::TEXT AS enforcement
FROM comparisons
GROUP BY user_id, bot_id, trading_style, symbol, evidence_source,
  activation_eligible;

GRANT SELECT ON public.ict_entry_zone_authority_validation_summary
  TO authenticated, service_role;

COMMENT ON COLUMN public.ict_entry_zone_authority_observations.activation_eligible IS
  'False for retrospective replay. Replay evidence can inform research but cannot authorize runtime promotion.';
