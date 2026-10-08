-- Client (anon / authenticated) write paths that can create exposure. READ-ONLY (one SELECT, one row).
-- Before D1: the four finalize_*/retarget columns are expected TRUE (the hole); after D1 all FALSE.
-- Before D2: d2_admission_triggers 0 and every pending_orders write privilege TRUE; after D2: triggers 2, pending_orders
-- client write privileges all FALSE (auth_select_orders stays TRUE); paper_positions privileges unchanged by design.
select
  has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') as anon_finalize_market_entry,
  has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') as auth_finalize_market_entry,
  has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') as anon_finalize_pending_fill,
  has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') as auth_finalize_pending_fill,
  (select prosecdef from pg_proc where oid = 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)'::regprocedure) as market_entry_secdef,
  has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') as anon_finalize_live_broker,
  has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') as auth_finalize_live_broker,
  has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as anon_retarget_pending,
  has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as auth_retarget_pending,
  (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D') as d2_admission_triggers,
  has_function_privilege('authenticated', 'public.route2_place_order(jsonb,jsonb,jsonb)', 'execute') as auth_route2_place,
  has_function_privilege('authenticated', 'public.route2_claim_and_fill(uuid,uuid,integer,jsonb,jsonb)', 'execute') as auth_route2_claim,
  has_table_privilege('authenticated', 'public.paper_positions', 'insert') as auth_insert_positions,
  has_table_privilege('authenticated', 'public.pending_orders', 'insert') as auth_insert_orders,
  has_table_privilege('authenticated', 'public.pending_orders', 'update') as auth_update_orders,
  has_table_privilege('authenticated', 'public.paper_accounts', 'update') as auth_update_accounts,
  has_table_privilege('authenticated', 'public.pending_orders', 'delete') as auth_delete_orders,
  has_table_privilege('authenticated', 'public.pending_orders', 'truncate') as auth_truncate_orders,
  has_table_privilege('authenticated', 'public.pending_orders', 'select') as auth_select_orders,
  has_table_privilege('anon', 'public.pending_orders', 'insert') or has_table_privilege('anon', 'public.pending_orders', 'update')
    or has_table_privilege('anon', 'public.pending_orders', 'delete') as anon_write_orders,
  has_table_privilege('anon', 'public.paper_positions', 'insert') as anon_insert_positions,
  (select string_agg(polname || ':' || polcmd::text, ', ' order by polname) from pg_policy where polrelid = 'public.paper_positions'::regclass) as position_policies,
  (select string_agg(polname || ':' || polcmd::text, ', ' order by polname) from pg_policy where polrelid = 'public.pending_orders'::regclass) as order_policies,
  (select relrowsecurity from pg_class where oid = 'public.paper_positions'::regclass) as positions_rls_on,
  (select relrowsecurity from pg_class where oid = 'public.pending_orders'::regclass) as orders_rls_on;
