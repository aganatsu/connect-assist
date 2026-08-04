-- Refresh Game Plan authority independently from the trade scanner.

CREATE TABLE IF NOT EXISTS public.game_plan_refresh_status (
  user_id UUID NOT NULL,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'succeeded', 'failed', 'skipped')),
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  active_plan_expires_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_message TEXT,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bot_id)
);
ALTER TABLE public.game_plan_refresh_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own Game Plan refresh status" ON public.game_plan_refresh_status;
CREATE POLICY "Users read own Game Plan refresh status"
  ON public.game_plan_refresh_status FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE ALL ON public.game_plan_refresh_status FROM anon;
GRANT SELECT ON public.game_plan_refresh_status TO authenticated;
GRANT ALL ON public.game_plan_refresh_status TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'game-plan-authority-refresh-15min';

SELECT cron.schedule(
  'game-plan-authority-refresh-15min',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/game-plan-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := jsonb_build_object(
      'action', 'refresh',
      'source', 'scheduled',
      'userId', account.user_id
    )
  )
  FROM public.paper_accounts account
  WHERE account.bot_id = 'smc'
    AND account.is_running = true;
  $cron$
);
