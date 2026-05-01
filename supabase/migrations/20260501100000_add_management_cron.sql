-- Management-only cron: runs every 1 minute to handle trailing stop, break-even,
-- partial TP, SL/TP hit detection, and pending order fill/expiry monitoring.
-- This is separate from the full scan cron (every 5 min) and doesn't place new trades.
--
-- NOTE: You must replace YOUR_PROJECT_REF with your actual Supabase project reference.
-- The service_role key is read from the vault at runtime.

SELECT cron.schedule(
  'manage-positions-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/bot-scanner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{"action": "manage"}'::jsonb
  );
  $$
);
