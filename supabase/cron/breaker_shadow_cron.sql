-- Breaker shadow schedule. Run ONCE, by hand, in the SQL editor — AFTER migration 20261103000000 is applied and the breaker-shadow
-- function is deployed. Writes only breaker_shadow_*; accounts with Bot Config → "Breaker Shadow" off are untouched. Every 10 minutes
-- at :08, :18, … (after the scanner and the V3 shadow). It reads the canonical 5m bars, which are final about 20–30 minutes after each
-- bar's close, so it trails real time by roughly that much.
--
-- Verify:     select jobname, schedule, active from cron.job where jobname = 'breaker-shadow-10m';
-- Unschedule: select cron.unschedule('breaker-shadow-10m');

select cron.schedule('breaker-shadow-10m', '8-59/10 * * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/breaker-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
