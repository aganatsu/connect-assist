-- Data migration: OLD (Lovable) project  ->  NEW project
--
-- Lovable Cloud exposes only the SQL editor and edge functions, so there is no
-- connection string for the old project and pg_dump is not an option. But the
-- old database has pg_net (its cron jobs use it), so it can POST its own rows
-- straight to the new project's REST API. Nothing passes through the browser,
-- which matters: rejected_setups alone is 31 MB and pending_orders 23 MB.
--
-- scan_logs is NOT carried. It is 856 MB on its own, larger than the whole
-- 500 MB free tier. The old project stays up, so scan-log analysis continues
-- there.
--
-- RUN ORDER
--   STEP 1  in the OLD SQL editor  -> produces two INSERTs for the auth user
--   STEP 2  in the NEW SQL editor  -> run what STEP 1 printed
--   STEP 3  in the OLD SQL editor  -> pushes every table
--   STEP 4  in the NEW SQL editor  -> verify counts
--
-- STEP 1 must come first. Every table has a user_id foreign key to auth.users
-- and the new project has no users, so any row inserted before the user exists
-- is rejected.


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 1 — run in the OLD project. Copy both result rows.
-- ─────────────────────────────────────────────────────────────────────────
-- Columns are listed explicitly and generated ones excluded via
-- attgenerated = ''. auth.users has a generated column (confirmed_at, derived
-- from email_confirmed_at and phone_confirmed_at) and inserting into it fails.

select format(
         'insert into auth.users (%s) select %s from json_populate_record(null::auth.users, %L::json);',
         c.cols, c.cols, to_json(u)::text)
from auth.users u
cross join lateral (
  select string_agg(quote_ident(attname), ', ' order by attnum) as cols
  from pg_attribute
  where attrelid = 'auth.users'::regclass
    and attnum > 0 and not attisdropped and attgenerated = ''
) c
union all
select format(
         'insert into auth.identities (%s) select %s from json_populate_record(null::auth.identities, %L::json);',
         c.cols, c.cols, to_json(i)::text)
from auth.identities i
cross join lateral (
  select string_agg(quote_ident(attname), ', ' order by attnum) as cols
  from pg_attribute
  where attrelid = 'auth.identities'::regclass
    and attnum > 0 and not attisdropped and attgenerated = ''
) c;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 2 — run the two statements STEP 1 printed, in the NEW project.
-- ─────────────────────────────────────────────────────────────────────────
-- Inserting the row rather than signing up fresh keeps the UUID
-- 57c79dee-db6b-4fae-b34a-4b64ce33ca34 that every other table references, and
-- carries the password hash so the existing login still works.
--
-- The on_auth_user_created_profile trigger fires here and creates the profiles
-- row automatically, which is why profiles is not in the push list below.


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 3 — run in the OLD project, after replacing the key on the next line.
-- ─────────────────────────────────────────────────────────────────────────
-- Get the key from the NEW project: Settings -> API Keys -> create a secret
-- key (sb_secret_...). Revoke it when this is done. Do not use the
-- publishable key; it cannot write past row-level security.

do $$
declare
  new_key  text := 'PASTE_NEW_PROJECT_SECRET_KEY_HERE';
  base_url text := 'https://rvouzhacxqlbetwcttoe.supabase.co/rest/v1/';
  -- Dependency order: a parent is always pushed before anything referencing
  -- it. broker_connections before bot_configs, pending_orders before
  -- paper_trade_history.
  tables   text[] := array[
    'api_credit_usage','bot_config_change_log','bot_recommendations',
    'broker_connections','close_audit_log','config_presets',
    'game_plan_refresh_status','paper_accounts','pending_orders',
    'prop_firm_config','rejected_setups','scanner_health_monitor_state',
    'scanner_runtime_locks','trade_reasonings','user_settings',
    'bot_configs','broker_execution_ledger','paper_trade_history'
  ];
  tbl        text;
  gen_cols   text[];
  batch      int := 50;      -- ~800 KB per request on the widest tables
  off        int;
  payload    jsonb;
  sent       int;
  total_sent int := 0;
