-- URGENT: closed trades were disappearing from paper_trade_history.
--
--   ERROR: invalid streamlined decision origin
--
-- The close path in bot-scanner runs in this order:
--   1. DELETE the paper_positions row
--   2. INSERT into paper_trade_history   <- raised here
--   3. UPDATE paper_accounts balance     <- still ran
--
-- The insert error is not captured, so step 2 failed silently and step 3
-- carried on. The symptom is exactly what was reported: the balance moves, the
-- trade is gone from history, and the close is only visible in close_audit_log.
--
-- Cause: freeze_streamlined_decision_origin() requires contractVersion
-- 'streamlined-decision-lifecycle.v1', and PR #539 began copying the position's
-- frozen_strategy_context ('frozen-decision.v1') into streamlined_decision_origin.
-- Third table hit by the same mistake, after pending_orders and paper_positions
-- in 20260916000000.
--
-- This IGNORES the foreign contract instead of refusing the row. Losing the
-- decision record is recoverable; losing the trade is not, because the position
-- row is already deleted by then. bot-scanner is fixed separately to stop
-- writing the wrong column and to check the insert error.
--
-- Body copied verbatim from the baseline with that one change.

CREATE OR REPLACE FUNCTION public.freeze_streamlined_decision_origin()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  -- frozen-decision.v1 is NOT a streamlined decision origin. PR #539 copied the
  -- position's frozen_strategy_context into this column, and this trigger
  -- RAISEd on it -- silently, because the insert error is unchecked -- while the
  -- close path had ALREADY deleted the paper_positions row. Closed trades
  -- vanished from history with the balance still updated. Ignore it rather than
  -- refuse the row: losing the decision record is recoverable, losing the trade
  -- is not.
  IF payload->>'contractVersion' = 'frozen-decision.v1' THEN
    NEW.streamlined_decision_origin := NULL;
    NEW.streamlined_decision_frozen_at := NULL;
    RETURN NEW;
  END IF;
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
END $function$;
