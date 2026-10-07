-- Attribution outcome resolver schedule (STEP 15 PR 3). Run ONCE, by hand, in the
-- SQL editor — AFTER migration 20261008020000 is applied and the
-- attribution-outcome-resolver function is deployed (docs/DEPLOYMENT.md).
--
-- Writes only trade_attribution section G for HYPOTHETICAL (dry-run) fills and
-- trade_attribution_events. No order, position, account, ledger or provider call.
-- Every 15 minutes, offset from the scanner's :00/:10 full scans.
--
-- Verify:     select jobname, schedule, active from cron.job where jobname = 'attribution-outcome-resolver-15m';
-- Unschedule: select cron.unschedule('attribution-outcome-resolver-15m');

select cron.schedule('attribution-outcome-resolver-15m', '7,22,37,52 * * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/attribution-outcome-resolver',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
$job$);
