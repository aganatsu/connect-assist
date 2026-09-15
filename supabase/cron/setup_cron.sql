-- Cron jobs for connect-assist — run ONCE, by hand, after the baseline migration.
--
-- Not a migration: these embed the project ref (rvouzhacxqlbetwcttoe) and
-- require pg_cron + pg_net, and the three Vault secrets below, to exist first.
--
-- PREREQUISITES
--   1. Dashboard -> Database -> Extensions: enable pg_cron and pg_net
--   2. Vault secrets (Settings -> Vault), all three are read by the jobs:
--        supabase_url       https://rvouzhacxqlbetwcttoe.supabase.co
--        service_role_key   Settings -> API -> service_role key
--        cron_secret        any long random string; set the SAME value as the
--                           CRON_SECRET env var on your edge functions
--
-- Verify afterwards with:  select jobname, schedule, active from cron.job;
--
-- REMOVED 2026-09-14, four jobs that called functions which do not exist in
-- this repo. They were deployed to the old project through Lovable's console
-- and were never committed, the same way most of the schema was:
--
--   advisor-daily, advisor-weekly          -> functions/v1/advisor
--   game-plan-authority-refresh-15min      -> functions/v1/game-plan-refresh
--   impulse-lifecycle-shadow-monitor-5min  -> functions/v1/impulse-lifecycle-replay
--
-- Scheduling them would have produced a 404 every 5 to 15 minutes forever.
--
-- Nothing important is lost. bot-scanner generates the Game Plan itself
-- (index.ts around 4105-4167: regenerates on session change or after
-- gamePlanRefreshHours, default 4), so game-plan-refresh was a second path to
-- the same result. The lifecycle monitor was observational. The advisors are
-- bot-daily-review and bot-weekly-advisor in this repo, both of which still
-- require LOVABLE_API_KEY — re-add them here once that dependency is replaced.
--



select cron.schedule('bot-scanner-every-5min', '*/5 * * * *', '
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''supabase_url'') || ''/functions/v1/bot-scanner'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := ''{"action": "scan"}''::jsonb
  );
  ');

select cron.schedule('daily-cleanup', '0 3 * * *', '
  SELECT net.http_post(
    url := ''https://rvouzhacxqlbetwcttoe.supabase.co/functions/v1/data-cleanup'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := concat(''{"time": "'', now(), ''"}'')::jsonb
  );
  ');

select cron.schedule('kv-cache-cleanup-hourly', '15 * * * *', '
  DELETE FROM kv_cache WHERE expires_at < now();
  ');

select cron.schedule('manage-positions-1min', '* * * * *', '
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''supabase_url'') || ''/functions/v1/bot-scanner'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := ''{"action": "manage"}''::jsonb
  );
  ');

select cron.schedule('outcome-tracker-hourly', '15 * * * *', '
  SELECT net.http_post(
    url := ''https://rvouzhacxqlbetwcttoe.supabase.co/functions/v1/outcome-tracker'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key'' LIMIT 1),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'' LIMIT 1)
    ),
    body := ''{}''::jsonb
  );
  ');

select cron.schedule('prop-firm-daily-reset-summer', '0 22 * * *', '
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''supabase_url'') || ''/functions/v1/prop-firm-daily-reset'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := ''{"source": "cron_summer"}''::jsonb
  );
  ');

select cron.schedule('prop-firm-daily-reset-winter', '0 23 * * *', '
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''supabase_url'') || ''/functions/v1/prop-firm-daily-reset'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := ''{"source": "cron_winter"}''::jsonb
  );
  ');

select cron.schedule('scanner-operational-health-1min', '* * * * *', 'SELECT public.evaluate_scanner_operational_health();');

select cron.schedule('zone-confirmation-scanner-every-minute', '* * * * *', '
  SELECT net.http_post(
    url := ''https://rvouzhacxqlbetwcttoe.supabase.co/functions/v1/zone-confirmation-scanner'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key'' LIMIT 1),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'' LIMIT 1)
    ),
    body := ''{"action": "scan"}''::jsonb
  );
  ');

