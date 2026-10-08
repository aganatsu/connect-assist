-- STEP 17-A — the order-lifecycle trigger records the fill-sizing record on the fill event.
--
-- One change to public.pending_orders_attribution() (from 20261008010000): the
-- terminal event written when an order FILLS now carries `fill_sizing` in its
-- detail. For dry-run fills that record includes the Step 17-A fill-floor
-- re-anchor: planned stop / target, fill price, re-anchored stop / target,
-- floor pips, fill → planned-stop distance, R geometry, risk dollars, and the
-- status (reanchored / not_needed / rejected + reason). trade_attribution
-- section F still records the geometry actually used (fill_stop_price =
-- the re-anchored stop); section B keeps the plan. No column, table or other
-- function changes; cancel / expiry events are unchanged.

CREATE OR REPLACE FUNCTION public.pending_orders_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_terminal text;
  v_event text;
  v_fs jsonb;
  v_linked uuid;
BEGIN
  IF NEW.signal_id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      UPDATE public.trade_attribution
         SET order_id = NEW.order_id, pending_order_row_id = NEW.id, order_placed_at = NEW.placed_at
       WHERE signal_id = NEW.signal_id AND order_id IS NULL;
      PERFORM public.ta_event(NEW.signal_id, 'order_inserted', 'pending_orders',
        jsonb_build_object('order_id', NEW.order_id, 'dry_run', NEW.dry_run), 'insert');
      RETURN NEW;
    END IF;

    -- same-level refresh: the live order's geometry changed; the plan (A–D) cannot
    IF NEW.status IN ('pending', 'awaiting_confirmation')
       AND (NEW.stop_loss, NEW.take_profit, NEW.size, NEW.entry_price)
           IS DISTINCT FROM (OLD.stop_loss, OLD.take_profit, OLD.size, OLD.entry_price) THEN
      PERFORM public.ta_event(NEW.signal_id, 'refreshed_in_place', 'pending_orders', jsonb_build_object(
        'old', jsonb_build_object('entry', OLD.entry_price, 'stop', OLD.stop_loss, 'target', OLD.take_profit, 'size', OLD.size),
        'new', jsonb_build_object('entry', NEW.entry_price, 'stop', NEW.stop_loss, 'target', NEW.take_profit, 'size', NEW.size),
        'signal_score', NEW.signal_score));
    END IF;

    IF NEW.zone_touch_time IS NOT NULL AND NEW.zone_touch_time IS DISTINCT FROM OLD.zone_touch_time THEN
      UPDATE public.trade_attribution SET touched_at = NEW.zone_touch_time
       WHERE signal_id = NEW.signal_id AND touched_at IS NULL;
      PERFORM public.ta_event(NEW.signal_id, 'touched', 'pending_orders', jsonb_build_object('at', NEW.zone_touch_time));
    END IF;
    IF OLD.status = 'awaiting_confirmation' AND NEW.status = 'pending' THEN
      PERFORM public.ta_event(NEW.signal_id, 'reset', 'pending_orders', jsonb_build_object('reason', NEW.reset_reason));
    END IF;
    IF NEW.confirmation_accepted_at IS NOT NULL AND OLD.confirmation_accepted_at IS NULL THEN
      UPDATE public.trade_attribution
         SET confirmed_at = NEW.confirmation_accepted_at,
             confirmation = jsonb_build_object('tier', NEW.confirmation_tier, 'type', NEW.confirmation_type,
                                               'timeframe', NEW.confirmation_timeframe)
       WHERE signal_id = NEW.signal_id AND confirmed_at IS NULL;
      PERFORM public.ta_event(NEW.signal_id, 'confirmed', 'pending_orders', jsonb_build_object(
        'tier', NEW.confirmation_tier, 'type', NEW.confirmation_type, 'timeframe', NEW.confirmation_timeframe));
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('cancelled', 'expired', 'filled') THEN
      IF NEW.status = 'filled' THEN
        v_terminal := CASE WHEN NEW.dry_run THEN 'hypothetical_fill' ELSE 'filled' END;
        v_event := 'filled';
        v_fs := COALESCE(NEW.fill_sizing, NEW.dry_run_context -> 'fillSizing', '{}'::jsonb);
        UPDATE public.trade_attribution SET
          terminal_status = v_terminal, terminal_reason = COALESCE(NEW.terminal_reason, 'FILLED'),
          terminal_at = COALESCE(NEW.filled_at, now()),
          fill_kind = CASE WHEN NEW.dry_run THEN 'hypothetical' ELSE 'real' END,
          filled_at = COALESCE(NEW.filled_at, now()), fill_price = NEW.fill_price,
          fill_stop_price = NEW.stop_loss, fill_target_price = NEW.take_profit,
          fill_stop_distance_pips = NULLIF(v_fs ->> 'stopDistancePips', '')::numeric,
          fill_inside_floor = NULLIF(v_fs ->> 'insideFloor', '')::boolean,
          fill_uncapped_lots = NULLIF(v_fs ->> 'uncappedLots', '')::numeric,
          fill_lots = NULLIF(v_fs ->> 'lots', '')::numeric,
          fill_risk_usd = NULLIF(v_fs ->> 'riskUsdActual', '')::numeric,
          fill_risk_pct = NULLIF(v_fs ->> 'riskPercentActual', '')::numeric,
          fill_cap_reason = v_fs ->> 'capReason'
        WHERE signal_id = NEW.signal_id AND terminal_status IS NULL;
      ELSE
        SELECT superseded_by_signal_id INTO v_linked FROM public.trade_attribution WHERE signal_id = NEW.signal_id;
        v_terminal := CASE
          WHEN NEW.terminal_reason = 'CANCELLED_SUPERSEDED' AND v_linked IS NOT NULL THEN 'superseded'
          WHEN NEW.status = 'expired' OR NEW.terminal_reason LIKE 'EXPIRED%' THEN 'expired'
          WHEN NEW.terminal_reason = 'CANCELLED_POSITION_CAP' THEN 'blocked_caps'
          WHEN NEW.terminal_reason IN ('CANCELLED_SL_INVALIDATION', 'CANCELLED_IMPULSE_BROKEN', 'CANCELLED_ZONE_EXIT',
                                       'CANCELLED_DIRECTION_FLIP', 'CANCELLED_THESIS_FOTSI', 'CANCELLED_REFINED_ZONE_FAILURE')
               OR NEW.thesis_cancel_reason IS NOT NULL THEN 'invalidated'
          ELSE 'cancelled' END;
        v_event := CASE WHEN v_terminal = 'superseded' THEN 'superseded' WHEN v_terminal = 'expired' THEN 'expired' ELSE 'cancelled' END;
        UPDATE public.trade_attribution SET
          terminal_status = v_terminal, terminal_reason = NEW.terminal_reason, terminal_at = COALESCE(NEW.resolved_at, now())
        WHERE signal_id = NEW.signal_id AND terminal_status IS NULL;
      END IF;
      PERFORM public.ta_event(NEW.signal_id, v_event, 'pending_orders', jsonb_build_object(
        'status', NEW.status, 'terminal_reason', NEW.terminal_reason, 'cancel_reason', NEW.cancel_reason)
        -- Step 17-A: a fill's event carries the fill-sizing record, incl. the dry-run re-anchor
        -- (planned stop, fill, re-anchored stop / target, floor, R geometry, risk dollars).
        || CASE WHEN NEW.status = 'filled' THEN jsonb_build_object('fill_sizing', v_fs) ELSE '{}'::jsonb END, 'terminal');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pending_orders_attribution(%): % — order write kept, attribution skipped', NEW.order_id, SQLERRM;
  END;
  RETURN NEW;
END $function$;

