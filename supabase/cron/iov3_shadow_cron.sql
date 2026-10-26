-- Impulse-on-V3 shadow schedule (step 3). Run ONCE, by hand, in the SQL editor — AFTER migration 20261028000000 is applied,
-- the iov3-shadow function is deployed, and the secret IOV3_SHADOW_RUNNER=on is set (docs/DEPLOYMENT.md).
--
-- Writes only iov3_shadow_* (and creates a shadow cohort when an account is in SHADOW). No order, position, account, ledger or
-- provider call. Accounts whose switch is OFF are untouched. Every 10 minutes at :06, :16, …. The shadow reads the canonical 5m
-- bars bot-scanner records (structure_bars_5m, needs STRUCTURE_BARS_5M_LIVE_WRITE=on), which are final about 20–30 minutes after
-- each bar's close, so the shadow trails real time by roughly that much.
--
-- Verify:     select jobname, schedule, active from cron.job where jobname = 'iov3-shadow-10m';
-- Unschedule: select cron.unschedule('iov3-shadow-10m');

select cron.schedule('iov3-shadow-10m', '6-59/10 * * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/iov3-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := jsonb_build_object('pair', p),
    timeout_milliseconds := 60000
  )
  FROM unnest(array['EUR/USD','GBP/USD','USD/JPY','CHF/JPY','NZD/CAD','NZD/CHF']) AS p;
$job$);
