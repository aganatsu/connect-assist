-- Final paper-position closes must be one atomic, idempotent transaction.
-- Multiple pollers can observe the same SL/TP breach before either deletes the
-- position. Locking the source row ensures only one caller records P&L.

ALTER TABLE public.paper_trade_history
  ADD COLUMN IF NOT EXISTS bot_id TEXT NOT NULL DEFAULT 'smc',
  ADD COLUMN IF NOT EXISTS stop_loss NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS take_profit NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS source_position_row_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_trade_history_source_position
  ON public.paper_trade_history (source_position_row_id)
  WHERE source_position_row_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.paper_trade_history_duplicate_audit (
  duplicate_history_id UUID PRIMARY KEY,
  kept_history_id UUID NOT NULL,
  user_id UUID NOT NULL,
  bot_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  duplicate_pnl NUMERIC(20, 8) NOT NULL,
  duplicate_row JSONB NOT NULL,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.paper_trade_history_duplicate_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own duplicate close audit"
  ON public.paper_trade_history_duplicate_audit;
CREATE POLICY "Users read own duplicate close audit"
  ON public.paper_trade_history_duplicate_audit FOR SELECT
  USING (auth.uid() = user_id);

-- Reconcile legacy duplicate final closes before the new transaction takes
-- ownership. Partial closes intentionally use the same lifecycle position ID
-- with a suffix and are not final closes.
WITH ranked AS (
  SELECT
    h.*,
    first_value(h.id) OVER (
      PARTITION BY h.user_id, h.bot_id, h.position_id
      ORDER BY h.created_at, h.id
    ) AS kept_history_id,
    row_number() OVER (
      PARTITION BY h.user_id, h.bot_id, h.position_id
      ORDER BY h.created_at, h.id
    ) AS close_number
  FROM public.paper_trade_history h
  WHERE h.close_reason <> 'partial_tp'
    AND h.position_id !~ '_partial$'
),
duplicate_final_closes AS (
  SELECT * FROM ranked WHERE close_number > 1
),
audit_rows AS (
  INSERT INTO public.paper_trade_history_duplicate_audit (
    duplicate_history_id,
    kept_history_id,
    user_id,
    bot_id,
    position_id,
    duplicate_pnl,
    duplicate_row
  )
  SELECT
    d.id,
    d.kept_history_id,
    d.user_id,
    d.bot_id,
    d.position_id,
    COALESCE(d.pnl, 0),
    to_jsonb(d) - 'close_number' - 'kept_history_id'
  FROM duplicate_final_closes d
  ON CONFLICT (duplicate_history_id) DO NOTHING
  RETURNING duplicate_history_id
),
duplicate_adjustments AS (
  SELECT user_id, bot_id, sum(COALESCE(pnl, 0)) AS duplicated_pnl
  FROM duplicate_final_closes
  GROUP BY user_id, bot_id
),
account_repairs AS (
  UPDATE public.paper_accounts a
  SET balance = a.balance - d.duplicated_pnl,
      peak_balance = GREATEST(a.peak_balance, a.balance - d.duplicated_pnl)
  FROM duplicate_adjustments d
  WHERE a.user_id = d.user_id
    AND a.bot_id = d.bot_id
  RETURNING a.id
),
deleted_history AS (
  DELETE FROM public.paper_trade_history h
  USING duplicate_final_closes d
  WHERE h.id = d.id
  RETURNING h.id
)
SELECT
  (SELECT count(*) FROM audit_rows) AS audited_duplicates,
  (SELECT count(*) FROM account_repairs) AS repaired_accounts,
  (SELECT count(*) FROM deleted_history) AS deleted_duplicates;

-- A duplicated open source row must not create a second terminal close. Partial
-- take-profit rows are deliberately outside this lifecycle uniqueness rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_trade_history_final_lifecycle
  ON public.paper_trade_history (user_id, bot_id, position_id)
  WHERE close_reason <> 'partial_tp';

CREATE OR REPLACE FUNCTION public.finalize_paper_position_close(
  p_position_row_id UUID,
  p_user_id UUID,
  p_bot_id TEXT,
  p_exit_price NUMERIC,
  p_pnl NUMERIC,
  p_pnl_pips NUMERIC,
  p_close_reason TEXT,
  p_closed_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_position public.paper_positions%ROWTYPE;
  v_account public.paper_accounts%ROWTYPE;
  v_history_id UUID;
  v_new_balance NUMERIC;
  v_new_peak NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'forbidden',
      'reason', 'Cannot close another user''s paper position'
    );
  END IF;

  SELECT *
    INTO v_position
    FROM public.paper_positions
   WHERE id = p_position_row_id
     AND user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'already_resolved',
      'reason', 'Paper position is no longer open'
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
      'closed', false,
      'code', 'account_missing',
      'reason', 'Paper account is unavailable'
    );
  END IF;

  IF p_exit_price IS NULL OR p_exit_price <= 0
     OR p_pnl IS NULL
     OR p_close_reason IS NULL OR btrim(p_close_reason) = '' THEN
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'invalid_close',
      'reason', 'Exit price, P&L and close reason are required'
    );
  END IF;

  INSERT INTO public.paper_trade_history (
    user_id,
    position_id,
    symbol,
    direction,
    size,
    entry_price,
    exit_price,
    pnl,
    pnl_pips,
    open_time,
    closed_at,
    close_reason,
    signal_reason,
    signal_score,
    order_id,
    source_pending_order_id,
    bot_id,
    stop_loss,
    take_profit,
    source_position_row_id
  ) VALUES (
    p_user_id,
    v_position.position_id,
    v_position.symbol,
    v_position.direction,
    v_position.size,
    v_position.entry_price,
    p_exit_price,
    p_pnl,
    p_pnl_pips,
    v_position.open_time,
    COALESCE(p_closed_at, now())::TEXT,
    p_close_reason,
    v_position.signal_reason,
    v_position.signal_score,
    v_position.order_id,
    v_position.source_pending_order_id,
    p_bot_id,
    v_position.stop_loss,
    v_position.take_profit,
    v_position.id
  )
  RETURNING id INTO v_history_id;

  v_new_balance := v_account.balance + p_pnl;
  v_new_peak := GREATEST(v_account.peak_balance, v_new_balance);

  UPDATE public.paper_accounts
     SET balance = v_new_balance,
         peak_balance = v_new_peak
   WHERE id = v_account.id;

  DELETE FROM public.paper_positions
   WHERE id = v_position.id;

  RETURN jsonb_build_object(
    'closed', true,
    'code', 'closed',
    'history_id', v_history_id,
    'balance', v_new_balance,
    'peak_balance', v_new_peak
  );
EXCEPTION
  WHEN unique_violation THEN
    -- A second source row may share the already-finalized lifecycle identity.
    -- Remove that duplicate open row without moving the ledger again.
    DELETE FROM public.paper_positions
     WHERE id = p_position_row_id
       AND user_id = p_user_id
       AND bot_id = p_bot_id;
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'already_resolved',
      'reason', 'A final close already exists for this paper position'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_paper_position_close(
  UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_paper_position_close(
  UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ
) TO authenticated, service_role;

COMMENT ON FUNCTION public.finalize_paper_position_close(
  UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ
) IS 'Atomically records one final paper close, updates its account once, and removes the open position.';
