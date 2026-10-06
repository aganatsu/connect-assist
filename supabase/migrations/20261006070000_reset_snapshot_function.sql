-- Build the reset's pre-reset snapshot INSIDE the database.
--
-- The system-reset function used to SELECT every paper_trade_history row with
-- all columns (signal_reason, entry_config/decision snapshots — tens of KB
-- each) through PostgREST and INSERT them back as one jsonb row. That is tens
-- of MB in one statement and hit the statement timeout (2026-10-06 15:13 and
-- 15:15): the old period had already been flattened through the ledger, but
-- the snapshot, and therefore the reset, never ran. Nothing was lost — history
-- rows are never deleted, and the full offline copy is
-- research_snapshots/2026-10-06_pre_reset_final.
--
-- This function builds the snapshot in one statement with no round trip:
-- full account / ledger / reconciliation / config, a COMPACT history list
-- (identity, prices, P&L, times, route, version, R) and an integrity hash over
-- every history row, so the full rows can be matched later.

CREATE OR REPLACE FUNCTION public.take_account_reset_snapshot(
  p_reset_id uuid,
  p_closed_positions jsonb,
  p_cancelled_orders jsonb,
  p_cancelled_setups jsonb
)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.account_reset_runs%ROWTYPE;
  v_acct public.paper_accounts%ROWTYPE;
  v_history jsonb;
  v_history_count integer;
  v_history_hash text;
  v_ledger jsonb;
  v_ledger_count integer;
  v_config jsonb;
  v_config_hash text;
  v_id bigint;
BEGIN
  SELECT * INTO v_run FROM public.account_reset_runs WHERE reset_id = p_reset_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reset run % not found', p_reset_id; END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'reset run % is %, not running', p_reset_id, v_run.status; END IF;
  SELECT * INTO v_acct FROM public.paper_accounts WHERE id = v_run.account_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', h.id, 'position_id', h.position_id, 'symbol', h.symbol, 'direction', h.direction,
           'size', h.size, 'entry_price', h.entry_price, 'exit_price', h.exit_price,
           'pnl', h.pnl, 'pnl_pips', h.pnl_pips, 'open_time', h.open_time, 'closed_at', h.closed_at,
           'close_reason', h.close_reason, 'entry_route', h.entry_route, 'strategy_version', h.strategy_version,
           'realized_r_gross', h.realized_r_gross, 'source_position_row_id', h.source_position_row_id
         ) ORDER BY h.closed_at, h.id), '[]'::jsonb),
         count(*),
         md5(COALESCE(string_agg(h.id::text || '|' || COALESCE(h.pnl::text, '') || '|' || h.closed_at::text, ',' ORDER BY h.closed_at, h.id), ''))
    INTO v_history, v_history_count, v_history_hash
    FROM public.paper_trade_history h
   WHERE h.user_id = v_acct.user_id
     AND (v_acct.ledger_reset_at IS NULL OR h.closed_at >= v_acct.ledger_reset_at);

  SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.seq), '[]'::jsonb), count(*)
    INTO v_ledger, v_ledger_count
    FROM public.paper_account_ledger l WHERE l.account_id = v_acct.id;

  SELECT to_jsonb(c) INTO v_config
    FROM (SELECT id, config_json, updated_at FROM public.bot_configs
           WHERE user_id = v_acct.user_id AND connection_id IS NULL LIMIT 1) c;
  SELECT next_hash INTO v_config_hash FROM public.bot_config_change_log
   WHERE user_id = v_acct.user_id ORDER BY changed_at DESC LIMIT 1;

  INSERT INTO public.account_reset_snapshots (
    reset_id, account, ledger, reconciliation, period_history,
    closed_positions, cancelled_orders, cancelled_setups, config, config_hash, row_counts
  )
  SELECT p_reset_id, to_jsonb(v_acct), v_ledger, to_jsonb(r), v_history,
         COALESCE(p_closed_positions, '[]'::jsonb), COALESCE(p_cancelled_orders, '[]'::jsonb), COALESCE(p_cancelled_setups, '[]'::jsonb),
         v_config, v_config_hash,
         jsonb_build_object('ledger', v_ledger_count, 'period_history', v_history_count,
                            'period_history_md5', v_history_hash, 'history_form', 'compact (full rows remain in paper_trade_history)')
    FROM public.paper_account_reconciliation r WHERE r.account_id = v_acct.id
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RAISE EXCEPTION 'snapshot not written (no reconciliation row for account %)', v_acct.id; END IF;
  RETURN v_id;
END $function$;

REVOKE ALL ON FUNCTION public.take_account_reset_snapshot(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_account_reset_snapshot(uuid, jsonb, jsonb, jsonb) TO service_role;
