-- Outcome Tracker cron: runs every hour to check counterfactual outcomes
-- for rejected setups and handle 30-day retention cleanup.
--
-- NOTE: Replace YOUR_PROJECT_REF with your actual Supabase project reference.
-- The service_role key is read from the vault at runtime.
SELECT cron.schedule(
  'outcome-tracker-hourly',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/outcome-tracker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
