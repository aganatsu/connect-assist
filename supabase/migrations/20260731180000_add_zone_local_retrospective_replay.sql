-- Retrospective zone-local replay evidence.
--
-- Historical replay is deliberately separated from forward scanner
-- observations. It can accelerate research, but it is never eligible to
-- activate Soft or Hard runtime behavior by itself.

ALTER TABLE public.zone_candidate_shadow_observations
  ADD COLUMN IF NOT EXISTS evidence_source TEXT NOT NULL
    DEFAULT 'forward_observation',
  ADD COLUMN IF NOT EXISTS replay_run_id UUID
    REFERENCES public.backtest_runs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS replay_contract_version TEXT,
  ADD COLUMN IF NOT EXISTS activation_eligible BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.zone_candidate_shadow_observations
  DROP CONSTRAINT IF EXISTS zone_shadow_evidence_source_valid,
  DROP CONSTRAINT IF EXISTS zone_shadow_replay_never_activation;

ALTER TABLE public.zone_candidate_shadow_observations
  ADD CONSTRAINT zone_shadow_evidence_source_valid CHECK (
    evidence_source IN ('forward_observation', 'retrospective_replay')
  ),
  ADD CONSTRAINT zone_shadow_replay_never_activation CHECK (
    evidence_source <> 'retrospective_replay'
    OR activation_eligible = false
  );

CREATE INDEX IF NOT EXISTS idx_zone_shadow_replay_run
  ON public.zone_candidate_shadow_observations (
    user_id,
    replay_run_id,
    symbol,
    observed_at
  )
  WHERE evidence_source = 'retrospective_replay';

CREATE OR REPLACE FUNCTION public.protect_zone_shadow_replay_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF ROW(
    NEW.evidence_source,
    NEW.replay_run_id,
    NEW.replay_contract_version,
    NEW.activation_eligible
  ) IS DISTINCT FROM ROW(
    OLD.evidence_source,
    OLD.replay_run_id,
    OLD.replay_contract_version,
    OLD.activation_eligible
  ) THEN
    RAISE EXCEPTION 'zone shadow replay provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_zone_shadow_replay_provenance
  ON public.zone_candidate_shadow_observations;
CREATE TRIGGER protect_zone_shadow_replay_provenance
  BEFORE UPDATE
  ON public.zone_candidate_shadow_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_zone_shadow_replay_provenance();

CREATE OR REPLACE VIEW public.zone_candidate_shadow_validation_summary
WITH (security_invoker = true)
AS
SELECT
  user_id,
  bot_id,
  trading_style,
  symbol,
  COUNT(DISTINCT scan_cycle_id) AS observed_scans,
  COUNT(DISTINCT scan_cycle_id)
    FILTER (WHERE ranking_disagreed) AS disagreement_scans,
  COUNT(*) FILTER (
    WHERE outcome_status IN ('would_have_won', 'would_have_lost')
  ) AS resolved_candidates,
  COUNT(*) FILTER (
    WHERE legacy_winner
      AND ranking_disagreed
      AND outcome_status IN ('would_have_won', 'would_have_lost')
  ) AS legacy_disagreement_samples,
  COUNT(*) FILTER (
    WHERE shadow_winner
      AND ranking_disagreed
      AND outcome_status IN ('would_have_won', 'would_have_lost')
  ) AS shadow_disagreement_samples,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE legacy_winner
        AND ranking_disagreed
        AND outcome_status = 'would_have_won'
    ) / NULLIF(
      COUNT(*) FILTER (
        WHERE legacy_winner
          AND ranking_disagreed
          AND outcome_status IN ('would_have_won', 'would_have_lost')
      ),
      0
    ),
    2
  ) AS legacy_disagreement_win_rate,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE shadow_winner
        AND ranking_disagreed
        AND outcome_status = 'would_have_won'
    ) / NULLIF(
      COUNT(*) FILTER (
        WHERE shadow_winner
          AND ranking_disagreed
          AND outcome_status IN ('would_have_won', 'would_have_lost')
      ),
      0
    ),
    2
  ) AS shadow_disagreement_win_rate,
  ROUND(AVG(mfe_pips) FILTER (
    WHERE shadow_winner AND ranking_disagreed
  ), 2) AS shadow_winner_avg_mfe_pips,
  ROUND(AVG(mae_pips) FILTER (
    WHERE shadow_winner AND ranking_disagreed
  ), 2) AS shadow_winner_avg_mae_pips,
  (
    evidence_source = 'forward_observation'
    AND activation_eligible
    AND COUNT(*) FILTER (
      WHERE shadow_winner
        AND ranking_disagreed
        AND outcome_status IN ('would_have_won', 'would_have_lost')
    ) >= 30
  ) AS minimum_sample_ready,
  'observe_only'::TEXT AS enforcement,
  evidence_source,
  activation_eligible,
  COUNT(DISTINCT replay_run_id)
    FILTER (WHERE replay_run_id IS NOT NULL) AS replay_runs
FROM public.zone_candidate_shadow_observations
GROUP BY
  user_id,
  bot_id,
  trading_style,
  symbol,
  evidence_source,
  activation_eligible;

REVOKE ALL ON FUNCTION public.protect_zone_shadow_replay_provenance()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_zone_shadow_replay_provenance()
  TO service_role;

GRANT SELECT ON public.zone_candidate_shadow_validation_summary
  TO authenticated, service_role;

COMMENT ON COLUMN public.zone_candidate_shadow_observations.evidence_source IS
  'forward_observation is out-of-sample scanner evidence; retrospective_replay is historical research only.';
COMMENT ON COLUMN public.zone_candidate_shadow_observations.activation_eligible IS
  'False for retrospective replay. Replay rows can never activate runtime enforcement.';
COMMENT ON VIEW public.zone_candidate_shadow_validation_summary IS
  'Source-separated zone-local validation. Only forward observations may become minimum_sample_ready.';
