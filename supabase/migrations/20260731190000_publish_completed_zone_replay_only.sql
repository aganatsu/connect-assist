-- Retrospective replay is useful only after the owning backtest completes.
-- Failed, cancelled, or still-running jobs must never contribute partial
-- samples to the validation dashboard.

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
FROM public.zone_candidate_shadow_observations AS observation
WHERE
  observation.evidence_source = 'forward_observation'
  OR EXISTS (
    SELECT 1
    FROM public.backtest_runs AS replay
    WHERE replay.id = observation.replay_run_id
      AND replay.user_id = observation.user_id
      AND replay.status = 'completed'
  )
GROUP BY
  user_id,
  bot_id,
  trading_style,
  symbol,
  evidence_source,
  activation_eligible;

GRANT SELECT ON public.zone_candidate_shadow_validation_summary
  TO authenticated, service_role;

COMMENT ON VIEW public.zone_candidate_shadow_validation_summary IS
  'Source-separated zone-local validation. Retrospective evidence is visible only after its backtest completes; only forward observations may become minimum_sample_ready.';
