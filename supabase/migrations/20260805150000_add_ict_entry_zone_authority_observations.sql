CREATE TABLE IF NOT EXISTS public.ict_entry_zone_authority_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  scan_cycle_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  trading_style TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  legacy_candidate_id TEXT,
  legacy_zone_type TEXT,
  legacy_zone_low NUMERIC(20,10),
  legacy_zone_high NUMERIC(20,10),
  authority_candidate_id TEXT NOT NULL,
  authority_zone_type TEXT NOT NULL CHECK (
    authority_zone_type IN ('ob', 'fvg', 'breaker', 'ob_fvg', 'breaker_fvg')
  ),
  authority_zone_low NUMERIC(20,10) NOT NULL,
  authority_zone_high NUMERIC(20,10) NOT NULL,
  authority_score NUMERIC(12,4) NOT NULL,
  component_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  disagreed BOOLEAN NOT NULL DEFAULT false,
  entry_price NUMERIC(20,10) NOT NULL,
  stop_loss NUMERIC(20,10) NOT NULL,
  take_profit NUMERIC(20,10) NOT NULL,
  authority_observation JSONB NOT NULL,
  outcome_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    outcome_status IN ('pending', 'no_entry', 'inconclusive', 'would_have_won', 'would_have_lost')
  ),
  outcome_checked_at TIMESTAMPTZ,
  price_reached_entry BOOLEAN,
  tp_hit BOOLEAN,
  sl_hit BOOLEAN,
  mfe_pips NUMERIC(10,2),
  mae_pips NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ict_entry_zone_authority_bounds_valid CHECK (
    authority_zone_low < authority_zone_high
  ),
  CONSTRAINT ict_entry_zone_authority_one_scan UNIQUE (
    user_id, bot_id, scan_cycle_id, symbol
  )
);

CREATE INDEX IF NOT EXISTS idx_ict_entry_zone_authority_pending
  ON public.ict_entry_zone_authority_observations (outcome_status, observed_at)
  WHERE outcome_status = 'pending';

ALTER TABLE public.ict_entry_zone_authority_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own ICT entry zone observations"
  ON public.ict_entry_zone_authority_observations;
CREATE POLICY "Users read own ICT entry zone observations"
  ON public.ict_entry_zone_authority_observations FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages ICT entry zone observations"
  ON public.ict_entry_zone_authority_observations;
CREATE POLICY "Service manages ICT entry zone observations"
  ON public.ict_entry_zone_authority_observations FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE VIEW public.ict_entry_zone_authority_validation_summary
WITH (security_invoker = true)
AS
WITH comparisons AS (
  SELECT
    authority.*,
    legacy.outcome_status AS legacy_outcome_status
  FROM public.ict_entry_zone_authority_observations authority
  LEFT JOIN public.zone_candidate_shadow_observations legacy
    ON legacy.user_id = authority.user_id
    AND legacy.bot_id = authority.bot_id
    AND legacy.scan_cycle_id = authority.scan_cycle_id
    AND legacy.symbol = authority.symbol
    AND legacy.candidate_id = authority.legacy_candidate_id
)
SELECT
  user_id,
  bot_id,
  trading_style,
  symbol,
  COUNT(*) AS observed_scans,
  COUNT(*) FILTER (WHERE disagreed) AS disagreement_scans,
  COUNT(*) FILTER (
    WHERE outcome_status IN ('would_have_won', 'would_have_lost')
  ) AS resolved_authority_setups,
  COUNT(*) FILTER (
    WHERE disagreed AND outcome_status = 'would_have_won'
  ) AS authority_winners,
  COUNT(*) FILTER (
    WHERE disagreed AND outcome_status = 'would_have_lost'
  ) AS authority_losers,
  COUNT(*) FILTER (
    WHERE disagreed AND legacy_outcome_status = 'would_have_won'
      AND outcome_status = 'would_have_won'
  ) AS winners_retained,
  COUNT(*) FILTER (
    WHERE disagreed AND legacy_outcome_status = 'would_have_lost'
      AND outcome_status = 'would_have_won'
  ) AS losers_avoided,
  COUNT(*) FILTER (
    WHERE disagreed AND legacy_outcome_status = 'would_have_won'
      AND outcome_status = 'would_have_lost'
  ) AS missed_opportunities,
  COUNT(*) FILTER (
    WHERE disagreed AND legacy_outcome_status = 'would_have_lost'
      AND outcome_status = 'would_have_lost'
  ) AS false_positives,
  ROUND(AVG(mfe_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mfe_pips,
  ROUND(AVG(mae_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mae_pips,
  COUNT(*) FILTER (
    WHERE disagreed
      AND legacy_outcome_status IN ('would_have_won', 'would_have_lost')
      AND outcome_status IN ('would_have_won', 'would_have_lost')
  ) >= 30 AS minimum_sample_ready,
  'observe_only'::TEXT AS enforcement
FROM comparisons
GROUP BY user_id, bot_id, trading_style, symbol;

GRANT SELECT ON public.ict_entry_zone_authority_observations,
  public.ict_entry_zone_authority_validation_summary
  TO authenticated, service_role;

COMMENT ON TABLE public.ict_entry_zone_authority_observations IS
  'Observation-only legacy versus type-neutral ICT entry zone selections. Never authorizes execution.';
