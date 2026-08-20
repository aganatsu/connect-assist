CREATE TABLE IF NOT EXISTS public.stop_policy_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id text NOT NULL DEFAULT 'smc',
  scan_cycle_id text NOT NULL,
  candidate_id text NOT NULL,
  contract_version text NOT NULL DEFAULT 'stop-policy-evidence.v1',
  observed_at timestamptz NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  trading_style text NOT NULL,
  setup_source text NOT NULL,
  confirmation_timeframe text NOT NULL,
  entry_price numeric(24, 10) NOT NULL,
  structural_invalidation numeric(24, 10) NOT NULL,
  confirmation_atr numeric(24, 10) NOT NULL,
  pip_size numeric(24, 10) NOT NULL,
  spread_pips numeric(16, 4) NOT NULL,
  spread_source text NOT NULL CHECK (spread_source IN ('spec_proxy', 'live')),
  spread_safety_multiplier numeric(10, 4) NOT NULL,
  execution_floor_quote_distance numeric(24, 10) NOT NULL,
  execution_floor_source text NOT NULL
    CHECK (execution_floor_source IN ('spread_proxy', 'broker_snapshot')),
  broker_stops_level numeric(16, 4),
  broker_digits integer,
  tick_size numeric(24, 10),
  current_plan_valid boolean NOT NULL,
  current_stop_loss numeric(24, 10),
  current_take_profit numeric(24, 10),
  current_risk_reward numeric(16, 6),
  current_take_profit_source text,
  current_take_profit_fallback_reason text,
  current_plan_reason text,
  shadow_plan_valid boolean NOT NULL,
  shadow_stop_loss numeric(24, 10),
  shadow_take_profit numeric(24, 10),
  shadow_risk_reward numeric(16, 6),
  shadow_take_profit_source text,
  shadow_take_profit_fallback_reason text,
  shadow_plan_reason text,
  shadow_measurements jsonb NOT NULL,
  observation_only boolean NOT NULL DEFAULT true CHECK (observation_only),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stop_policy_observations_positive_prices CHECK (
    entry_price > 0 AND structural_invalidation > 0 AND
    confirmation_atr >= 0 AND pip_size > 0 AND
    execution_floor_quote_distance >= 0
  ),
  UNIQUE (user_id, bot_id, candidate_id, contract_version)
);

CREATE INDEX IF NOT EXISTS stop_policy_observations_lookup_idx
  ON public.stop_policy_observations
  (user_id, bot_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS stop_policy_observations_retention_idx
  ON public.stop_policy_observations (created_at);

ALTER TABLE public.stop_policy_observations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.stop_policy_observations TO authenticated;
GRANT ALL ON public.stop_policy_observations TO service_role;

DROP POLICY IF EXISTS "Users read own stop policy observations"
  ON public.stop_policy_observations;
CREATE POLICY "Users read own stop policy observations"
ON public.stop_policy_observations FOR SELECT TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages stop policy observations"
  ON public.stop_policy_observations;
CREATE POLICY "Service role manages stop policy observations"
ON public.stop_policy_observations FOR ALL TO service_role
USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.protect_stop_policy_observation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'stop policy observations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_stop_policy_observation_trg
  ON public.stop_policy_observations;
CREATE TRIGGER protect_stop_policy_observation_trg
BEFORE UPDATE ON public.stop_policy_observations
FOR EACH ROW EXECUTE FUNCTION public.protect_stop_policy_observation();

REVOKE EXECUTE ON FUNCTION public.protect_stop_policy_observation()
  FROM anon, authenticated;

COMMENT ON TABLE public.stop_policy_observations IS
  'Insert-once, observation-only comparison of current and proposed stop geometry at a zone candidate first evaluation.';
COMMENT ON COLUMN public.stop_policy_observations.candidate_id IS
  'Deterministic zone candidate identity. Repeated scans conflict and are ignored so long-lived candidates are not overweighted.';
COMMENT ON COLUMN public.stop_policy_observations.execution_floor_source IS
  'spread_proxy for historical/current scans without persisted broker specifications; broker_snapshot once exact inputs are available.';
