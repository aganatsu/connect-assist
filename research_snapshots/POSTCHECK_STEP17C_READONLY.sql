-- STEP 17-C — post-migration READ-ONLY check (SELECT only). Run after APPLY + VERIFY; safe to re-run.
select
  (select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') as migration_rows,
  (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account_if_flat(uuid,text,numeric,text)'::regprocedure) as guarded_md5,
  (select md5(prosrc) from pg_proc where oid = 'public.paper_positions_serialize_with_reset()'::regprocedure) as position_trigger_fn_md5,
  (select md5(prosrc) from pg_proc where oid = 'public.pending_orders_serialize_with_reset()'::regprocedure) as order_trigger_fn_md5,
  (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure) as reset_md5,
  (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D'
      and ((tgname = 'paper_positions_serialize_with_reset' and tgrelid = 'public.paper_positions'::regclass)
        or (tgname = 'pending_orders_serialize_with_reset' and tgrelid = 'public.pending_orders'::regclass))) as triggers_enabled,
  (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') as created_at_default,
  (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') as created_at_nullable,
  has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as reset_authenticated,
  has_function_privilege('anon', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as reset_anon,
  has_function_privilege('service_role', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as reset_service,
  has_function_privilege('authenticated', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute') as guarded_authenticated,
  has_function_privilege('anon', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute') as guarded_anon,
  has_function_privilege('service_role', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute') as guarded_service,
  (select count(*) from pending_orders where bot_id = 'step15_verify' and order_id like 'v17c_%')
    + (select count(*) from paper_positions where position_id like 'v17c_%') as verify_rows_left,
  (select balance from public.paper_accounts where bot_id = 'smc') as balance,
  (select is_paused from public.paper_accounts where bot_id = 'smc') as paused,
  (select entries_locked from public.paper_accounts where bot_id = 'smc') as entries_locked,
  (select count(*) from public.paper_positions) as positions,
  (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) as active_real_orders,
  ((select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') = 1
   and (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account_if_flat(uuid,text,numeric,text)'::regprocedure) = 'de37b22a841c365c3c83a0712b1eb2db'
   and (select md5(prosrc) from pg_proc where oid = 'public.paper_positions_serialize_with_reset()'::regprocedure) = '9d32120d64900de95e08b1da8274467d'
   and (select md5(prosrc) from pg_proc where oid = 'public.pending_orders_serialize_with_reset()'::regprocedure) = 'ded96cbc4ee81e433fc645c2317e30f4'
   and (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure) = '246e0ddefc1f8b0662974af2cd32f293'
   and (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D'
         and ((tgname = 'paper_positions_serialize_with_reset' and tgrelid = 'public.paper_positions'::regclass)
           or (tgname = 'pending_orders_serialize_with_reset' and tgrelid = 'public.pending_orders'::regclass))) = 2
   and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') is null
   and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') = 'NO'
   and not has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute')
   and not has_function_privilege('anon', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute')
   and has_function_privilege('service_role', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute')
   and has_function_privilege('authenticated', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
   and not has_function_privilege('anon', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
   and has_function_privilege('service_role', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
   and (select count(*) from pending_orders where bot_id = 'step15_verify' and order_id like 'v17c_%') = 0
   and (select count(*) from paper_positions where position_id like 'v17c_%') = 0
   and (select balance from public.paper_accounts where bot_id = 'smc') = 100000
   and (select is_paused from public.paper_accounts where bot_id = 'smc')
   and (select entries_locked from public.paper_accounts where bot_id = 'smc')
   and (select count(*) from public.paper_positions) = 0
   and (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) = 0) as all_pass;
-- expect: 1 | de37b22a841c365c3c83a0712b1eb2db | 9d32120d64900de95e08b1da8274467d | ded96cbc4ee81e433fc645c2317e30f4
--         | 246e0ddefc1f8b0662974af2cd32f293 | 2 | NULL | NO | f | f | t | t | f | t | 0 | 100000 | t | t | 0 | 0 | t
