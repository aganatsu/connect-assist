-- D2/D3 — post-migration READ-ONLY check (SELECT only). Safe to re-run.
select
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009030000') as d2_recorded,
  (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.real_exposure_admission_guard()')) as guard_md5,
  (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid = to_regprocedure('public.real_exposure_admission_guard()')) as guard_definer_sp,
  (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D'
      and ((tgrelid = 'public.pending_orders'::regclass and tgtype = 31) or (tgrelid = 'public.paper_positions'::regclass and tgtype = 7))) as admission_triggers,
  has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as auth_write_orders,
  has_table_privilege('anon', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as anon_write_orders,
  has_table_privilege('authenticated', 'public.pending_orders', 'SELECT') as auth_select_orders,
  has_table_privilege('service_role', 'public.pending_orders', 'SELECT') and has_table_privilege('service_role', 'public.pending_orders', 'INSERT')
    and has_table_privilege('service_role', 'public.pending_orders', 'UPDATE') and has_table_privilege('service_role', 'public.pending_orders', 'DELETE') as service_orders_rw,
  has_table_privilege('authenticated', 'public.paper_positions', 'UPDATE') and has_table_privilege('authenticated', 'public.paper_positions', 'DELETE') as auth_positions_ud,
  has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
    or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as d1_any_client_exec,
  (select count(*) from public.pending_orders where order_id like 'd2v_%') + (select count(*) from public.paper_positions where position_id like 'd2v_%') as verify_rows_left,
  (select count(*) from public.paper_accounts where bot_id = 'smc') as smc_accounts,
  (select min(balance) from public.paper_accounts where bot_id = 'smc') as balance,
  (select bool_and(is_paused) from public.paper_accounts where bot_id = 'smc') as paused,
  (select bool_and(entries_locked) from public.paper_accounts where bot_id = 'smc') as entries_locked,
  (select count(*) from public.paper_positions) as positions,
  (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) as active_real_orders,
  coalesce((select count(*) from supabase_migrations.schema_migrations where version = '20261009030000') = 1
   and (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.real_exposure_admission_guard()')) = '4ade726424070850f851acef170f36bf'
   and (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D'
      and ((tgrelid = 'public.pending_orders'::regclass and tgtype = 31) or (tgrelid = 'public.paper_positions'::regclass and tgtype = 7))) = 2
   and not has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') and not has_table_privilege('anon', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
   and has_table_privilege('authenticated', 'public.pending_orders', 'SELECT')
   and has_table_privilege('service_role', 'public.pending_orders', 'SELECT') and has_table_privilege('service_role', 'public.pending_orders', 'INSERT')
   and has_table_privilege('service_role', 'public.pending_orders', 'UPDATE') and has_table_privilege('service_role', 'public.pending_orders', 'DELETE')
   and has_table_privilege('authenticated', 'public.paper_positions', 'UPDATE') and has_table_privilege('authenticated', 'public.paper_positions', 'DELETE')
   and (select count(*) from supabase_migrations.schema_migrations where version = '20261009020000') = 1
   and not (has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
            or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute'))
   and (select count(*) from public.pending_orders where order_id like 'd2v_%') + (select count(*) from public.paper_positions where position_id like 'd2v_%') = 0
   and (select count(*) from public.paper_accounts where bot_id = 'smc' and balance = 100000 and is_paused and entries_locked) = 1
   and (select count(*) from public.paper_accounts where bot_id = 'smc') = 1
   and (select count(*) from public.paper_positions) = 0
   and (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) = 0, false) as all_pass;
-- expect: 1 | 4ade726424070850f851acef170f36bf | t | 2 | f | f | t | t | t | f | 0 | 1 | 100000 | t | t | 0 | 0 | t
