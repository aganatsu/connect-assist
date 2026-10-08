-- STEP 17-C — functional verification that CANNOT persist anything.
-- Run AFTER APPLY_STEP17C_ATOMIC_RESET.sql. One DO block; its LAST statement always RAISEs, so
-- Postgres rolls everything back. The editor's error message IS the result:
--   STEP17C_VERIFY_PASS {...}   or   STEP17C_VERIFY_FAILED ...
-- Isolation:
--   * positions / resets / settlements: a throwaway paper account for a random user id
--     (paper_accounts / paper_positions have no auth.users FK) — the real SMC account is never reset;
--   * real-order refusal: orders under the real user id (pending_orders has an auth.users FK) and the
--     separate bot id 'step15_verify' (no paper account → the entries lock does not apply to it); the
--     guarded reset of the real account is only ever called while it MUST refuse, and the real
--     account's fingerprint is compared before/after.
-- Not testable here: the 'forbidden' path (another user's account). _paper_ledger_caller_ok also
-- accepts session_user = 'postgres', and the SQL editor's session user IS postgres (SET ROLE does not
-- change session_user). That path is covered by CI (paperSettlementLedger.test.ts, session
-- authorization authenticated) and the external two-session proof (Scenario E). The function body is
-- pinned by md5 below instead.
-- Only side effects after rollback: sequence gaps.
DO $verify$
DECLARE
  U constant uuid := '57c79dee-db6b-4fae-b34a-4b64ce33ca34';
  B constant text := 'step15_verify';
  v_user uuid := gen_random_uuid();
  v_acct uuid; v_p1 record; v_p2 record; v_p3 record; v_a record; v_a2 record;
  r jsonb; res jsonb := '{}'::jsonb; v_err text; v_role_ok boolean := true;
  v_u_before text; v_u_after text; v_o uuid;