begin
  if new_key = 'PASTE_NEW_PROJECT_SECRET_KEY_HERE' then
    raise exception 'Replace new_key with the secret key from the new project first';
  end if;

  foreach tbl in array tables loop
    -- Generated columns are computed by the destination and rejected on
    -- insert. pending_orders has 11 of them, all derived from
    -- frozen_strategy_context.
    select coalesce(array_agg(attname), '{}')
      into gen_cols
      from pg_attribute
     where attrelid = ('public.' || tbl)::regclass
       and attnum > 0 and not attisdropped and attgenerated <> '';

    off := 0; sent := 0;
    loop
      execute format(
        'select jsonb_agg(to_jsonb(t) - %L::text[]) from (select * from public.%I order by ctid limit %s offset %s) t',
        gen_cols, tbl, batch, off)
      into payload;

      exit when payload is null;

      -- These four point at tables we are deliberately not carrying
      -- (active_direction_verdicts, active_game_plans,
      -- impulse_entry_lifecycles, staged_setups). Left as-is they would be
      -- dangling references; nulled, the rest of the row survives intact.
      if tbl = 'pending_orders' then
        select jsonb_agg(e || jsonb_build_object(
                 'direction_verdict_id', null, 'game_plan_id', null,
                 'impulse_entry_lifecycle_id', null, 'staged_setup_id', null))
          into payload
          from jsonb_array_elements(payload) e;
      end if;

      perform net.http_post(
        url     := base_url || tbl,
        headers := jsonb_build_object(
                     'apikey', new_key,
                     'Authorization', 'Bearer ' || new_key,
                     'Content-Type', 'application/json',
                     'Prefer', 'return=minimal'),
        body    := payload);

      sent := sent + jsonb_array_length(payload);
      off  := off + batch;
    end loop;

    total_sent := total_sent + sent;
    raise notice '% -> % rows queued', tbl, sent;
  end loop;

  raise notice 'queued % rows in total', total_sent;
end $$;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 3b — run in the OLD project a minute later. pg_net is asynchronous:
-- the DO block queues requests and returns before they are delivered.
-- ─────────────────────────────────────────────────────────────────────────
-- Anything other than 201 is a failed batch. content shows PostgREST's reason.

select status_code, count(*) as batches,
       min(left(content, 300)) as sample_error
from net._http_response
where created > now() - interval '30 minutes'
group by status_code
order by status_code;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 4 — run in the NEW project. Compare against the old project's counts.
-- ─────────────────────────────────────────────────────────────────────────

select 'auth.users' as table_name, count(*) from auth.users
union all select 'profiles',                     count(*) from profiles
union all select 'api_credit_usage',             count(*) from api_credit_usage
union all select 'bot_config_change_log',        count(*) from bot_config_change_log
union all select 'bot_configs',                  count(*) from bot_configs
union all select 'bot_recommendations',          count(*) from bot_recommendations
union all select 'broker_connections',           count(*) from broker_connections
union all select 'broker_execution_ledger',      count(*) from broker_execution_ledger
union all select 'close_audit_log',              count(*) from close_audit_log
union all select 'config_presets',               count(*) from config_presets
union all select 'game_plan_refresh_status',     count(*) from game_plan_refresh_status
union all select 'paper_accounts',               count(*) from paper_accounts
union all select 'paper_trade_history',          count(*) from paper_trade_history
union all select 'pending_orders',               count(*) from pending_orders
union all select 'prop_firm_config',             count(*) from prop_firm_config
union all select 'rejected_setups',              count(*) from rejected_setups
union all select 'scanner_health_monitor_state', count(*) from scanner_health_monitor_state
union all select 'scanner_runtime_locks',        count(*) from scanner_runtime_locks
union all select 'trade_reasonings',             count(*) from trade_reasonings
union all select 'user_settings',                count(*) from user_settings
order by 1;
