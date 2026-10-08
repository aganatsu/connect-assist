-- FINAL PRE-UNLOCK AUDIT — catalog facts PostgREST cannot see. READ-ONLY (one SELECT, one row).
-- Migrations: some step scripts (PR627/629/630, step 8) did not insert a schema_migrations row under the
-- repo version, so each required migration is proven by its recorded row OR by the object it created.
-- Cron: expected active set from the Step 16 audit; anything else is a finding.
with req(version, marker_ok) as (values
  ('20261006000000', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'paper_trade_history' and column_name = 'closed_at_raw')),
  ('20261006010000', to_regclass('public.paper_account_ledger') is not null),
  ('20261006020000', to_regclass('public.settlement_monitor_runs') is not null),
  ('20261006030000', to_regclass('public.account_reset_runs') is not null),
  ('20261006040000', exists (select 1 from pg_trigger where tgname = 'trg_paper_accounts_entries_lock_guard' and tgenabled <> 'D')),
  ('20261006050000', (select mode from public.paper_ledger_guard where id = 1) = 'enforce'),
  ('20261006060000', (select prosrc from pg_proc where oid = 'public.paper_accounts_entries_lock_guard()'::regprocedure) like '%auth.role()%'),
  ('20261006070000', to_regprocedure('public.take_account_reset_snapshot(uuid)') is not null or exists (select 1 from pg_proc where proname = 'take_account_reset_snapshot')),
  ('20261007000000', (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in ('trg_paper_positions_entries_lock', 'trg_pending_orders_entries_lock', 'trg_pending_orders_dry_run_immutable')) = 3),
  ('20261007010000', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'prop_firm_config' and column_name = 'daily_entry_stop_pct')),
  ('20261008000000', to_regclass('public.trade_attribution') is not null),
  ('20261008010000', exists (select 1 from pg_trigger where tgname = 'pending_orders_attribution' and tgenabled <> 'D')),
  ('20261008020000', exists (select 1 from pg_proc where proname = 'attribution_resolve_hypothetical')),
  ('20261009000000', (select md5(prosrc) from pg_proc where oid = 'public.pending_orders_attribution()'::regprocedure) = 'd5067c30cde71430a929504dc9e670d7'),
  ('20261009010000', (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account_if_flat(uuid,text,numeric,text)'::regprocedure) = 'de37b22a841c365c3c83a0712b1eb2db'),
  ('20261009020000', not has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute')
                     and not has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute')),
  ('20261009030000', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.real_exposure_admission_guard()')) = '4ade726424070850f851acef170f36bf')
), mig as (
  select r.version, r.marker_ok,
         exists (select 1 from supabase_migrations.schema_migrations m where m.version = r.version) as recorded
    from req r
), cron_expected(jobname) as (values
  ('bot-scanner-every-5min'), ('manage-positions-1min'), ('attribution-outcome-resolver-15m'), ('settlement-monitor-4h'),
  ('scanner-operational-health-1min'), ('outcome-tracker-hourly'), ('kv-cache-cleanup-hourly'), ('daily-cleanup')
), cron as (
  select j.jobname, j.schedule, j.active,
         coalesce(substring(j.command from '/functions/v1/([a-z0-9-]+)'), left(regexp_replace(j.command, '\s+', ' ', 'g'), 60)) as target,
         substring(j.command from 'body := ''([^'']*)''') as body,
         (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours') as runs_24h,
         (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours' and d.status <> 'succeeded') as failed_24h
    from cron.job j
)
select
  (select count(*) from mig where marker_ok) || '/17' as migration_objects_present,
  (select string_agg(version, ',' order by version) from mig where recorded) as recorded_versions,
  (select string_agg(version, ',' order by version) from mig where not recorded) as not_recorded_but_object_present,
  (select string_agg(version, ',' order by version) from mig where not marker_ok) as object_missing,
  (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D'
      and ((tgname = 'paper_positions_serialize_with_reset' and tgrelid = 'public.paper_positions'::regclass)
        or (tgname = 'pending_orders_serialize_with_reset' and tgrelid = 'public.pending_orders'::regclass))) as step17c_triggers_enabled,
  (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') as created_at_default,
  (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') as created_at_nullable,
  has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as auth_exec_unguarded,
  has_function_privilege('authenticated', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute') as auth_exec_guarded,
  has_function_privilege('anon', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute') as anon_exec_guarded,
  (select mode from public.paper_ledger_guard where id = 1) as ledger_guard_mode,
  (select string_agg(jobname, ',' order by jobname) from cron where active) as cron_active,
  (select string_agg(e.jobname, ',') from cron_expected e where not exists (select 1 from cron c where c.jobname = e.jobname and c.active)) as cron_expected_missing,
  (select string_agg(c.jobname, ',') from cron c where c.active and c.jobname not in (select jobname from cron_expected)) as cron_unexpected_active,
  (select string_agg(jobname || ' ' || schedule || ' → ' || target || coalesce(' ' || body, ''), ' | ' order by jobname) from cron where active
      and jobname in ('bot-scanner-every-5min', 'manage-positions-1min')) as scanner_jobs,
  (select coalesce(sum(failed_24h), 0) from cron where active) as cron_failed_24h,
  coalesce((select count(*) from mig where marker_ok) = 17
   and (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D'
         and ((tgname = 'paper_positions_serialize_with_reset' and tgrelid = 'public.paper_positions'::regclass)
           or (tgname = 'pending_orders_serialize_with_reset' and tgrelid = 'public.pending_orders'::regclass))) = 2
   and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') is null
   and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') = 'NO'
   and not has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute')
   and has_function_privilege('authenticated', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
   and not has_function_privilege('anon', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
   and (select mode from public.paper_ledger_guard where id = 1) = 'enforce'
   and not exists (select 1 from cron_expected e where not exists (select 1 from cron c where c.jobname = e.jobname and c.active))
   and not exists (select 1 from cron c where c.active and c.jobname not in (select jobname from cron_expected)), false) as catalog_all_pass;
-- expect: 17/17 | (recorded list) | (scripts that recorded no row, if any) | NULL | 2 | NULL | NO | f | t | f | enforce
--         | (the 8 expected jobs) | NULL | NULL | bot-scanner-every-5min */5 … → bot-scanner | manage-positions-1min * * * * * → bot-scanner {"action":"manage"…}
--         | 0 | t
