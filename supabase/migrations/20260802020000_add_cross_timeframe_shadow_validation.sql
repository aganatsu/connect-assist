-- Phase 6: source-separated, observation-only validation of the reference
-- cross-timeframe authority policy. No value in this migration can authorize,
-- size, stage, or execute a trade.

ALTER TABLE public.zone_candidate_shadow_observations
  ADD COLUMN IF NOT EXISTS cross_tf_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS cross_tf_policy JSONB,
  ADD COLUMN IF NOT EXISTS legacy_execution_decision TEXT,
  ADD COLUMN IF NOT EXISTS cross_tf_shadow_decision TEXT,
  ADD COLUMN IF NOT EXISTS cross_tf_disagreed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cross_tf_reason_codes TEXT[] NOT NULL
    DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS cross_tf_evaluation JSONB;

ALTER TABLE public.zone_candidate_shadow_observations
  DROP CONSTRAINT IF EXISTS zone_shadow_cross_tf_decisions_valid;
ALTER TABLE public.zone_candidate_shadow_observations
  ADD CONSTRAINT zone_shadow_cross_tf_decisions_valid CHECK (
    (cross_tf_policy_version IS NULL
      AND legacy_execution_decision IS NULL
      AND cross_tf_shadow_decision IS NULL)
    OR (
      cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
      AND legacy_execution_decision IN ('allow', 'block')
      AND cross_tf_shadow_decision IN ('allow', 'block')
      AND cross_tf_policy #>> '{enforcement}' = 'observe_only'
      AND cross_tf_evaluation #>> '{enforcement}' = 'observe_only'
    )
  );

CREATE INDEX IF NOT EXISTS idx_zone_shadow_cross_tf_disagreement
  ON public.zone_candidate_shadow_observations (
    user_id,
    bot_id,
    evidence_source,
    cross_tf_disagreed,
    outcome_status
  )
  WHERE cross_tf_policy_version IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_cross_tf_shadow_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF ROW(
    NEW.cross_tf_policy_version,
    NEW.cross_tf_policy,
    NEW.legacy_execution_decision,
    NEW.cross_tf_shadow_decision,
    NEW.cross_tf_disagreed,
    NEW.cross_tf_reason_codes,
    NEW.cross_tf_evaluation
  ) IS DISTINCT FROM ROW(
    OLD.cross_tf_policy_version,
    OLD.cross_tf_policy,
    OLD.legacy_execution_decision,
    OLD.cross_tf_shadow_decision,
    OLD.cross_tf_disagreed,
    OLD.cross_tf_reason_codes,
    OLD.cross_tf_evaluation
  ) THEN
    RAISE EXCEPTION 'cross-timeframe shadow evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_cross_tf_shadow_evidence
  ON public.zone_candidate_shadow_observations;
CREATE TRIGGER protect_cross_tf_shadow_evidence
  BEFORE UPDATE
  ON public.zone_candidate_shadow_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_cross_tf_shadow_evidence();

CREATE OR REPLACE VIEW public.zone_candidate_shadow_validation_summary
WITH (security_invoker = true)
AS
WITH resolved AS (
  SELECT
    observation.*,
    CASE
      WHEN outcome_status = 'would_have_won' THEN
        ABS(take_profit - entry_price)
          / NULLIF(ABS(entry_price - stop_loss), 0)
      WHEN outcome_status = 'would_have_lost' THEN -1::NUMERIC
      ELSE NULL
    END AS outcome_r
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
)
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
    FILTER (WHERE replay_run_id IS NOT NULL) AS replay_runs,

  COUNT(DISTINCT scan_cycle_id)
    FILTER (WHERE cross_tf_disagreed) AS cross_tf_disagreement_scans,
  COUNT(*) FILTER (
    WHERE legacy_winner
      AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
      AND outcome_status IN ('would_have_won', 'would_have_lost')
  ) AS cross_tf_resolved_legacy_trades,
  COUNT(*) FILTER (
    WHERE legacy_winner
      AND cross_tf_shadow_decision = 'allow'
      AND outcome_status = 'would_have_won'
  ) AS winners_retained,
  COUNT(*) FILTER (
    WHERE legacy_winner
      AND cross_tf_shadow_decision = 'block'
      AND outcome_status = 'would_have_lost'
  ) AS losers_avoided,
  COUNT(*) FILTER (
    WHERE legacy_winner
      AND cross_tf_shadow_decision = 'block'
      AND outcome_status = 'would_have_won'
  ) AS missed_opportunities,
  COUNT(*) FILTER (
    WHERE legacy_winner
      AND cross_tf_shadow_decision = 'allow'
      AND outcome_status = 'would_have_lost'
  ) AS false_positives,
  ROUND(AVG(outcome_r) FILTER (
    WHERE legacy_winner
      AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
      AND outcome_status IN ('would_have_won', 'would_have_lost')
  ), 4) AS legacy_expectancy_r,
  ROUND(AVG(
    CASE
      WHEN cross_tf_shadow_decision = 'allow' THEN outcome_r
      ELSE 0
    END
  ) FILTER (
    WHERE legacy_winner
      AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
      AND outcome_status IN ('would_have_won', 'would_have_lost')
  ), 4) AS cross_tf_expectancy_r,
  ROUND(
    AVG(
      CASE
        WHEN cross_tf_shadow_decision = 'allow' THEN outcome_r
        ELSE 0
      END
    ) FILTER (
      WHERE legacy_winner
        AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
        AND outcome_status IN ('would_have_won', 'would_have_lost')
    )
    - AVG(outcome_r) FILTER (
      WHERE legacy_winner
        AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
        AND outcome_status IN ('would_have_won', 'would_have_lost')
    ),
    4
  ) AS cross_tf_expectancy_delta_r,
  ROUND(AVG(mfe_pips) FILTER (
    WHERE legacy_winner
      AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
  ), 2) AS cross_tf_avg_mfe_pips,
  ROUND(AVG(mae_pips) FILTER (
    WHERE legacy_winner
      AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'
  ), 2) AS cross_tf_avg_mae_pips,
  (
    evidence_source = 'forward_observation'
    AND activation_eligible
    AND COUNT(*) FILTER (
      WHERE legacy_winner
        AND cross_tf_disagreed
        AND outcome_status IN ('would_have_won', 'would_have_lost')
    ) >= 30
  ) AS cross_tf_minimum_sample_ready,
  'observe_only'::TEXT AS cross_tf_enforcement
FROM resolved
GROUP BY
  user_id,
  bot_id,
  trading_style,
  symbol,
  evidence_source,
  activation_eligible;

REVOKE ALL ON FUNCTION public.protect_cross_tf_shadow_evidence()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_cross_tf_shadow_evidence()
  TO service_role;
GRANT SELECT ON public.zone_candidate_shadow_validation_summary
  TO authenticated, service_role;

COMMENT ON VIEW public.zone_candidate_shadow_validation_summary IS
  'Source-separated local-ranking and cross-timeframe policy validation. Replay remains research-only and only completed replay runs are visible.';
