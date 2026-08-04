-- Live positions are not operationally open until broker execution is confirmed.
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS broker_execution_state TEXT NOT NULL DEFAULT $s$paper$s$,
  ADD COLUMN IF NOT EXISTS broker_execution_error TEXT,
  ADD COLUMN IF NOT EXISTS broker_execution_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS broker_close_state TEXT NOT NULL DEFAULT $s$none$s$,
  ADD COLUMN IF NOT EXISTS broker_close_error TEXT;
ALTER TABLE public.paper_positions DROP CONSTRAINT IF EXISTS paper_positions_broker_close_state_check;
ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_broker_close_state_check
  CHECK (broker_close_state IN ($s$none$s$, $s$pending$s$, $s$confirmed$s$, $s$reconciliation_required$s$));
ALTER TABLE public.paper_positions DROP CONSTRAINT IF EXISTS paper_positions_broker_execution_state_check;
ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_broker_execution_state_check
  CHECK (broker_execution_state IN ($s$paper$s$, $s$pending$s$, $s$confirmed$s$, $s$reconciliation_required$s$, $s$rejected$s$));

CREATE OR REPLACE FUNCTION public.initialize_live_broker_position()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
DECLARE v_mode TEXT;
BEGIN
  SELECT execution_mode INTO v_mode FROM public.paper_accounts
   WHERE user_id = NEW.user_id AND bot_id = NEW.bot_id;
  IF v_mode = $s$live$s$ THEN
    NEW.position_status := $s$pending$s$;
    NEW.broker_execution_state := $s$pending$s$;
    NEW.broker_execution_updated_at := now();
  ELSE
    NEW.position_status := $s$open$s$;
    NEW.broker_execution_state := $s$paper$s$;
  END IF;
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS initialize_live_broker_position ON public.paper_positions;
CREATE TRIGGER initialize_live_broker_position BEFORE INSERT ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.initialize_live_broker_position();

CREATE OR REPLACE FUNCTION public.finalize_live_broker_position(p_user_id UUID, p_bot_id TEXT, p_position_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
DECLARE v_success_ids UUID[]; v_unresolved_count INTEGER; v_error TEXT; v_state TEXT;
BEGIN
  SELECT COALESCE(array_agg(broker_connection_id) FILTER (WHERE status = $s$succeeded$s$), ARRAY[]::UUID[]),
    COUNT(*) FILTER (WHERE status IN ($s$attempting$s$, $s$uncertain$s$)),
    string_agg(last_error, $s$; $s$ ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL)
  INTO v_success_ids, v_unresolved_count, v_error
  FROM public.broker_execution_ledger
  WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id AND action = $s$open$s$;
  IF cardinality(v_success_ids) > 0 THEN
    v_state := $s$confirmed$s$;
    UPDATE public.paper_positions SET position_status = $s$open$s$, broker_execution_state = v_state,
      broker_execution_error = NULL, broker_execution_updated_at = now(), mirrored_connection_ids = v_success_ids
    WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id;
  ELSIF v_unresolved_count > 0 THEN
    v_state := $s$reconciliation_required$s$;
    UPDATE public.paper_positions SET position_status = $s$pending$s$, broker_execution_state = v_state,
      broker_execution_error = COALESCE(v_error, $s$Broker outcome is uncertain$s$), broker_execution_updated_at = now()
    WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id;
  ELSE
    v_state := $s$rejected$s$;
    UPDATE public.paper_positions SET position_status = $s$pending$s$, broker_execution_state = v_state,
      broker_execution_error = COALESCE(v_error, $s$No broker confirmed the order$s$), broker_execution_updated_at = now()
    WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id;
  END IF;
  RETURN jsonb_build_object($s$state$s$, v_state, $s$open$s$, v_state = $s$confirmed$s$,
    $s$mirrored_connection_ids$s$, to_jsonb(v_success_ids), $s$reason$s$, v_error);
END;
$body$;
REVOKE ALL ON FUNCTION public.initialize_live_broker_position() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_live_broker_position(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_live_broker_position(UUID, TEXT, TEXT) TO service_role;
