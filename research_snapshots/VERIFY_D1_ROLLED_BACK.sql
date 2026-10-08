-- D1 — functional verification that CANNOT persist anything. Run AFTER APPLY_D1. One DO block whose last statement always
-- RAISEs, so everything rolls back; the editor's error message IS the result: D1_VERIFY_PASS {...} or D1_VERIFY_FAILED ...
-- Each client call is attempted only after the catalog confirms EXECUTE is denied, so no function body can run.
DO $verify$
DECLARE v_err text; res jsonb := '{}'::jsonb;
BEGIN
  -- authenticated → fme: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') then
    raise exception 'D1_VERIFY_FAILED authenticated still has EXECUTE on public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.finalize_market_entry('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc', 'd1_verify', '{}'::jsonb, '{}'::jsonb, 0, 0, false, false);
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED authenticated call to fme: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_fme', v_err);
  -- authenticated → fpf: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') then
    raise exception 'D1_VERIFY_FAILED authenticated still has EXECUTE on public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.finalize_pending_order_fill(gen_random_uuid(), '57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc', 0, 0, 'd1_verify', '{}'::jsonb, 'd1_verify', '{}'::jsonb, 0, 0, false);
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED authenticated call to fpf: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_fpf', v_err);
  -- authenticated → flb: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') then
    raise exception 'D1_VERIFY_FAILED authenticated still has EXECUTE on public.finalize_live_broker_position(uuid,text,text)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.finalize_live_broker_position('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc', 'd1_verify');
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED authenticated call to flb: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_flb', v_err);
  -- authenticated → rpi: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') then
    raise exception 'D1_VERIFY_FAILED authenticated still has EXECUTE on public.retarget_pending_to_impulse_candidate(uuid,uuid,text)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.retarget_pending_to_impulse_candidate(gen_random_uuid(), '57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc');
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED authenticated call to rpi: %', v_err; end if;
  res := res || jsonb_build_object('authenticated_rpi', v_err);
  -- anon → fme: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') then
    raise exception 'D1_VERIFY_FAILED anon still has EXECUTE on public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.finalize_market_entry('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc', 'd1_verify', '{}'::jsonb, '{}'::jsonb, 0, 0, false, false);
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED anon call to fme: %', v_err; end if;
  res := res || jsonb_build_object('anon_fme', v_err);
  -- anon → fpf: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') then
    raise exception 'D1_VERIFY_FAILED anon still has EXECUTE on public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.finalize_pending_order_fill(gen_random_uuid(), '57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc', 0, 0, 'd1_verify', '{}'::jsonb, 'd1_verify', '{}'::jsonb, 0, 0, false);
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED anon call to fpf: %', v_err; end if;
  res := res || jsonb_build_object('anon_fpf', v_err);
  -- anon → flb: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') then
    raise exception 'D1_VERIFY_FAILED anon still has EXECUTE on public.finalize_live_broker_position(uuid,text,text)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.finalize_live_broker_position('57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc', 'd1_verify');
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED anon call to flb: %', v_err; end if;
  res := res || jsonb_build_object('anon_flb', v_err);
  -- anon → rpi: the call is attempted only if the catalog already says it is denied (never executes a body)
  if has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') then
    raise exception 'D1_VERIFY_FAILED anon still has EXECUTE on public.retarget_pending_to_impulse_candidate(uuid,uuid,text)';
  end if;
  v_err := 'ALLOWED';
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon","sub":"57c79dee-db6b-4fae-b34a-4b64ce33ca34"}', true);
    perform public.retarget_pending_to_impulse_candidate(gen_random_uuid(), '57c79dee-db6b-4fae-b34a-4b64ce33ca34', 'smc');
  exception when insufficient_privilege then v_err := 'insufficient_privilege';
  end;
  execute 'reset role';
  if v_err <> 'insufficient_privilege' then raise exception 'D1_VERIFY_FAILED anon call to rpi: %', v_err; end if;
  res := res || jsonb_build_object('anon_rpi', v_err);
  IF NOT (has_function_privilege('service_role', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') and has_function_privilege('service_role', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') and has_function_privilege('service_role', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') and has_function_privilege('service_role', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute')) THEN
    RAISE EXCEPTION 'D1_VERIFY_FAILED service_role lost EXECUTE';
  END IF;
  res := res || jsonb_build_object('service_role_exec', true,
    'smc_account', (select jsonb_build_object('balance', balance, 'paused', is_paused, 'entries_locked', entries_locked) from public.paper_accounts where bot_id = 'smc'));
  RAISE EXCEPTION 'D1_VERIFY_PASS %', res;
END $verify$;
