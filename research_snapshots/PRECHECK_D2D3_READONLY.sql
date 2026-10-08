-- D2/D3 — production pre-check for migration 20261009030000. READ-ONLY (SELECT only). Run AFTER D1 is applied and verified.
-- ready_to_apply must be TRUE. The client pending_orders write privileges are EXPECTED TRUE here (the gap D2 closes).
select
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009020000') as d1_recorded,
  has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
    or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as d1_any_client_exec,
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009030000') as d2_recorded,
  to_regprocedure('public.real_exposure_admission_guard()') is null as guard_absent,
  (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission') as admission_triggers,
  has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as auth_write_orders,
  has_table_privilege('anon', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as anon_write_orders,
  has_table_privilege('service_role', 'public.pending_orders', 'SELECT') and has_table_privilege('service_role', 'public.pending_orders', 'INSERT')
    and has_table_privilege('service_role', 'public.pending_orders', 'UPDATE') and has_table_privilege('service_role', 'public.pending_orders', 'DELETE') as service_orders_rw,
  has_table_privilege('authenticated', 'public.paper_positions', 'UPDATE') and has_table_privilege('authenticated', 'public.paper_positions', 'DELETE') as auth_positions_ud,
  (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in ('trg_paper_positions_entries_lock', 'trg_pending_orders_entries_lock',
      'trg_pending_orders_dry_run_immutable', 'paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')) as safety_triggers,
  (select count(*) from public.paper_positions p where not exists (select 1 from public.paper_accounts a where a.user_id = p.user_id and coalesce(a.bot_id, 'smc') = coalesce(p.bot_id, 'smc')))
   + (select count(*) from public.pending_orders o where o.status in ('pending', 'awaiting_confirmation', 'triggered') and o.dry_run is not true
        and not exists (select 1 from public.paper_accounts a where a.user_id = o.user_id and coalesce(a.bot_id, 'smc') = coalesce(o.bot_id, 'smc'))) as real_exposure_without_account,
  (select count(*) from public.paper_accounts where bot_id = 'smc') as smc_accounts,
  (select min(balance) from public.paper_accounts where bot_id = 'smc') as balance,
  (select bool_and(is_paused) from public.paper_accounts where bot_id = 'smc') as paused,
  (select bool_and(entries_locked) from public.paper_accounts where bot_id = 'smc') as entries_locked,
  (select count(*) from public.paper_positions) as positions,
  (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) as active_real_orders,
  coalesce((select count(*) from supabase_migrations.schema_migrations where version = '20261009020000') = 1
   and not (has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
            or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute'))
   and (select count(*) from supabase_migrations.schema_migrations where version = '20261009030000') = 0
   and to_regprocedure('public.real_exposure_admission_guard()') is null
   and (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission') = 0
   and has_table_privilege('service_role', 'public.pending_orders', 'SELECT') and has_table_privilege('service_role', 'public.pending_orders', 'INSERT')
   and has_table_privilege('service_role', 'public.pending_orders', 'UPDATE') and has_table_privilege('service_role', 'public.pending_orders', 'DELETE')
   and (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in ('trg_paper_positions_entries_lock', 'trg_pending_orders_entries_lock',
         'trg_pending_orders_dry_run_immutable', 'paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')) = 5
   and (select count(*) from public.paper_positions p where not exists (select 1 from public.paper_accounts a where a.user_id = p.user_id and coalesce(a.bot_id, 'smc') = coalesce(p.bot_id, 'smc')))
   + (select count(*) from public.pending_orders o where o.status in ('pending', 'awaiting_confirmation', 'triggered') and o.dry_run is not true
        and not exists (select 1 from public.paper_accounts a where a.user_id = o.user_id and coalesce(a.bot_id, 'smc') = coalesce(o.bot_id, 'smc'))) = 0
   and (select count(*) from public.paper_accounts where bot_id = 'smc' and balance = 100000 and is_paused and entries_locked) = 1
   and (select count(*) from public.paper_accounts where bot_id = 'smc') = 1
   and (select count(*) from public.paper_positions) = 0
   and (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) = 0, false) as ready_to_apply;
-- expect: 1 | f | 0 | t | 0 | t | t | t | t | 5 | 0 | 1 | 100000 | t | t | 0 | 0 | t
