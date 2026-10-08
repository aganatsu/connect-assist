-- D2/D3 — functional verification that CANNOT persist anything. Run AFTER APPLY_D2D3. One DO block whose last statement
-- always RAISEs (everything rolls back); the editor's error message IS the result: D2_VERIFY_PASS {...} or D2_VERIFY_FAILED ...
-- Client checks run as SET LOCAL ROLE authenticated / anon (privilege checks use current_user). Client write attempts target a
-- non-existent order id, so even a wrongly-allowed UPDATE/DELETE would touch nothing.
-- NOT testable in the SQL editor: the trigger's client branch (client INSERT into paper_positions; a client write through a
-- SECURITY DEFINER function). The editor's session_user is postgres, which the trigger treats as a database administrator. Those
-- paths are covered by PR #656's tests, which switch session_user the way PostgREST does.
DO $verify$
DECLARE
  U constant uuid := '57c79dee-db6b-4fae-b34a-4b64ce33ca34';
  v_user uuid := gen_random_uuid();
  v_err text; res jsonb := '{}'::jsonb; n int; r jsonb; v_pos uuid;
  v_before text; v_after text;
BEGIN
  IF (select md5(prosrc) from pg_proc where oid = 'public.real_exposure_admission_guard()'::regprocedure) IS DISTINCT FROM '4ade726424070850f851acef170f36bf' THEN
    RAISE EXCEPTION 'D2_VERIFY_FAILED the reviewed guard function is not in place';
  END IF;
  SELECT md5(concat_ws('#',
      (SELECT concat_ws(',', a.id, a.balance, a.peak_balance, a.daily_pnl_base, a.is_paused, a.entries_locked, a.kill_switch_active, a.ledger_epoch_id, a.ledger_reset_at)
         FROM public.paper_accounts a WHERE a.user_id = U),
      (SELECT md5(coalesce(string_agg(o::text, '|' ORDER BY o.id::text), '')) FROM public.pending_orders o WHERE o.user_id = U AND o.bot_id = 'smc'),
      (SELECT count(*) FROM public.paper_positions)::text)) INTO v_before;

  -- 1. clients: no pending_orders INSERT / UPDATE / status change / DELETE; SELECT still works
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$insert into public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run) values ('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'step15_verify', 'd2v_client', 'EUR/USD', 'long', 'limit', 1.1, 1.101, 1.098, 1.1022, 'pending', now() + interval '8 hours', true)$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED authenticated insert_order: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_insert_order', v_err);
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$update public.pending_orders set stop_loss = stop_loss where order_id = 'd2v_none'$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED authenticated update_order: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_update_order', v_err);
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$update public.pending_orders set status = 'pending' where order_id = 'd2v_none'$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED authenticated update_status: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_update_status', v_err);
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$delete from public.pending_orders where order_id = 'd2v_none'$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED authenticated delete_order: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_delete_order', v_err);
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$insert into public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run) values ('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'step15_verify', 'd2v_client', 'EUR/USD', 'long', 'limit', 1.1, 1.101, 1.098, 1.1022, 'pending', now() + interval '8 hours', true)$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED anon insert_order: %', v_err; end if;
  res := res || jsonb_build_object('anon_insert_order', v_err);
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$update public.pending_orders set stop_loss = stop_loss where order_id = 'd2v_none'$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED anon update_order: %', v_err; end if;
  res := res || jsonb_build_object('anon_update_order', v_err);
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$update public.pending_orders set status = 'pending' where order_id = 'd2v_none'$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED anon update_status: %', v_err; end if;
  res := res || jsonb_build_object('anon_update_status', v_err);
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    execute $q$delete from public.pending_orders where order_id = 'd2v_none'$q$;
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D2_VERIFY_FAILED anon delete_order: %', v_err; end if;
  res := res || jsonb_build_object('anon_delete_order', v_err);
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
  SELECT count(*) INTO n FROM public.pending_orders WHERE user_id = U;
  execute 'reset role';
  res := res || jsonb_build_object('authenticated_select_own_orders', n);

  -- 2. D3 (server session): real exposure under a bot id with no paper account is refused
  v_err := 'ALLOWED';
  BEGIN
    INSERT INTO public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run)
    VALUES (U, 'step15_verify', 'd2v_real_ghost', 'EUR/USD', 'long', 'limit', 1.1, 1.101, 1.098, 1.1022, 'pending', now() + interval '8 hours', false);
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  IF v_err NOT LIKE 'real exposure needs a paper account%' THEN RAISE EXCEPTION 'D2_VERIFY_FAILED D3 real order: %', v_err; END IF;
  v_err := 'ALLOWED';
  BEGIN
    INSERT INTO public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score)
    VALUES (U, 'd2v_ghost', 'd2v_ghost', 'd2v_ghost', 'USD/JPY', 'long', 1, 154.9, 154.69, 155.5, 155.5, now(), '0');
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  IF v_err NOT LIKE 'real exposure needs a paper account%' THEN RAISE EXCEPTION 'D2_VERIFY_FAILED D3 real position: %', v_err; END IF;
  res := res || jsonb_build_object('d3_real_order_no_account', 'refused', 'd3_real_position_no_account', 'refused');

  -- 3. the entries lock still refuses a real SMC order (account locked)
  v_err := 'ALLOWED';
  BEGIN
    INSERT INTO public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run)
    VALUES (U, 'smc', 'd2v_real_locked', 'EUR/USD', 'short', 'limit', 1.1, 1.099, 1.102, 1.0978, 'pending', now() + interval '8 hours', false);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err NOT LIKE 'entries locked%' THEN RAISE EXCEPTION 'D2_VERIFY_FAILED locked real order: %', v_err; END IF;
  res := res || jsonb_build_object('entries_lock_real_order', 'refused');

  -- 4. server dry-run order lifecycle (insert → touch → cancel → delete), as the scanner does while locked
  INSERT INTO public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run)
  VALUES (U, 'step15_verify', 'd2v_dry', 'GBP/USD', 'short', 'limit', 1.3, 1.299, 1.3025, 1.29725, 'pending', now() + interval '8 hours', true);
  UPDATE public.pending_orders SET status = 'awaiting_confirmation', zone_touch_time = now() WHERE user_id = U AND order_id = 'd2v_dry';
  UPDATE public.pending_orders SET status = 'cancelled', terminal_reason = 'CANCELLED_ZONE_EXIT', resolved_at = now() WHERE user_id = U AND order_id = 'd2v_dry';
  DELETE FROM public.pending_orders WHERE user_id = U AND order_id = 'd2v_dry';
  res := res || jsonb_build_object('server_dry_order_lifecycle', 'ok');

  -- 5. server position on a throwaway account; client UPDATE and manual close of it still work
  INSERT INTO public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) VALUES (v_user, 'smc', 100000, 100000, 100000);
  INSERT INTO public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score)
  VALUES (v_user, 'smc', 'd2v_pos', 'd2v_pos', 'USD/JPY', 'long', 1, 154.9, 154.694849, 155.507852, 155.2, now(), '0') RETURNING id INTO v_pos;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_user)::text, true);
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  UPDATE public.paper_positions SET current_price = 155.3, stop_loss = 154.8 WHERE id = v_pos;
  GET DIAGNOSTICS n = ROW_COUNT;
  r := public.settle_paper_position(v_pos, v_user, 'smc', '{"exit_price":155.3,"pnl":400,"close_reason":"manual"}'::jsonb, 'd2_verify_manual_close');
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  IF n <> 1 OR r->>'code' <> 'settled' THEN RAISE EXCEPTION 'D2_VERIFY_FAILED client position update (% rows) / manual close (%)', n, r; END IF;
  res := res || jsonb_build_object('client_position_update', n, 'client_manual_close', r->>'code');

  SELECT md5(concat_ws('#',
      (SELECT concat_ws(',', a.id, a.balance, a.peak_balance, a.daily_pnl_base, a.is_paused, a.entries_locked, a.kill_switch_active, a.ledger_epoch_id, a.ledger_reset_at)
         FROM public.paper_accounts a WHERE a.user_id = U),
      (SELECT md5(coalesce(string_agg(o::text, '|' ORDER BY o.id::text), '')) FROM public.pending_orders o WHERE o.user_id = U AND o.bot_id = 'smc'),
      (SELECT count(*) FROM public.paper_positions WHERE user_id <> v_user)::text)) INTO v_after;
  IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'D2_VERIFY_FAILED the real account or its orders changed'; END IF;
  res := res || jsonb_build_object('real_account_and_orders_unchanged', true,
    'smc_account', (select jsonb_build_object('balance', balance, 'paused', is_paused, 'entries_locked', entries_locked) from public.paper_accounts where user_id = U));
  RAISE EXCEPTION 'D2_VERIFY_PASS %', res;
END $verify$;
