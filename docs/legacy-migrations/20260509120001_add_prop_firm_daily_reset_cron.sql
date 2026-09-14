-- Prop Firm Daily Reset Cron Jobs
-- Runs at both 22:00 UTC and 23:00 UTC; the function itself guards against
-- executing at the wrong time based on DST (CEST vs CET).
-- This ensures correct reset timing year-round without manual DST switching.

SELECT cron.schedule(
  'prop-firm-daily-reset-summer',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/prop-firm-daily-reset',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{"source": "cron_summer"}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'prop-firm-daily-reset-winter',
  '0 23 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/prop-firm-daily-reset',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{"source": "cron_winter"}'::jsonb
  );
  $$
);
