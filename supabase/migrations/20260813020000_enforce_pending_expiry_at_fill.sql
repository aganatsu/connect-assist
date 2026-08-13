-- Keep confirmed pending-order fills atomic and reject expired authority.
--
-- Deployment order:
--   1. Apply this migration.
--   2. Deploy bot-scanner and zone-confirmation-scanner.
--
-- The RPC holds a row lock on the pending order, rechecks account execution
-- state inside the same transaction, inserts one paper position, and only then
-- marks the pending order filled. A second scanner waits for the lock and
-- receives an already_resolved response without inserting or mirroring again.

CREATE OR REPLACE FUNCTION public.finalize_pending_order_fill(
  p_pending_id UUID,
  p_user_id UUID,
  p_bot_id TEXT,
  p_fill_price NUMERIC,
  p_current_price NUMERIC,
  p_position_order_id TEXT,
  p_signal_reason JSONB,
  p_fill_reason TEXT,
  p_authorization JSONB,
  p_max_open_positions INTEGER,
  p_max_per_symbol INTEGER,
  p_allow_same_direction BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending public.pending_orders%ROWTYPE;
  v_account public.paper_accounts%ROWTYPE;
  v_position_uuid UUID;
  v_open_count INTEGER;
  v_symbol_count INTEGER;
  v_same_direction_count INTEGER;
BEGIN
  SELECT *
    INTO v_pending
    FROM public.pending_orders
   WHERE id = p_pending_id
     AND user_id = p_user_id
     AND bot_id = p_bot_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'order_not_found',
      'reason', 'Pending order was not found'
    );
  END IF;

  IF v_pending.status <> 'awaiting_confirmation' THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'already_resolved',
      'reason', format('Pending order status is %s', v_pending.status)
    );
  END IF;

  IF v_pending.expires_at IS NOT NULL AND v_pending.expires_at <= now() THEN
    UPDATE public.pending_orders
       SET status = 'expired',
           cancel_reason = 'TTL expired before confirmation fill',
           resolved_at = now()
     WHERE id = v_pending.id;
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'order_expired',
      'reason', 'Pending order expired before confirmation fill'
    );
  END IF;

  SELECT *
    INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'account_missing',
      'reason', 'Execution account is unavailable'
    );
  END IF;

  IF v_account.kill_switch_active THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'kill_switch',
      'reason', 'Kill switch is active'
    );
  END IF;

  IF NOT v_account.is_running THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'bot_stopped',
      'reason', 'Bot is stopped'
    );
  END IF;

  IF v_account.is_paused THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'bot_paused',
      'reason', 'Bot is paused'
    );
  END IF;

  -- The account row lock serializes fills for this user. Counts below are
  -- therefore checked against the result of any fill that committed while
  -- this transaction was waiting, closing the two-order race as well as the
  -- two-scanner race.
  SELECT COUNT(*)
    INTO v_open_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open';

  IF v_open_count >= GREATEST(COALESCE(p_max_open_positions, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_positions',
      'reason', format('Max open positions reached (%s/%s)', v_open_count, p_max_open_positions)
    );
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE direction = v_pending.direction)
    INTO v_symbol_count, v_same_direction_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
     AND symbol = v_pending.symbol;

  IF v_same_direction_count > 0 AND NOT COALESCE(p_allow_same_direction, false) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'duplicate_direction',
      'reason', format('An open %s position already exists for %s', v_pending.direction, v_pending.symbol)
    );
  END IF;

  IF v_symbol_count >= GREATEST(COALESCE(p_max_per_symbol, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_per_symbol',
      'reason', format('Max positions for %s reached (%s/%s)', v_pending.symbol, v_symbol_count, p_max_per_symbol)
    );
  END IF;

  IF p_fill_price IS NULL OR p_fill_price <= 0
     OR v_pending.stop_loss IS NULL OR v_pending.stop_loss <= 0
     OR v_pending.take_profit IS NULL OR v_pending.take_profit <= 0 THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_price',
      'reason', 'Entry, stop-loss and take-profit must be positive'
    );
  END IF;

  IF (v_pending.direction = 'long'
      AND NOT (v_pending.stop_loss < p_fill_price AND v_pending.take_profit > p_fill_price))
     OR (v_pending.direction = 'short'
      AND NOT (v_pending.stop_loss > p_fill_price AND v_pending.take_profit < p_fill_price)) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_orientation',
      'reason', 'SL/TP orientation does not match the trade direction'
    );
  END IF;

  INSERT INTO public.paper_positions (
    user_id,
    position_id,
    symbol,
    direction,
    size,
    entry_price,
    current_price,
    stop_loss,
    take_profit,
    open_time,
    signal_reason,
    signal_score,
    order_id,
    position_status,
    bot_id,
    order_type,
    trigger_price,
    source_pending_order_id
  ) VALUES (
    p_user_id,
    v_pending.order_id,
    v_pending.symbol,
    v_pending.direction,
    v_pending.size,
    p_fill_price,
    COALESCE(p_current_price, p_fill_price),
    v_pending.stop_loss,
    v_pending.take_profit,
    now()::TEXT,
    COALESCE(p_signal_reason, '{}'::JSONB)::TEXT,
    COALESCE(v_pending.signal_score, 0),
    p_position_order_id,
    'open',
    p_bot_id,
    v_pending.order_type,
    v_pending.entry_price,
    v_pending.id
  )
  RETURNING id INTO v_position_uuid;

  UPDATE public.pending_orders
     SET status = 'filled',
         fill_reason = p_fill_reason,
         final_authorization = p_authorization,
         filled_at = now(),
         resolved_at = now()
   WHERE id = v_pending.id;

  RETURN jsonb_build_object(
    'filled', true,
    'code', 'filled',
    'position_id', v_pending.order_id,
    'position_uuid', v_position_uuid
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'already_filled',
      'reason', 'A position already exists for this pending order'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_pending_order_fill(
  UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, JSONB, TEXT, JSONB, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_pending_order_fill(
  UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, JSONB, TEXT, JSONB, INTEGER, INTEGER, BOOLEAN
) TO service_role;
