-- Phase 4 — outcome validation for legacy-vs-local zone ranking.
--
-- These rows are evidence only. They are not staged setups, pending orders, or
-- positions and cannot authorize execution. Activation remains a later,
-- explicit Bot Config decision after enough resolved samples exist.

CREATE TABLE IF NOT EXISTS public.zone_candidate_shadow_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  scan_cycle_id UUID NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  symbol TEXT NOT NULL,
  trading_style TEXT NOT NULL,
  style_policy_version TEXT,
  style_base_policy_hash TEXT,
  style_policy_hash TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),

  candidate_id TEXT NOT NULL,
  zone_type TEXT NOT NULL CHECK (zone_type IN ('ob', 'fvg')),
  zone_low NUMERIC(20,10) NOT NULL,
  zone_high NUMERIC(20,10) NOT NULL,
  entry_price NUMERIC(20,10) NOT NULL,
  stop_loss NUMERIC(20,10),
  take_profit NUMERIC(20,10),

  legacy_rank INTEGER NOT NULL CHECK (legacy_rank > 0),
  shadow_rank INTEGER NOT NULL CHECK (shadow_rank > 0),
  rank_delta INTEGER NOT NULL,
  legacy_winner BOOLEAN NOT NULL DEFAULT false,
  shadow_winner BOOLEAN NOT NULL DEFAULT false,
  ranking_disagreed BOOLEAN NOT NULL DEFAULT false,
  legacy_zone_score NUMERIC(8,3) NOT NULL,
  legacy_comparable_score NUMERIC(8,3) NOT NULL,
  shadow_local_score NUMERIC(8,3) NOT NULL,

  local_confluence JSONB NOT NULL,
  shadow_ranking JSONB NOT NULL,

  outcome_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      outcome_status IN (
        'pending',
        'no_entry',
        'inconclusive',
        'would_have_won',
        'would_have_lost'
      )
    ),
  outcome_checked_at TIMESTAMPTZ,
  price_reached_entry BOOLEAN,
  tp_hit BOOLEAN,
  sl_hit BOOLEAN,
  tp_hit_time_minutes INTEGER,
  mfe_pips NUMERIC(10,2),
  mae_pips NUMERIC(10,2),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT zone_shadow_bounds_valid CHECK (zone_low <= zone_high),
  CONSTRAINT zone_shadow_one_candidate_per_scan
    UNIQUE (user_id, bot_id, scan_cycle_id, symbol, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_zone_shadow_pending_outcome
  ON public.zone_candidate_shadow_observations (outcome_status, observed_at)
  WHERE outcome_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_zone_shadow_user_recent
  ON public.zone_candidate_shadow_observations (
    user_id,
    bot_id,
    observed_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_zone_shadow_style_evidence
  ON public.zone_candidate_shadow_observations (
    user_id,
    trading_style,
    symbol,
    ranking_disagreed,
    outcome_status
  );

ALTER TABLE public.zone_candidate_shadow_observations
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own zone shadow observations"
  ON public.zone_candidate_shadow_observations;
CREATE POLICY "Users can view own zone shadow observations"
  ON public.zone_candidate_shadow_observations
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage zone shadow observations"
  ON public.zone_candidate_shadow_observations;
CREATE POLICY "Service role can manage zone shadow observations"
  ON public.zone_candidate_shadow_observations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.protect_zone_shadow_observation_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF ROW(
    NEW.user_id,
    NEW.bot_id,
    NEW.scan_cycle_id,
    NEW.observed_at,
    NEW.symbol,
    NEW.trading_style,
    NEW.style_policy_version,
    NEW.style_base_policy_hash,
    NEW.style_policy_hash,
    NEW.direction,
    NEW.candidate_id,
    NEW.zone_type,
    NEW.zone_low,
    NEW.zone_high,
    NEW.entry_price,
    NEW.stop_loss,
    NEW.take_profit,
    NEW.legacy_rank,
    NEW.shadow_rank,
    NEW.rank_delta,
    NEW.legacy_winner,
    NEW.shadow_winner,
    NEW.ranking_disagreed,
    NEW.legacy_zone_score,
    NEW.legacy_comparable_score,
    NEW.shadow_local_score,
    NEW.local_confluence,
    NEW.shadow_ranking
  ) IS DISTINCT FROM ROW(
    OLD.user_id,
    OLD.bot_id,
    OLD.scan_cycle_id,
    OLD.observed_at,
    OLD.symbol,
    OLD.trading_style,
    OLD.style_policy_version,
    OLD.style_base_policy_hash,
    OLD.style_policy_hash,
    OLD.direction,
    OLD.candidate_id,
    OLD.zone_type,
    OLD.zone_low,
    OLD.zone_high,
    OLD.entry_price,
    OLD.stop_loss,
    OLD.take_profit,
    OLD.legacy_rank,
    OLD.shadow_rank,
    OLD.rank_delta,
    OLD.legacy_winner,
    OLD.shadow_winner,
    OLD.ranking_disagreed,
    OLD.legacy_zone_score,
    OLD.legacy_comparable_score,
    OLD.shadow_local_score,
    OLD.local_confluence,
    OLD.shadow_ranking
  ) THEN
    RAISE EXCEPTION
      'zone shadow observation evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_zone_shadow_observation_evidence
  ON public.zone_candidate_shadow_observations;
CREATE TRIGGER protect_zone_shadow_observation_evidence
  BEFORE UPDATE
  ON public.zone_candidate_shadow_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_zone_shadow_observation_evidence();

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
    COUNT(*) FILTER (
      WHERE shadow_winner
        AND ranking_disagreed
        AND outcome_status IN ('would_have_won', 'would_have_lost')
    ) >= 30
  ) AS minimum_sample_ready,
  'observe_only'::TEXT AS enforcement
FROM public.zone_candidate_shadow_observations
GROUP BY user_id, bot_id, trading_style, symbol;

REVOKE ALL ON FUNCTION public.protect_zone_shadow_observation_evidence()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_zone_shadow_observation_evidence()
  TO service_role;

GRANT SELECT ON public.zone_candidate_shadow_observations
  TO authenticated;
GRANT ALL ON public.zone_candidate_shadow_observations
  TO service_role;
GRANT SELECT ON public.zone_candidate_shadow_validation_summary
  TO authenticated, service_role;

COMMENT ON TABLE public.zone_candidate_shadow_observations IS
  'Observe-only per-zone outcome evidence comparing legacy and local-confluence ranking. Never an execution authority.';
COMMENT ON VIEW public.zone_candidate_shadow_validation_summary IS
  'Style/symbol validation summary. minimum_sample_ready is evidence sufficiency only and never activates a strategy.';
