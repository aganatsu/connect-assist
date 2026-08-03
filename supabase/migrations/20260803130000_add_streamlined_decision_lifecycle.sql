-- Phases 3-8: immutable streamlined origin evidence plus refreshable current state.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['staged_setups','pending_orders','rejected_setups','paper_positions','paper_trade_history']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS streamlined_decision_origin JSONB', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS streamlined_decision_latest JSONB', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS streamlined_decision_frozen_at TIMESTAMPTZ', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.freeze_streamlined_decision_origin()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE row_data JSONB := to_jsonb(NEW); payload JSONB; signal JSONB := '{}'::JSONB;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.streamlined_decision_origin IS NOT NULL THEN
    IF NEW.streamlined_decision_origin IS DISTINCT FROM OLD.streamlined_decision_origin THEN
      RAISE EXCEPTION 'streamlined decision origin is immutable for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;
    NEW.streamlined_decision_frozen_at := OLD.streamlined_decision_frozen_at;
    RETURN NEW;
  END IF;
  BEGIN
    signal := CASE WHEN jsonb_typeof(row_data->'signal_reason') = 'object' THEN row_data->'signal_reason'
      WHEN jsonb_typeof(row_data->'signal_reason') = 'string' THEN (row_data->>'signal_reason')::JSONB
      ELSE '{}'::JSONB END;
  EXCEPTION WHEN OTHERS THEN signal := '{}'::JSONB; END;
  payload := COALESCE(
    NULLIF(NEW.streamlined_decision_origin, 'null'::JSONB),
    NULLIF(row_data->'raw_detail'->'streamlinedDecisionOrigin', 'null'::JSONB),
    NULLIF(row_data->'analysis_snapshot'->'streamlinedDecisionOrigin', 'null'::JSONB),
    NULLIF(signal->'streamlinedDecisionOrigin', 'null'::JSONB),
    CASE WHEN row_data->'raw_detail'->'streamlinedTradeDecision' IS NOT NULL THEN jsonb_build_object(
      'contractVersion','streamlined-decision-lifecycle.v1',
      'frozenAt',COALESCE(row_data->'raw_detail'->'streamlinedTradeDecision'->>'evaluatedAt',now()::TEXT),
      'candidateId',row_data->'raw_detail'->'streamlinedTradeDecision'->'identity'->>'candidateId',
      'originStage','rejected','summary',row_data->'raw_detail'->'streamlinedTradeDecision') END
  );
  IF payload IS NULL THEN RETURN NEW; END IF;
  IF payload->>'contractVersion' <> 'streamlined-decision-lifecycle.v1'
     OR payload->'summary'->>'contractVersion' <> 'streamlined-trade-decision.v1'
     OR COALESCE((payload->'summary'->>'observationOnly')::BOOLEAN,FALSE) IS NOT TRUE
     OR COALESCE((payload->'summary'->>'affectsAuthorization')::BOOLEAN,TRUE) IS NOT FALSE
     OR NULLIF(payload->>'candidateId','') IS NULL THEN
    RAISE EXCEPTION 'invalid streamlined decision origin';
  END IF;
  NEW.streamlined_decision_origin := payload;
  NEW.streamlined_decision_frozen_at := COALESCE((payload->>'frozenAt')::TIMESTAMPTZ, now());
  RETURN NEW;
END $$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['staged_setups','pending_orders','rejected_setups','paper_positions','paper_trade_history'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_freeze_streamlined_decision ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_freeze_streamlined_decision BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.freeze_streamlined_decision_origin()', t);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.streamlined_decision_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  certified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  runtime_targets TEXT[] NOT NULL DEFAULT ARRAY['paper']::TEXT[],
  styles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  minimum_comparable INTEGER NOT NULL DEFAULT 100 CHECK (minimum_comparable >= 100),
  comparable INTEGER NOT NULL DEFAULT 0 CHECK (comparable >= 0),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.streamlined_decision_certificates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own streamlined certificates"
  ON public.streamlined_decision_certificates;
CREATE POLICY "Users read own streamlined certificates"
  ON public.streamlined_decision_certificates FOR SELECT
  USING (auth.uid() = user_id);
