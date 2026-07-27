-- Fix bot-scanner cron jobs to use Vault-sourced service_role_key and x-cron-secret.
--
-- PREREQUISITE: The following secrets must exist in the Vault:
--   - supabase_url (the project's base URL)
--   - service_role_key (the service role JWT)
--   - cron_secret (the shared cron authentication secret)
--
-- These were already added by the earlier cron-secret-guard migration
-- (20260726120001). This migration just brings the two bot-scanner jobs
-- into alignment with the pattern established there.
--
-- WHAT THIS FIXES:
-- 1. bot-scanner-every-5min (jobid 1): was using a hardcoded anon key with
--    no x-cron-secret — would be rejected by the new verifyCronOrUserCaller
--    guard since anon key is neither a valid user JWT nor a cron secret.
-- 2. manage-positions-1min (jobid 28): was using Vault service_role_key but
--    no x-cron-secret — would be rejected because verifyCronOrUserCaller
--    explicitly rejects service_role_key on the user-auth path and requires
--    x-cron-secret for the cron path.
--
-- pg_cron's cron.schedule() updates in place when the jobname already exists.

-- ─── bot-scanner-every-5min (scan all active accounts) ─────────────────────
SELECT cron.schedule(
  'bot-scanner-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/bot-scanner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"action": "scan"}'::jsonb
  );
  $$
);

-- ─── manage-positions-1min (position management loop) ──────────────────────
SELECT cron.schedule(
  'manage-positions-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/bot-scanner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"action": "manage"}'::jsonb
  );
  $$
);
