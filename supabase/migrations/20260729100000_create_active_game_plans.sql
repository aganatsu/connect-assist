-- Phase 3A — dedicated, versioned Gameplan authority.
--
-- scan_logs remains observability/history, but it is no longer the source used
-- by scanners or the UI to discover the active plan.

CREATE TABLE IF NOT EXISTS public.active_game_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  plan_version UUID NOT NULL,
  symbol TEXT NOT NULL,
  session TEXT NOT NULL CHECK (session IN ('Asian', 'London', 'New York')),
  bias TEXT NOT NULL CHECK (bias IN ('bullish', 'bearish', 'neutral')),
  bias_confidence NUMERIC(5,2) NOT NULL
    CHECK (bias_confidence >= 0 AND bias_confidence <= 100),
  v2_conviction JSONB NOT NULL DEFAULT '{}'::JSONB,
  state TEXT NOT NULL CHECK (state IN ('tradeable', 'wait', 'skip')),
  state_reason TEXT,
  generated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  invalidation_conditions JSONB NOT NULL DEFAULT '[]'::JSONB,
  source_candle_timestamps JSONB NOT NULL DEFAULT '{}'::JSONB,
  plan_json JSONB NOT NULL,
  focus_pairs JSONB NOT NULL DEFAULT '[]'::JSONB,
  news_events JSONB NOT NULL DEFAULT '[]'::JSONB,
  news_impacts JSONB NOT NULL DEFAULT '[]'::JSONB,
  summary TEXT NOT NULL DEFAULT '',
  generation_source TEXT NOT NULL
    CHECK (generation_source IN ('automatic_scan', 'manual_refresh')),
  contract_version TEXT NOT NULL DEFAULT 'phase3.v1',
  config_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  market_data_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_plan_version_symbol
  ON public.active_game_plans (user_id, bot_id, plan_version, symbol);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_plan_one_active_symbol
  ON public.active_game_plans (user_id, bot_id, symbol)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_game_plan_history
  ON public.active_game_plans (user_id, bot_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_plan_active_expiry
  ON public.active_game_plans (user_id, bot_id, expires_at)
  WHERE is_active;

ALTER TABLE public.active_game_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own active game plans"
  ON public.active_game_plans;
CREATE POLICY "Users can view own active game plans"
  ON public.active_game_plans
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.activate_game_plan_version(
  p_user_id UUID,
  p_bot_id TEXT,
  p_plan_version UUID,
  p_source TEXT,
  p_config_snapshot JSONB,
  p_market_data_snapshot JSONB,
  p_session_plan JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session TEXT := p_session_plan->>'session';
  v_generated_at TIMESTAMPTZ :=
    COALESCE(NULLIF(p_session_plan->>'generatedAt', '')::TIMESTAMPTZ, now());
  v_rows JSONB;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(p_bot_id, '') IS NULL
     OR p_plan_version IS NULL THEN
    RAISE EXCEPTION 'Gameplan user, bot and version are required';
  END IF;

  IF p_source NOT IN ('automatic_scan', 'manual_refresh') THEN
    RAISE EXCEPTION 'Invalid Gameplan generation source: %', p_source;
  END IF;

  IF v_session NOT IN ('Asian', 'London', 'New York') THEN
    RAISE EXCEPTION 'Invalid Gameplan session: %', v_session;
  END IF;

  IF jsonb_typeof(p_session_plan->'plans') <> 'array'
     OR jsonb_array_length(p_session_plan->'plans') = 0 THEN
    RAISE EXCEPTION 'A Gameplan version requires at least one instrument plan';
  END IF;

  -- A refresh is atomic: no reader can observe half of the new version.
  UPDATE public.active_game_plans
     SET is_active = false,
         superseded_at = now()
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND is_active;

  INSERT INTO public.active_game_plans (
    user_id,
    bot_id,
    plan_version,
    symbol,
    session,
    bias,
    bias_confidence,
    v2_conviction,
    state,
    state_reason,
    generated_at,
    expires_at,
    invalidation_conditions,
    source_candle_timestamps,
    plan_json,
    focus_pairs,
    news_events,
    news_impacts,
    summary,
    generation_source,
    contract_version,
    config_snapshot,
    market_data_snapshot
  )
  SELECT
    p_user_id,
    p_bot_id,
    p_plan_version,
    plan->>'symbol',
    v_session,
    plan->>'bias',
    COALESCE(NULLIF(plan->>'biasConfidence', '')::NUMERIC, 0),
    COALESCE(plan->'conviction', '{}'::JSONB),
    COALESCE(
      NULLIF(plan->>'state', ''),
      CASE WHEN COALESCE((plan->>'tradeable')::BOOLEAN, false)
        THEN 'tradeable' ELSE 'skip' END
    ),
    COALESCE(plan->>'stateReason', plan->>'skipReason'),
    v_generated_at,
    COALESCE(
      NULLIF(plan->>'expiresAt', '')::TIMESTAMPTZ,
      v_generated_at + INTERVAL '4 hours'
    ),
    COALESCE(plan->'invalidationConditions', '[]'::JSONB),
    COALESCE(plan->'sourceCandleTimestamps', '{}'::JSONB),
    plan,
    COALESCE(p_session_plan->'focusPairs', '[]'::JSONB),
    COALESCE(p_session_plan->'newsEvents', '[]'::JSONB),
    COALESCE(p_session_plan->'newsImpacts', '[]'::JSONB),
    COALESCE(p_session_plan->>'summary', ''),
    p_source,
    COALESCE(NULLIF(p_session_plan->>'contractVersion', ''), 'phase3.v1'),
    COALESCE(p_config_snapshot, '{}'::JSONB),
    COALESCE(p_market_data_snapshot, '{}'::JSONB)
  FROM jsonb_array_elements(p_session_plan->'plans') AS item(plan);

  SELECT jsonb_agg(
    jsonb_build_object('id', id, 'symbol', symbol)
    ORDER BY symbol
  )
    INTO v_rows
    FROM public.active_game_plans
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND plan_version = p_plan_version;

  RETURN jsonb_build_object(
    'plan_version', p_plan_version,
    'activated', true,
    'rows', COALESCE(v_rows, '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_game_plan_version(
  UUID, TEXT, UUID, TEXT, JSONB, JSONB, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.activate_game_plan_version(
  UUID, TEXT, UUID, TEXT, JSONB, JSONB, JSONB
) TO service_role;
