-- Weekly Optimizer Cron Job
-- Runs every Sunday at 22:00 UTC (after markets close for the week).
-- Calls the optimizer edge function which handles deduplication internally.
-- Uses vault secrets for URL and service key (same pattern as prop-firm cron).

SELECT cron.schedule(
  'optimizer-weekly-run',
  '0 22 * * 0',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/optimizer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{"source": "cron"}'::jsonb
  );
  $$
);
