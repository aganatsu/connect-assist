-- Settlement monitor schedule. Run ONCE, by hand, in the SQL editor — AFTER the
-- settlement-monitor function is deployed and migration 20261006020000 is
-- applied (docs/DEPLOYMENT.md). Not a migration: it needs pg_cron, pg_net and
-- the same three Vault secrets the other jobs use (supabase_url,
-- service_role_key, cron_secret).
--
-- READ-ONLY monitoring. The function writes only settlement_monitor_runs and
-- sends Telegram on failure. Nothing here changes trading state, the guard
-- mode, or the account.
--
-- pg_cron on Supabase runs in UTC.
--   settlement-monitor-4h     every 4h at :17 (00:17, 04:17, … 20:17 UTC)
--   settlement-monitor-final  ONCE at 2026-10-06 17:25 UTC — 24h after the
--                             ledger epoch started (2026-10-05 17:20:36 UTC).
--                             It posts the window verdict, then unschedules
--                             itself. It does NOT enable blocking or reset.
--
-- Verify:     select jobname, schedule, active from cron.job where jobname like 'settlement-monitor%';
-- Results:    select run_at, mode, pass, failures from public.settlement_monitor_runs order by run_at desc;
-- Unschedule: select cron.unschedule('settlement-monitor-4h');

select cron.schedule('settlement-monitor-4h', '17 */4 * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/settlement-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"mode":"periodic"}'::jsonb
  );
$job$);

select cron.schedule('settlement-monitor-final', '25 17 6 10 *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/settlement-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"mode":"final"}'::jsonb
  );
  SELECT cron.unschedule('settlement-monitor-final');
$job$);

-- First periodic run now, so the window has a data point from the start.
SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/settlement-monitor',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
    'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
  ),
  body := '{"mode":"periodic"}'::jsonb
);
