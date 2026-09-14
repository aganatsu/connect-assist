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


select cron.schedule('advisor-daily', '0 22 * * *', '
  SELECT net.http_post(
    url := ''https://rvouzhacxqlbetwcttoe.supabase.co/functions/v1/advisor'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := ''{"mode": "daily"}''::jsonb
  );
  ');

select cron.schedule('advisor-weekly', '0 23 * * 0', '
  SELECT net.http_post(
    url := ''https://rvouzhacxqlbetwcttoe.supabase.co/functions/v1/advisor'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := ''{"mode": "weekly"}''::jsonb
  );
  ');

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

select cron.schedule('game-plan-authority-refresh-15min', '*/15 * * * *', '
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''supabase_url'') || ''/functions/v1/game-plan-refresh'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := jsonb_build_object(
      ''action'', ''refresh'',
      ''source'', ''scheduled'',
      ''userId'', account.user_id
    )
  )
  FROM public.paper_accounts account
  WHERE account.bot_id = ''smc''
    AND account.is_running = true;
  ');

select cron.schedule('impulse-lifecycle-shadow-monitor-5min', '*/5 * * * *', '
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''supabase_url'') || ''/functions/v1/impulse-lifecycle-replay'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
      ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''cron_secret'')
    ),
    body := ''{"action":"monitor"}''::jsonb
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

