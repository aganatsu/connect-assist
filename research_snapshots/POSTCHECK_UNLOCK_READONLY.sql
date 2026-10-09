-- POST-UNLOCK READ-ONLY verification (one SELECT, one row). Run right after UNLOCK_ATOMIC_AT_ZERO_DRY.sql. Safe to re-run.
select
  a.balance, a.is_paused, a.entries_locked, a.kill_switch_active, a.entries_locked_at as live_from, a.entries_locked_reason,
  (select count(*) from public.paper_positions) as positions,
  (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) as active_real_orders,
  (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is true) as active_dry_orders,
  (select config_version from public.bot_configs where id = '327912ae-4e5b-4677-ad04-7c5d566f7990') as config_version,
  (select drift from public.paper_account_reconciliation where account_id = a.id) as drift,
  (select unledgered_writes_this_epoch from public.paper_account_reconciliation where account_id = a.id) as unledgered_writes,
  has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute')
    or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute')
    or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
    or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
    or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute')
    or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute')
    or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as d1_any_client_exec,
  has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    or has_table_privilege('anon', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as d2_client_write_orders,
  has_table_privilege('authenticated', 'public.pending_orders', 'SELECT') as d2_client_select_orders,
  (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D'
      and ((tgrelid = 'public.pending_orders'::regclass and tgtype = 31) or (tgrelid = 'public.paper_positions'::regclass and tgtype = 7))) as d2_d3_admission_triggers,
  (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.real_exposure_admission_guard()')) as guard_md5,
  (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset',
      'trg_paper_positions_entries_lock', 'trg_pending_orders_entries_lock', 'trg_pending_orders_dry_run_immutable')) as safety_triggers,
  (select mode from public.paper_ledger_guard where id = 1) as ledger_guard,
  (select bool_or(active) from cron.job where jobname = 'bot-scanner-every-5min') as scanner_cron_active,
  (select bool_or(active) from cron.job where jobname = 'manage-positions-1min') as manage_cron_active,
  coalesce(a.balance = 100000 and not a.is_paused and not a.entries_locked and not a.kill_switch_active
   and (select count(*) from public.paper_positions) = 0
   and (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered')) = 0
   and (select config_version from public.bot_configs where id = '327912ae-4e5b-4677-ad04-7c5d566f7990') = '1037e6170289f865e4d6618dcf28b94d'
   and (select drift from public.paper_account_reconciliation where account_id = a.id) = 0
   and not (has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute')
         or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute')
         or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
         or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
         or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute')
         or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute')
         or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute')
         or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute'))
   and not (has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
         or has_table_privilege('anon', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
   and (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D'
         and ((tgrelid = 'public.pending_orders'::regclass and tgtype = 31) or (tgrelid = 'public.paper_positions'::regclass and tgtype = 7))) = 2
   and (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.real_exposure_admission_guard()')) = '4ade726424070850f851acef170f36bf'
   and (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset',
         'trg_paper_positions_entries_lock', 'trg_pending_orders_entries_lock', 'trg_pending_orders_dry_run_immutable')) = 5
   and (select mode from public.paper_ledger_guard where id = 1) = 'enforce', false) as all_pass
from public.paper_accounts a where a.bot_id = 'smc';
-- expect: 100000 | f | f | f | <live_from> | UNLOCKED (atomic, zero dry-run orders) … | 0 | 0 | 0 | 1037e6170289f865e4d6618dcf28b94d | 0 | 0
--         | f | f | t | 2 | 4ade726424070850f851acef170f36bf | 5 | enforce | f (scanner cron intentionally off) | t | t
