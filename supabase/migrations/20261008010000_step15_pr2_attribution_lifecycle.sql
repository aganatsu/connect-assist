-- STEP 15 PR 2 — order / position lifecycle attribution + atomic Route 2 placement.
--
-- 1. pending_orders_attribution (AFTER INSERT OR UPDATE): for an attributed
--    order (signal_id set) records the lifecycle in trade_attribution
--    (write-once E/F columns) and trade_attribution_events:
--      insert → order_inserted · geometry change while live → refreshed_in_place
--      zone_touch_time set → touched · awaiting → pending → reset
--      confirmation_accepted_at set → confirmed
--      status → cancelled / expired / filled → terminal (+ fill section F)
-- 2. paper_positions_attribution (AFTER INSERT OR DELETE): position link;
--    a delete with no ledger close → position_deleted_unsettled event.
-- 3. route2_place_order(attribution, order, supersede): ONE transaction that
--    inserts the attribution row (A–D), links and cancels the superseded
--    order(s) in both directions, and inserts the new order with the same
--    signal_id. A duplicate (unique active order) rolls all of it back and
--    reports the existing order's signal_id.
--
-- Attribution can never block trading:
--   * both triggers are exception-safe — a failure is swallowed (RAISE WARNING),
--     the order / position write always proceeds;
--   * route2_place_order inserts the attribution row inside a savepoint; if it
--     fails, the order is placed WITHOUT signal_id (legacy) and the error is
--     returned.
-- Legacy rows (signal_id NULL) are untouched by every path here.
-- SECURITY DEFINER on the triggers: a cancel issued by a signed-in user (UI)
-- must still record its terminal state, and client roles cannot write
-- attribution.

-- ── 1. order lifecycle ──────────────────────────────────────────────────────
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
        'status', NEW.status, 'terminal_reason', NEW.terminal_reason, 'cancel_reason', NEW.cancel_reason), 'terminal');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pending_orders_attribution(%): % — order write kept, attribution skipped', NEW.order_id, SQLERRM;
  END;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS pending_orders_attribution ON public.pending_orders;
CREATE TRIGGER pending_orders_attribution AFTER INSERT OR UPDATE ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.pending_orders_attribution();

-- ── 2. position lifecycle ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.paper_positions_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.signal_id IS NOT NULL THEN
        UPDATE public.trade_attribution SET position_row_id = NEW.id, position_id = NEW.position_id
         WHERE signal_id = NEW.signal_id AND position_row_id IS NULL;
        PERFORM public.ta_event(NEW.signal_id, 'position_opened', 'paper_positions',
          jsonb_build_object('position_id', NEW.position_id, 'size', NEW.size, 'entry_price', NEW.entry_price), 'opened');
      END IF;
      RETURN NEW;
    END IF;
    -- DELETE: settle_paper_position posts the ledger close before deleting.
    IF OLD.signal_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.paper_account_ledger
          WHERE position_row_id = OLD.id AND kind IN ('close', 'pre_epoch_close')) THEN
      PERFORM public.ta_event(OLD.signal_id, 'position_deleted_unsettled', 'paper_positions',
        jsonb_build_object('position_id', OLD.position_id), 'deleted');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'paper_positions_attribution: % — position write kept, attribution skipped', SQLERRM;
  END;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $function$;

DROP TRIGGER IF EXISTS paper_positions_attribution ON public.paper_positions;
CREATE TRIGGER paper_positions_attribution AFTER INSERT OR DELETE ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.paper_positions_attribution();