BEGIN
  IF (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account_if_flat(uuid,text,numeric,text)'::regprocedure) IS DISTINCT FROM 'de37b22a841c365c3c83a0712b1eb2db'
     OR (select md5(prosrc) from pg_proc where oid = 'public.paper_positions_serialize_with_reset()'::regprocedure) IS DISTINCT FROM '9d32120d64900de95e08b1da8274467d'
     OR (select md5(prosrc) from pg_proc where oid = 'public.pending_orders_serialize_with_reset()'::regprocedure) IS DISTINCT FROM 'ded96cbc4ee81e433fc645c2317e30f4'
     OR (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure) IS DISTINCT FROM '246e0ddefc1f8b0662974af2cd32f293'
     OR (select md5(prosrc) from pg_proc where oid = 'public._paper_ledger_caller_ok(uuid)'::regprocedure) IS DISTINCT FROM 'ce94550c15e60d653c71958150a4e00c' THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED the migrated functions are not in place';
  END IF;

  -- real account fingerprint (account row + its ledger + every position not belonging to the throwaway user)
  SELECT md5(concat_ws('#',
      (SELECT concat_ws(',', a.id, a.balance, a.peak_balance, a.daily_pnl_base, a.is_paused, a.entries_locked, a.kill_switch_active, a.ledger_epoch_id, a.ledger_reset_at)
         FROM public.paper_accounts a WHERE a.user_id = U),
      (SELECT md5(coalesce(string_agg(l::text, '|' ORDER BY l.id::text), '')) FROM public.paper_account_ledger l
        WHERE l.account_id = (SELECT id FROM public.paper_accounts WHERE user_id = U)),
      (SELECT md5(coalesce(string_agg(p::text, '|' ORDER BY p.id::text), '')) FROM public.paper_positions p WHERE p.user_id <> v_user))) INTO v_u_before;

  INSERT INTO public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base)
  VALUES (v_user, 'smc', 104000, 104000, 104000) RETURNING id INTO v_acct;

  -- ── 1. position insert, created_at omitted: stamped by the trigger, after transaction start ──
  INSERT INTO public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score)
  VALUES (v_user, 'smc', 'v17c_p1', 'v17c_p1', 'USD/JPY', 'long', 1, 154.9, 154.694849, 155.507852, 155.53582, now(), '46')
  RETURNING id, created_at INTO v_p1;
  IF v_p1.created_at IS NULL OR v_p1.created_at <= now() THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED created_at not stamped after transaction start: % (txn start %)', v_p1.created_at, now();
  END IF;
  res := res || jsonb_build_object('created_at_stamped_after_txn_start', true);

  -- ── 2. guarded reset with an open position: refused, no data change ──
  SELECT * INTO v_a FROM public.paper_accounts WHERE id = v_acct;
  r := public.reset_paper_account_if_flat(v_user, 'smc', 100000, 'step17c_verify');
  SELECT * INTO v_a2 FROM public.paper_accounts WHERE id = v_acct;
  IF r->>'reset' <> 'false' OR r->>'code' <> 'reset_refused_real_exposure' OR (r->'exposure'->>'openPositions')::int <> 1
     OR v_a2.balance <> v_a.balance OR v_a2.ledger_epoch_id IS DISTINCT FROM v_a.ledger_epoch_id OR v_a2.ledger_reset_at IS DISTINCT FROM v_a.ledger_reset_at
     OR (SELECT count(*) FROM public.paper_positions WHERE user_id = v_user) <> 1 THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED refusal with a position: % balance % → %', r, v_a.balance, v_a2.balance;
  END IF;
  res := res || jsonb_build_object('refused_with_position', r);

  -- ── 3. that position settles and is credited (it is in the current epoch) ──
  r := public.settle_paper_position(v_p1.id, v_user, 'smc', '{"exit_price":155.507852,"pnl":871.19,"pnl_pips":60.8,"close_reason":"tp_hit"}'::jsonb, 'step17c_verify');
  IF r->>'code' <> 'settled' OR (r->>'amount')::numeric <> 871.19 THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED settle of the position: %', r;
  END IF;
  res := res || jsonb_build_object('settle_credited', r->>'amount');

  -- ── 4. client role: the unguarded reset is refused by privilege; the guarded reset of its OWN flat account works ──
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
  EXCEPTION WHEN OTHERS THEN v_role_ok := false;
  END;
  IF v_role_ok THEN
    PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_user)::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
    v_err := 'ALLOWED';
    BEGIN
      PERFORM public.reset_paper_account(v_user, 'smc', 1, 'bypass');
    EXCEPTION WHEN insufficient_privilege THEN v_err := 'insufficient_privilege';
    END;
    r := public.reset_paper_account_if_flat(v_user, 'smc', 100000, 'step17c_verify_client');
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    IF v_err <> 'insufficient_privilege' THEN
      RAISE EXCEPTION 'STEP17C_VERIFY_FAILED authenticated can still call reset_paper_account (%)', v_err;
    END IF;
    IF r->>'reset' <> 'true' THEN
      RAISE EXCEPTION 'STEP17C_VERIFY_FAILED authenticated guarded reset of its own flat account: %', r;
    END IF;
    res := res || jsonb_build_object('client_unguarded', v_err, 'client_guarded_own_flat', r->>'code');
  ELSE
    -- fall back to the service path for the flat reset so the remaining checks still run
    r := public.reset_paper_account_if_flat(v_user, 'smc', 100000, 'step17c_verify');
    IF r->>'reset' <> 'true' THEN RAISE EXCEPTION 'STEP17C_VERIFY_FAILED guarded reset of a flat account: %', r; END IF;
    res := res || jsonb_build_object('client_role_checks', 'SKIPPED: SET ROLE authenticated not permitted (catalog ACL checked by APPLY)', 'guarded_flat', r->>'code');
  END IF;
  SELECT * INTO v_a FROM public.paper_accounts WHERE id = v_acct;
  IF v_a.balance <> 100000 OR v_a.ledger_reset_at IS NULL THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED flat reset did not take effect: balance % reset_at %', v_a.balance, v_a.ledger_reset_at;
  END IF;

  -- ── 5. after the reset: an omitted created_at lands after ledger_reset_at and is credited;
  --       an explicit historical created_at is kept and settles pre-epoch ($0) ──
  INSERT INTO public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score)
  VALUES (v_user, 'smc', 'v17c_p2', 'v17c_p2', 'USD/JPY', 'long', 1, 154.9, 154.694849, 155.507852, 155.53582, now(), '46')
  RETURNING id, created_at INTO v_p2;
  INSERT INTO public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score, created_at)
  VALUES (v_user, 'smc', 'v17c_p3', 'v17c_p3', 'USD/JPY', 'long', 1, 154.9, 154.694849, 155.507852, 155.53582, now(), '46', '2026-01-01T00:00:00Z')
  RETURNING id, created_at INTO v_p3;
  IF v_p2.created_at <= v_a.ledger_reset_at OR v_p3.created_at <> '2026-01-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED created_at after reset: p2 % (reset_at %), p3 %', v_p2.created_at, v_a.ledger_reset_at, v_p3.created_at;
  END IF;
  r := public.settle_paper_position(v_p2.id, v_user, 'smc', '{"exit_price":155.507852,"pnl":500,"pnl_pips":60.8,"close_reason":"tp_hit"}'::jsonb, 'step17c_verify');
  IF r->>'code' <> 'settled' OR (r->>'amount')::numeric <> 500 THEN RAISE EXCEPTION 'STEP17C_VERIFY_FAILED post-reset position not credited: %', r; END IF;
  res := res || jsonb_build_object('post_reset_credited', r->>'amount');
  r := public.settle_paper_position(v_p3.id, v_user, 'smc', '{"exit_price":155.507852,"pnl":500,"pnl_pips":60.8,"close_reason":"tp_hit"}'::jsonb, 'step17c_verify');
  IF r->>'code' <> 'settled_pre_epoch' OR (r->>'amount')::numeric <> 0 THEN RAISE EXCEPTION 'STEP17C_VERIFY_FAILED explicit historical created_at: %', r; END IF;
  res := res || jsonb_build_object('explicit_created_at_kept_pre_epoch', r->>'code');

  -- ── 6. system-reset path: service_role still calls reset_paper_account directly ──
  v_role_ok := true;
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
  EXCEPTION WHEN OTHERS THEN v_role_ok := false;
  END;
  IF v_role_ok THEN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    r := public.reset_paper_account(v_user, 'smc', 100000, 'step17c_verify_system');
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    IF r->>'reset' <> 'true' THEN RAISE EXCEPTION 'STEP17C_VERIFY_FAILED service_role reset_paper_account: %', r; END IF;
    res := res || jsonb_build_object('service_role_unguarded', r->>'code');
  ELSE
    res := res || jsonb_build_object('service_role_unguarded', 'SKIPPED: SET ROLE service_role not permitted (catalog ACL checked by APPLY)');
  END IF;

  -- ── 7. real-order refusal on the REAL user (must refuse; no data change) ──
  INSERT INTO public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run)
  VALUES (U, B, 'v17c_dry', 'EUR/USD', 'short', 'limit', 1.1, 1.099, 1.102, 1.0978, 'pending', now() + interval '8 hours', true);
  INSERT INTO public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run)
  VALUES (U, B, 'v17c_real', 'EUR/USD', 'long', 'limit', 1.1, 1.101, 1.098, 1.1022, 'pending', now() + interval '8 hours', false)
  RETURNING id INTO v_o;
  r := public.reset_paper_account_if_flat(U, 'smc', 100000, 'step17c_verify_must_refuse');
  IF r->>'reset' <> 'false' OR r->>'code' <> 'reset_refused_real_exposure' OR (r->'exposure'->>'activeRealOrders')::int < 1 OR (r->'exposure'->>'activeDryRunOrders')::int < 1 THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED real order did not block the reset: %', r;
  END IF;
  res := res || jsonb_build_object('refused_with_real_order', r);
  -- re-activation (non-active → active) also counts
  UPDATE public.pending_orders SET status = 'cancelled', terminal_reason = 'CANCELLED_ZONE_EXIT' WHERE id = v_o;
  UPDATE public.pending_orders SET status = 'triggered', terminal_reason = NULL WHERE id = v_o;
  r := public.reset_paper_account_if_flat(U, 'smc', 100000, 'step17c_verify_must_refuse');
  IF r->>'code' <> 'reset_refused_real_exposure' OR (r->'exposure'->>'activeRealOrders')::int < 1 THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED re-activated (triggered) real order did not block the reset: %', r;
  END IF;
  res := res || jsonb_build_object('refused_with_triggered_order', r->>'code');

  SELECT md5(concat_ws('#',
      (SELECT concat_ws(',', a.id, a.balance, a.peak_balance, a.daily_pnl_base, a.is_paused, a.entries_locked, a.kill_switch_active, a.ledger_epoch_id, a.ledger_reset_at)
         FROM public.paper_accounts a WHERE a.user_id = U),
      (SELECT md5(coalesce(string_agg(l::text, '|' ORDER BY l.id::text), '')) FROM public.paper_account_ledger l
        WHERE l.account_id = (SELECT id FROM public.paper_accounts WHERE user_id = U)),
      (SELECT md5(coalesce(string_agg(p::text, '|' ORDER BY p.id::text), '')) FROM public.paper_positions p WHERE p.user_id <> v_user))) INTO v_u_after;
  IF v_u_after IS DISTINCT FROM v_u_before THEN
    RAISE EXCEPTION 'STEP17C_VERIFY_FAILED the real account changed during verification';
  END IF;
  res := res || jsonb_build_object('real_account_unchanged', true,
    'smc_account', (SELECT jsonb_build_object('balance', balance, 'paused', is_paused, 'entries_locked', entries_locked) FROM public.paper_accounts WHERE user_id = U));

  -- ALWAYS roll everything back
  RAISE EXCEPTION 'STEP17C_VERIFY_PASS %', res;
END $verify$;
