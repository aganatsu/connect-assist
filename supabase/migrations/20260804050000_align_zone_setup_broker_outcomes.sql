-- Make Zone Setup terminal status reflect the actual live broker outcome.

ALTER TABLE public.pending_orders DROP CONSTRAINT IF EXISTS pending_orders_status_check;
ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_status_check
  CHECK (status IN (
    $s$pending$s$, $s$awaiting_confirmation$s$, $s$filled$s$,
    $s$reconciliation_required$s$, $s$broker_rejected$s$,
    $s$invalidated$s$, $s$expired$s$, $s$cancelled$s$
  ));

CREATE OR REPLACE FUNCTION public.sync_staged_setup_from_pending()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
DECLARE v_reason TEXT; v_staged_status TEXT;
BEGIN
  IF NEW.staged_setup_id IS NULL THEN RETURN NEW; END IF;
  v_reason := COALESCE(NEW.fill_reason, NEW.cancel_reason, format($s$Pending order moved to %s$s$, NEW.status));
  v_staged_status := CASE
    WHEN NEW.status IN ($s$reconciliation_required$s$, $s$broker_rejected$s$) THEN $s$pending$s$
    ELSE NEW.status
  END;
  UPDATE public.staged_setups SET status = v_staged_status,
    lifecycle_reason = v_reason, pending_order_id = NEW.id,
    authorization_result = COALESCE(NEW.final_authorization, authorization_result),
    originating_zone = COALESCE(NEW.originating_zone, originating_zone),
    confirmation_method = COALESCE(NEW.confirmation_method, confirmation_method),
    confirmation_config = COALESCE(NEW.confirmation_config, confirmation_config),
    resolved_at = CASE WHEN NEW.status IN ($s$filled$s$, $s$invalidated$s$, $s$expired$s$, $s$cancelled$s$)
      THEN COALESCE(resolved_at, now()) ELSE NULL END,
    updated_at = now()
  WHERE id = NEW.staged_setup_id;
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION public.finalize_live_broker_position(p_user_id UUID, p_bot_id TEXT, p_position_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
DECLARE v_success_ids UUID[]; v_unresolved_count INTEGER; v_error TEXT; v_state TEXT; v_position_uuid UUID;
BEGIN
  SELECT COALESCE(array_agg(broker_connection_id) FILTER (WHERE status = $s$succeeded$s$), ARRAY[]::UUID[]),
    COUNT(*) FILTER (WHERE status IN ($s$attempting$s$, $s$uncertain$s$)),
    string_agg(last_error, $s$; $s$ ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL)
  INTO v_success_ids, v_unresolved_count, v_error FROM public.broker_execution_ledger
  WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id AND action = $s$open$s$;

  IF cardinality(v_success_ids) > 0 THEN v_state := $s$confirmed$s$;
  ELSIF v_unresolved_count > 0 THEN v_state := $s$reconciliation_required$s$;
  ELSE v_state := $s$rejected$s$; END IF;

  UPDATE public.paper_positions SET
    position_status = CASE WHEN v_state = $s$confirmed$s$ THEN $s$open$s$ ELSE $s$pending$s$ END,
    broker_execution_state = v_state,
    broker_execution_error = CASE WHEN v_state = $s$confirmed$s$ THEN NULL
      ELSE COALESCE(v_error, CASE WHEN v_state = $s$rejected$s$ THEN $s$No broker confirmed the order$s$ ELSE $s$Broker outcome is uncertain$s$ END) END,
    broker_execution_updated_at = now(),
    mirrored_connection_ids = CASE WHEN v_state = $s$confirmed$s$ THEN v_success_ids ELSE mirrored_connection_ids END
  WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id
  RETURNING id INTO v_position_uuid;

  UPDATE public.pending_orders SET
    status = CASE WHEN v_state = $s$confirmed$s$ THEN $s$filled$s$
      WHEN v_state = $s$reconciliation_required$s$ THEN $s$reconciliation_required$s$
      ELSE $s$broker_rejected$s$ END,
    cancel_reason = CASE WHEN v_state = $s$confirmed$s$ THEN cancel_reason ELSE COALESCE(v_error, v_state) END,
    resolved_at = CASE WHEN v_state IN ($s$confirmed$s$, $s$rejected$s$) THEN now() ELSE NULL END
  WHERE id = (
    SELECT position.source_pending_order_id FROM public.paper_positions position
    WHERE position.id = v_position_uuid
  );

  RETURN jsonb_build_object($s$state$s$, v_state, $s$open$s$, v_state = $s$confirmed$s$,
    $s$mirrored_connection_ids$s$, to_jsonb(v_success_ids), $s$reason$s$, v_error);
END;
$body$;

REVOKE ALL ON FUNCTION public.sync_staged_setup_from_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_live_broker_position(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_live_broker_position(UUID, TEXT, TEXT) TO service_role;