-- ── 3. atomic Route 2 placement ─────────────────────────────────────────────
-- p_attribution  trade_attribution row (A–D); NULL / no signal_id → legacy order
-- p_order        pending_orders row WITHOUT signal_id (forced here)
-- p_supersede    [{ "order_id": "...", "cancel_reason": "..." }] — live 'pending'
--                orders for the same symbol + direction being replaced
-- Returns { outcome: placed | duplicate, order_row_id, signal_id,
--           attribution: written | none | failed, attribution_error,
--           superseded: [order_id…], existing_order_id, existing_signal_id }
-- Any other error (entries lock, constraint) raises and rolls back everything,
-- exactly as a failed insert did before.
CREATE OR REPLACE FUNCTION public.route2_place_order(p_attribution jsonb, p_order jsonb, p_supersede jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  v_sig uuid := NULLIF(p_attribution ->> 'signal_id', '')::uuid;
  v_attr jsonb;
  v_attr_state text := 'none';
  v_attr_err text;
  v_order jsonb;
  v_cols text;
  v_bad text;
  v_old record;
  v_old_sigs uuid[] := '{}';
  v_superseded text[] := '{}';
  v_row_id uuid;
  v_user uuid := (p_order ->> 'user_id')::uuid;
  v_bot text := COALESCE(p_order ->> 'bot_id', 'smc');
  v_existing record;
BEGIN
  IF v_user IS NULL OR (p_order ->> 'symbol') IS NULL OR (p_order ->> 'direction') IS NULL THEN
    RAISE EXCEPTION 'route2_place_order: order user_id, symbol and direction are required';
  END IF;
  v_order := p_order - 'signal_id' - 'id';
  SELECT string_agg(k, ', ') INTO v_bad FROM jsonb_object_keys(v_order) k
   WHERE k NOT IN (SELECT column_name FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'pending_orders' AND is_generated = 'NEVER');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'route2_place_order: not writable pending_orders columns: %', v_bad;
  END IF;

  BEGIN
    -- the orders being replaced, and their signal ids (for the immutable back-link)
    FOR v_old IN
      SELECT o.order_id, o.signal_id, s.value ->> 'cancel_reason' AS cancel_reason
        FROM jsonb_array_elements(COALESCE(p_supersede, '[]'::jsonb)) s
        JOIN public.pending_orders o
          ON o.order_id = s.value ->> 'order_id' AND o.user_id = v_user AND COALESCE(o.bot_id, 'smc') = v_bot
         AND o.symbol = p_order ->> 'symbol' AND o.direction = p_order ->> 'direction' AND o.status = 'pending'
    LOOP
      v_superseded := v_superseded || v_old.order_id;
      IF v_old.signal_id IS NOT NULL THEN v_old_sigs := v_old_sigs || v_old.signal_id; END IF;
    END LOOP;

    -- A–D, inside a savepoint: a bad attribution row never stops the order
    IF v_sig IS NOT NULL THEN
      v_attr := p_attribution || jsonb_build_object('supersedes_signal_ids', to_jsonb(v_old_sigs));
      BEGIN
        SELECT string_agg(format('%I', k), ', ') INTO v_cols FROM jsonb_object_keys(v_attr) k;
        EXECUTE format('INSERT INTO public.trade_attribution (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.trade_attribution, $1)', v_cols)
          USING v_attr;
        v_attr_state := 'written';
      EXCEPTION WHEN OTHERS THEN
        v_attr_state := 'failed'; v_attr_err := SQLERRM; v_sig := NULL;
      END;
    END IF;

    -- supersede: link both directions, then cancel exactly as before
    FOR v_old IN
      SELECT o.order_id, o.signal_id, s.value ->> 'cancel_reason' AS cancel_reason
        FROM jsonb_array_elements(COALESCE(p_supersede, '[]'::jsonb)) s
        JOIN public.pending_orders o
          ON o.order_id = s.value ->> 'order_id' AND o.user_id = v_user AND COALESCE(o.bot_id, 'smc') = v_bot
         AND o.symbol = p_order ->> 'symbol' AND o.direction = p_order ->> 'direction' AND o.status = 'pending'
    LOOP
      IF v_sig IS NOT NULL AND v_old.signal_id IS NOT NULL THEN
        BEGIN
          UPDATE public.trade_attribution SET superseded_by_signal_id = v_sig
           WHERE signal_id = v_old.signal_id AND superseded_by_signal_id IS NULL;
        EXCEPTION WHEN OTHERS THEN NULL;  -- the link is best-effort; the cancel is not
        END;
      END IF;
      UPDATE public.pending_orders
         SET status = 'cancelled', terminal_reason = 'CANCELLED_SUPERSEDED', resolved_at = now(),
             cancel_reason = v_old.cancel_reason
       WHERE order_id = v_old.order_id AND user_id = v_user AND status = 'pending';
    END LOOP;

    -- the new order, carrying the same signal_id
    v_order := v_order || CASE WHEN v_sig IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('signal_id', v_sig) END;
    SELECT string_agg(format('%I', k), ', ') INTO v_cols FROM jsonb_object_keys(v_order) k;
    EXECUTE format('INSERT INTO public.pending_orders (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.pending_orders, $1) RETURNING id', v_cols)
      USING v_order INTO v_row_id;
  EXCEPTION WHEN unique_violation THEN
    -- an order for this symbol + direction is already live: nothing above is kept
    SELECT order_id, signal_id INTO v_existing FROM public.pending_orders
     WHERE user_id = v_user AND COALESCE(bot_id, 'smc') = v_bot
       AND symbol = p_order ->> 'symbol' AND direction = p_order ->> 'direction'
       AND status IN ('pending', 'awaiting_confirmation')
     LIMIT 1;
    RETURN jsonb_build_object('outcome', 'duplicate', 'error', SQLERRM,
      'existing_order_id', v_existing.order_id, 'existing_signal_id', v_existing.signal_id);
  END;

  RETURN jsonb_build_object('outcome', 'placed', 'order_row_id', v_row_id, 'signal_id', v_sig,
    'attribution', v_attr_state, 'attribution_error', v_attr_err, 'superseded', to_jsonb(v_superseded));
END $function$;

REVOKE ALL ON FUNCTION public.route2_place_order(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.route2_place_order(jsonb, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.pending_orders_attribution() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.paper_positions_attribution() FROM PUBLIC, anon, authenticated;
