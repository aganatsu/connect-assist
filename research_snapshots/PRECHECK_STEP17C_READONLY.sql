-- STEP 17-C — production pre-check for migration 20261009010000. READ-ONLY (SELECT only).
-- Run first. ready_to_apply must be TRUE; anything else = stop and report (do not run the apply script).
-- Note: reset_paper_account_authenticated = TRUE is EXPECTED here — it is the client bypass this migration closes.
select
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009000000') as step17a_recorded,
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') as step17c_recorded,
  (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure) as reset_md5,
  (select md5(prosrc) from pg_proc where oid = 'public._paper_ledger_caller_ok(uuid)'::regprocedure) as caller_ok_md5,
  has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as reset_paper_account_authenticated,
  has_function_privilege('anon', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as reset_paper_account_anon,
  has_function_privilege('service_role', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as reset_paper_account_service,
  to_regprocedure('public.reset_paper_account_if_flat(uuid,text,numeric,text)') is null as guarded_absent,
  to_regprocedure('public.paper_positions_serialize_with_reset()') is null
    and to_regprocedure('public.pending_orders_serialize_with_reset()') is null as trigger_functions_absent,
  (select count(*) from pg_trigger where tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')) as triggers_present,
  (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') as created_at_default,
  (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') as created_at_nullable,
  exists (select 1 from pg_constraint where conrelid = 'public.paper_accounts'::regclass and contype = 'u'
          and pg_get_constraintdef(oid) = 'UNIQUE (user_id)') as accounts_unique_user,
  (select count(*) from pg_trigger where tgname = 'trg_paper_positions_entries_lock' and not tgisinternal) as entries_lock_trigger,
  (select balance from public.paper_accounts where bot_id = 'smc') as balance,
  (select is_paused from public.paper_accounts where bot_id = 'smc') as paused,
  (select entries_locked from public.paper_accounts where bot_id = 'smc') as entries_locked,
  (select count(*) from public.paper_positions) as positions,
  (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) as active_real_orders,
  ((select count(*) from supabase_migrations.schema_migrations where version = '20261009000000') = 1
   and (select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') = 0
   and (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure) = '246e0ddefc1f8b0662974af2cd32f293'
   and (select md5(prosrc) from pg_proc where oid = 'public._paper_ledger_caller_ok(uuid)'::regprocedure) = 'ce94550c15e60d653c71958150a4e00c'
   and to_regprocedure('public.reset_paper_account_if_flat(uuid,text,numeric,text)') is null
   and (select count(*) from pg_trigger where tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')) = 0
   and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') = 'now()'
   and exists (select 1 from pg_constraint where conrelid = 'public.paper_accounts'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (user_id)')
  ) as ready_to_apply;
-- expect: 1 | 0 | 246e0ddefc1f8b0662974af2cd32f293 | ce94550c15e60d653c71958150a4e00c | t | f | t | t | t | 0 | now() | NO | t | 1
--         | 100000 | t | t | 0 | 0 | t
