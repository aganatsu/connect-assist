-- Phase 3B — unify Gameplan, Direction Verdict, thesis validity and entry
-- confirmation into one durable decision contract.

CREATE TABLE IF NOT EXISTS public.active_direction_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verdict_version UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  symbol TEXT NOT NULL,
  game_plan_id UUID REFERENCES public.active_game_plans(id),
  game_plan_version UUID,
  verdict TEXT NOT NULL CHECK (verdict IN ('long', 'short', 'neutral')),
  confidence NUMERIC(5,2) NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  agreement NUMERIC(6,5) NOT NULL CHECK (agreement BETWEEN 0 AND 1),
  should_block BOOLEAN NOT NULL,
  block_reason TEXT,
  score_adjustment NUMERIC(8,3) NOT NULL DEFAULT 0,
  verdict_json JSONB NOT NULL,
  source_candle_timestamp TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  scan_cycle_id TEXT,
  contract_version TEXT NOT NULL DEFAULT 'phase3.v2',
  is_active BOOLEAN NOT NULL DEFAULT true,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_direction_verdict_version
  ON public.active_direction_verdicts
    (user_id, bot_id, symbol, verdict_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_direction_verdict_one_active
  ON public.active_direction_verdicts (user_id, bot_id, symbol)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_direction_verdict_history
  ON public.active_direction_verdicts
    (user_id, bot_id, symbol, evaluated_at DESC);

ALTER TABLE public.active_direction_verdicts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own Direction Verdicts"
  ON public.active_direction_verdicts;
CREATE POLICY "Users can view own Direction Verdicts"
  ON public.active_direction_verdicts
  FOR SELECT
  USING (auth.uid() = user_id);

GRANT SELECT ON public.active_direction_verdicts TO authenticated;
GRANT ALL ON public.active_direction_verdicts TO service_role;

CREATE OR REPLACE FUNCTION public.activate_direction_verdict(
  p_user_id UUID,
  p_bot_id TEXT,
  p_symbol TEXT,
  p_verdict_version UUID,
  p_game_plan_id UUID,
  p_game_plan_version UUID,
  p_verdict TEXT,
  p_confidence NUMERIC,
  p_agreement NUMERIC,
  p_should_block BOOLEAN,
  p_block_reason TEXT,
  p_score_adjustment NUMERIC,
  p_verdict_json JSONB,
  p_source_candle_timestamp TIMESTAMPTZ,
  p_evaluated_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ,
  p_scan_cycle_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.active_direction_verdicts%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(p_bot_id, '') IS NULL
     OR NULLIF(p_symbol, '') IS NULL
     OR p_verdict_version IS NULL THEN
    RAISE EXCEPTION 'Direction Verdict user, bot, symbol and version are required';
  END IF;
  IF p_verdict NOT IN ('long', 'short', 'neutral') THEN
    RAISE EXCEPTION 'Invalid Direction Verdict: %', p_verdict;
  END IF;
  IF p_expires_at <= p_evaluated_at THEN
    RAISE EXCEPTION 'Direction Verdict expiry must follow evaluation';
  END IF;

  UPDATE public.active_direction_verdicts
     SET is_active = false,
         superseded_at = now()
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND symbol = p_symbol
     AND is_active;

  INSERT INTO public.active_direction_verdicts (
    verdict_version, user_id, bot_id, symbol, game_plan_id, game_plan_version,
    verdict, confidence, agreement, should_block, block_reason, score_adjustment,
    verdict_json, source_candle_timestamp, evaluated_at, expires_at, scan_cycle_id
  ) VALUES (
    p_verdict_version, p_user_id, p_bot_id, p_symbol, p_game_plan_id, p_game_plan_version,
    p_verdict,
    LEAST(100, GREATEST(0, COALESCE(p_confidence, 0))),
    LEAST(1, GREATEST(0, COALESCE(p_agreement, 0))),
    COALESCE(p_should_block, true),
    p_block_reason,
    COALESCE(p_score_adjustment, 0),
    COALESCE(p_verdict_json, '{}'::JSONB),
    p_source_candle_timestamp, p_evaluated_at, p_expires_at, p_scan_cycle_id
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('activated', true, 'row', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.activate_direction_verdict(
  UUID, TEXT, TEXT, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, BOOLEAN,
  TEXT, NUMERIC, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.activate_direction_verdict(
  UUID, TEXT, TEXT, UUID, UUID, UUID, TEXT, NUMERIC, NUMERIC, BOOLEAN,
  TEXT, NUMERIC, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) TO service_role;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS decision_context JSONB,
  ADD COLUMN IF NOT EXISTS game_plan_id UUID
    REFERENCES public.active_game_plans(id),
  ADD COLUMN IF NOT EXISTS game_plan_version UUID,
  ADD COLUMN IF NOT EXISTS direction_verdict_id UUID
    REFERENCES public.active_direction_verdicts(id),
  ADD COLUMN IF NOT EXISTS direction_verdict JSONB,
  ADD COLUMN IF NOT EXISTS thesis_validation JSONB,
  ADD COLUMN IF NOT EXISTS entry_confirmation JSONB;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS decision_context JSONB,
  ADD COLUMN IF NOT EXISTS game_plan_id UUID
    REFERENCES public.active_game_plans(id),
  ADD COLUMN IF NOT EXISTS game_plan_version UUID,
  ADD COLUMN IF NOT EXISTS direction_verdict_id UUID
    REFERENCES public.active_direction_verdicts(id),
  ADD COLUMN IF NOT EXISTS direction_verdict JSONB,
  ADD COLUMN IF NOT EXISTS thesis_validation JSONB,
  ADD COLUMN IF NOT EXISTS entry_confirmation JSONB;

CREATE INDEX IF NOT EXISTS idx_pending_orders_game_plan
  ON public.pending_orders (user_id, bot_id, game_plan_version);

CREATE INDEX IF NOT EXISTS idx_paper_positions_game_plan
  ON public.paper_positions (user_id, bot_id, game_plan_version);

CREATE OR REPLACE FUNCTION public.populate_pending_decision_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_context JSONB;
  v_signal JSONB;
BEGIN
  v_signal := CASE
    WHEN NEW.signal_reason IS NULL THEN NULL
    WHEN jsonb_typeof(NEW.signal_reason) = 'string'
      THEN (NEW.signal_reason #>> '{}')::JSONB
    ELSE NEW.signal_reason
  END;
  v_context := COALESCE(
    NEW.final_authorization->'decisionContext',
    v_signal->'decisionContext',
    NEW.decision_context
  );
  IF v_context IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.decision_context := v_context;
  NEW.game_plan_id :=
    NULLIF(v_context#>>'{gamePlan,id}', '')::UUID;
  NEW.game_plan_version :=
    NULLIF(v_context#>>'{gamePlan,version}', '')::UUID;
  NEW.direction_verdict_id :=
    NULLIF(v_context#>>'{directionVerdict,id}', '')::UUID;
  NEW.direction_verdict := v_context->'directionVerdict';
  NEW.thesis_validation := v_context->'thesisValidity';
  NEW.entry_confirmation := v_context->'entryConfirmation';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_pending_decision_context
  ON public.pending_orders;
CREATE TRIGGER populate_pending_decision_context
  BEFORE INSERT OR UPDATE OF signal_reason, final_authorization, decision_context
  ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_pending_decision_context();

CREATE OR REPLACE FUNCTION public.populate_position_decision_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_context JSONB;
BEGIN
  v_context := COALESCE(
    NEW.final_authorization->'decisionContext',
    NEW.decision_context
  );
  IF v_context IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.decision_context := v_context;
  NEW.game_plan_id :=
    NULLIF(v_context#>>'{gamePlan,id}', '')::UUID;
  NEW.game_plan_version :=
    NULLIF(v_context#>>'{gamePlan,version}', '')::UUID;
  NEW.direction_verdict_id :=
    NULLIF(v_context#>>'{directionVerdict,id}', '')::UUID;
  NEW.direction_verdict := v_context->'directionVerdict';
  NEW.thesis_validation := v_context->'thesisValidity';
  NEW.entry_confirmation := v_context->'entryConfirmation';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_position_decision_context
  ON public.paper_positions;
CREATE TRIGGER populate_position_decision_context
  BEFORE INSERT OR UPDATE OF final_authorization, decision_context
  ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.populate_position_decision_context();

UPDATE public.pending_orders
   SET decision_context = COALESCE(
     final_authorization->'decisionContext',
     CASE
       WHEN jsonb_typeof(signal_reason) = 'string'
         THEN ((signal_reason #>> '{}')::JSONB)->'decisionContext'
       ELSE signal_reason->'decisionContext'
     END
   )
 WHERE decision_context IS NULL
   AND COALESCE(
     final_authorization->'decisionContext',
     CASE
       WHEN jsonb_typeof(signal_reason) = 'string'
         THEN ((signal_reason #>> '{}')::JSONB)->'decisionContext'
       ELSE signal_reason->'decisionContext'
     END
   ) IS NOT NULL;

UPDATE public.paper_positions
   SET decision_context = final_authorization->'decisionContext'
 WHERE decision_context IS NULL
   AND final_authorization->'decisionContext' IS NOT NULL;

REVOKE ALL ON FUNCTION public.populate_pending_decision_context()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.populate_position_decision_context()
  FROM PUBLIC;