-- Phase 1 — One execution authority: complete atomic entry coverage.
--
-- Pending fills were made atomic in 20260728160000. This migration adds the
-- equivalent database boundary for immediate market entries and extends the
-- active-pending uniqueness rule to the awaiting-confirmation state.

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS source_candidate_key TEXT,
  ADD COLUMN IF NOT EXISTS final_authorization JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_positions_candidate_source
  ON public.paper_positions (user_id, bot_id, source_candidate_key)
  WHERE source_candidate_key IS NOT NULL;

DROP INDEX IF EXISTS public.idx_pending_orders_unique_active;
CREATE UNIQUE INDEX idx_pending_orders_unique_active
  ON public.pending_orders (user_id, bot_id, symbol, direction)
  WHERE status IN ('pending', 'awaiting_confirmation');

CREATE OR REPLACE FUNCTION public.persist_pending_fill_authorization()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'filled' AND NEW.final_authorization IS NOT NULL THEN
    UPDATE public.paper_positions
       SET final_authorization = NEW.final_authorization
     WHERE source_pending_order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS persist_pending_fill_authorization
  ON public.pending_orders;
CREATE TRIGGER persist_pending_fill_authorization
  AFTER UPDATE OF status, final_authorization ON public.pending_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.persist_pending_fill_authorization();

REVOKE ALL ON FUNCTION public.persist_pending_fill_authorization()
  FROM PUBLIC;

UPDATE public.paper_positions AS position
   SET final_authorization = pending.final_authorization
  FROM public.pending_orders AS pending
 WHERE position.source_pending_order_id = pending.id
   AND position.final_authorization IS NULL
   AND pending.final_authorization IS NOT NULL;

CREATE OR REPLACE FUNCTION public.finalize_market_entry(
  p_user_id UUID,
  p_bot_id TEXT,
  p_source_candidate_key TEXT,
  p_position JSONB,
  p_authorization JSONB,
  p_max_open_positions INTEGER,
  p_max_per_symbol INTEGER,
  p_allow_same_direction BOOLEAN,
  p_close_on_reverse BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account public.paper_accounts%ROWTYPE;
  v_position_uuid UUID;
  v_symbol TEXT := p_position->>'symbol';
  v_direction TEXT := p_position->>'direction';
  v_entry NUMERIC := (p_position->>'entry_price')::NUMERIC;
  v_stop NUMERIC := (p_position->>'stop_loss')::NUMERIC;
  v_target NUMERIC := (p_position->>'take_profit')::NUMERIC;
  v_open_count INTEGER;
  v_symbol_count INTEGER;
  v_same_direction_count INTEGER;
BEGIN
  IF COALESCE((p_authorization->>'authorized')::BOOLEAN, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'authorization_missing',
      'reason', 'A successful final authorization decision is required'
    );
  END IF;

  IF NULLIF(p_source_candidate_key, '') IS NULL THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'candidate_key_missing',
      'reason', 'A stable source candidate key is required'
    );
  END IF;

  IF v_symbol IS NULL OR v_direction NOT IN ('long', 'short')
     OR v_entry IS NULL OR v_entry <= 0
     OR v_stop IS NULL OR v_stop <= 0
     OR v_target IS NULL OR v_target <= 0 THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_price',
      'reason', 'Symbol, direction, entry, stop-loss and take-profit must be valid'
    );
  END IF;

  IF (v_direction = 'long' AND NOT (v_stop < v_entry AND v_target > v_entry))
     OR (v_direction = 'short' AND NOT (v_stop > v_entry AND v_target < v_entry)) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_orientation',
      'reason', 'SL/TP orientation does not match the trade direction'
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
  IF v_account.execution_mode NOT IN ('paper', 'live') THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'execution_mode',
      'reason', 'Account execution mode is invalid'
    );
  END IF;

  -- Account locking serializes all immediate entries for this user. When
  -- close-on-reverse is enabled, the position being replaced is excluded from
  -- capacity counts, but an already-open same-direction position is not.
  SELECT COUNT(*)
    INTO v_open_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
     AND NOT (
       COALESCE(p_close_on_reverse, false)
       AND symbol = v_symbol
       AND direction <> v_direction
     );

  IF v_open_count >= GREATEST(COALESCE(p_max_open_positions, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_positions',
      'reason', format(
        'Max open positions reached (%s/%s)',
        v_open_count,
        p_max_open_positions
      )
    );
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE direction = v_direction)
    INTO v_symbol_count, v_same_direction_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
     AND symbol = v_symbol
     AND NOT (
       COALESCE(p_close_on_reverse, false)
       AND direction <> v_direction
     );

  IF v_same_direction_count > 0
     AND NOT COALESCE(p_allow_same_direction, false) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'duplicate_direction',
      'reason', format(
        'An open %s position already exists for %s',
        v_direction,
        v_symbol
      )
    );
  END IF;

  IF v_symbol_count >= GREATEST(COALESCE(p_max_per_symbol, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_per_symbol',
      'reason', format(
        'Max positions for %s reached (%s/%s)',
        v_symbol,
        v_symbol_count,
        p_max_per_symbol
      )
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
    source_candidate_key,
    final_authorization
  ) VALUES (
    p_user_id,
    p_position->>'position_id',
    v_symbol,
    v_direction,
    p_position->>'size',
    v_entry,
    COALESCE((p_position->>'current_price')::NUMERIC, v_entry),
    v_stop,
    v_target,
    COALESCE(p_position->>'open_time', now()::TEXT),
    COALESCE(p_position->'signal_reason', '{}'::JSONB)::TEXT,
    COALESCE(p_position->>'signal_score', '0'),
    p_position->>'order_id',
    'open',
    p_bot_id,
    p_source_candidate_key,
    p_authorization
  )
  RETURNING id INTO v_position_uuid;

  RETURN jsonb_build_object(
    'filled', true,
    'code', 'filled',
    'position_id', p_position->>'position_id',
    'position_uuid', v_position_uuid
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'already_filled',
      'reason', 'A position already exists for this market candidate'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_market_entry(
  UUID, TEXT, TEXT, JSONB, JSONB, INTEGER, INTEGER, BOOLEAN, BOOLEAN
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_market_entry(
  UUID, TEXT, TEXT, JSONB, JSONB, INTEGER, INTEGER, BOOLEAN, BOOLEAN
) TO service_role;
