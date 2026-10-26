-- V3.2c state service schedule (PR3). Run ONCE, by hand, in the SQL editor — AFTER migration 20261027000000 is applied, the
-- v32c-state function is deployed, and the secret V32C_STATE_RUNNER=on is set (docs/DEPLOYMENT.md).
--
-- Writes only structure_v3_snapshots / structure_v3_checkpoints / structure_v3_audit. No order, position, account, ledger or
-- provider call. One call per pair (keeps each call well inside the edge CPU limit). Minute 40: the bar that closed at :00 is
-- canonical from the scanner's :20/:30 scan (settled ≥ close + 15 min); minute 55 is a catch-up that is a no-op when nothing is new.
--
-- Verify:     select jobname, schedule, active from cron.job where jobname = 'v32c-state-hourly';
-- Unschedule: select cron.unschedule('v32c-state-hourly');

select cron.schedule('v32c-state-hourly', '40,55 * * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/v32c-state',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := jsonb_build_object('pair', p),
    timeout_milliseconds := 60000
  )
  FROM unnest(array['EUR/USD','GBP/USD','USD/JPY','CHF/JPY','NZD/CAD','NZD/CHF']) AS p;
$job$);
