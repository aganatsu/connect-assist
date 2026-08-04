-- Keep Watchlist and Zone Setup lifecycle aligned with confirmed live broker state.

CREATE OR REPLACE FUNCTION public.sync_staged_setup_from_live_position_state()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
BEGIN
  IF NEW.staged_setup_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.position_status = $s$open$s$ THEN
    UPDATE public.staged_setups SET status = $s$filled$s$,
      lifecycle_reason = $s$Broker-confirmed position opened$s$, position_id = NEW.id,
      authorization_result = COALESCE(NEW.final_authorization, authorization_result),
      resolved_at = COALESCE(resolved_at, now()), updated_at = now()
    WHERE id = NEW.staged_setup_id;
  ELSE
    UPDATE public.staged_setups SET status = $s$pending$s$,
      lifecycle_reason = CASE NEW.broker_execution_state
        WHEN $s$reconciliation_required$s$ THEN $s$Broker outcome requires reconciliation$s$
        WHEN $s$rejected$s$ THEN $s$No broker confirmed the live order$s$
        ELSE $s$Live order submitted; awaiting broker confirmation$s$ END,
      position_id = NEW.id, resolved_at = NULL, updated_at = now()
    WHERE id = NEW.staged_setup_id;
  END IF;
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS zz_sync_staged_setup_from_live_position_state ON public.paper_positions;
CREATE TRIGGER zz_sync_staged_setup_from_live_position_state
  AFTER INSERT OR UPDATE OF position_status, broker_execution_state ON public.paper_positions
  FOR EACH ROW WHEN (NEW.staged_setup_id IS NOT NULL)
  EXECUTE FUNCTION public.sync_staged_setup_from_live_position_state();

CREATE OR REPLACE FUNCTION public.hold_staged_setup_until_live_broker_confirmation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
DECLARE v_position public.paper_positions%ROWTYPE;
BEGIN
  IF NEW.staged_setup_id IS NULL OR NEW.status <> $s$filled$s$ THEN RETURN NEW; END IF;
  SELECT * INTO v_position FROM public.paper_positions
   WHERE source_pending_order_id = NEW.id ORDER BY open_time DESC LIMIT 1;
  IF FOUND AND v_position.position_status <> $s$open$s$ THEN
    UPDATE public.staged_setups SET status = $s$pending$s$,
      lifecycle_reason = CASE v_position.broker_execution_state
        WHEN $s$reconciliation_required$s$ THEN $s$Broker outcome requires reconciliation$s$
        WHEN $s$rejected$s$ THEN $s$No broker confirmed the live order$s$
        ELSE $s$Live order submitted; awaiting broker confirmation$s$ END,
      position_id = v_position.id, pending_order_id = NEW.id,
      resolved_at = NULL, updated_at = now()
    WHERE id = NEW.staged_setup_id;
  END IF;
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS zz_hold_staged_setup_until_live_broker_confirmation ON public.pending_orders;
CREATE TRIGGER zz_hold_staged_setup_until_live_broker_confirmation
  AFTER INSERT OR UPDATE OF status ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.hold_staged_setup_until_live_broker_confirmation();

REVOKE ALL ON FUNCTION public.sync_staged_setup_from_live_position_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hold_staged_setup_until_live_broker_confirmation() FROM PUBLIC;
