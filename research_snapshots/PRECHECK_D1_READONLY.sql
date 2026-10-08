-- D1 — production pre-check for migration 20261009020000. READ-ONLY (SELECT only). ready_to_apply must be TRUE.
-- The *_client_exec columns are EXPECTED TRUE here: that is the hole D1 closes.
select
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') as step17c_recorded,
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009020000') as d1_recorded,
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009030000') as d2_recorded,
  (select count(*) from pg_proc where oid in ('public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)'::regprocedure, 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)'::regprocedure, 'public.finalize_live_broker_position(uuid,text,text)'::regprocedure, 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)'::regprocedure)
      and prosecdef and proconfig @> array['search_path=public']) as definer_search_path_ok,
  has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') as market_entry_client_exec,
  has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') as pending_fill_client_exec,
  has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') as live_broker_client_exec,
  has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as retarget_client_exec,
  has_function_privilege('service_role', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') and has_function_privilege('service_role', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') and has_function_privilege('service_role', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') and has_function_privilege('service_role', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as service_exec,
  (select count(*) from public.paper_accounts where bot_id = 'smc') as smc_accounts,
  (select min(balance) from public.paper_accounts where bot_id = 'smc') as balance,
  (select bool_and(is_paused) from public.paper_accounts where bot_id = 'smc') as paused,
  (select bool_and(entries_locked) from public.paper_accounts where bot_id = 'smc') as entries_locked,
  (select count(*) from public.paper_positions) as positions,
  (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) as active_real_orders,
  coalesce((select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') = 1
   and (select count(*) from supabase_migrations.schema_migrations where version in ('20261009020000', '20261009030000')) = 0
   and (select count(*) from pg_proc where oid in ('public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)'::regprocedure, 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)'::regprocedure, 'public.finalize_live_broker_position(uuid,text,text)'::regprocedure, 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)'::regprocedure)
         and prosecdef and proconfig @> array['search_path=public']) = 4
   and (select count(*) from public.paper_accounts where bot_id = 'smc' and balance = 100000 and is_paused and entries_locked) = 1
   and (select count(*) from public.paper_accounts where bot_id = 'smc') = 1
   and (select count(*) from public.paper_positions) = 0
   and (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) = 0, false) as ready_to_apply;
-- expect: 1 | 0 | 0 | 4 | t | t | t | t | t | 1 | 100000 | t | t | 0 | 0 | t
