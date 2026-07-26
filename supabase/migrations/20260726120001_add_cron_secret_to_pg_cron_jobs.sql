-- Add x-cron-secret header to all pg_cron jobs that invoke edge functions.
--
-- PREREQUISITE: Before applying this migration, the 'cron_secret' must exist
-- in the Supabase Vault:
--   INSERT INTO vault.secrets (name, secret)
--   VALUES ('cron_secret', '<your-generated-secret>');
--
-- Or via the Supabase Dashboard: Settings → Vault → Add Secret
-- Name: cron_secret
-- Value: (same value set via `supabase secrets set CRON_SECRET=...`)
--
-- pg_cron's cron.schedule() updates in place when the jobname already exists,
-- so this migration safely overwrites the existing job definitions.
--
-- Deploy this migration in the SAME release as the edge function changes
-- that add the x-cron-secret check.

-- ─── prop-firm-daily-reset (summer: 22:00 UTC) ─────────────────────────────

SELECT cron.schedule(
  'prop-firm-daily-reset-summer',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/prop-firm-daily-reset',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"source": "cron_summer"}'::jsonb
  );
  $$
);

-- ─── prop-firm-daily-reset (winter: 23:00 UTC) ─────────────────────────────

SELECT cron.schedule(
  'prop-firm-daily-reset-winter',
  '0 23 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/prop-firm-daily-reset',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"source": "cron_winter"}'::jsonb
  );
  $$
);

-- ─── outcome-tracker (hourly at :15) ───────────────────────────────────────

SELECT cron.schedule(
  'outcome-tracker-hourly',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://istpcfaokubxlualybhp.supabase.co/functions/v1/outcome-tracker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ─── optimizer (weekly: Sunday 22:00 UTC) ──────────────────────────────────

SELECT cron.schedule(
  'optimizer-weekly-run',
  '0 22 * * 0',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/optimizer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"source": "cron"}'::jsonb
  );
  $$
);
