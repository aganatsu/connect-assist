-- Refresh Game Plan authority independently from the trade scanner.

CREATE TABLE IF NOT EXISTS public.game_plan_refresh_status (
  user_id UUID NOT NULL,
  bot_id TEXT NOT NULL DEFAULT $s$smc$s$,
  status TEXT NOT NULL DEFAULT $s$idle$s$
    CHECK (status IN ($s$idle$s$, $s$running$s$, $s$succeeded$s$, $s$failed$s$, $s$skipped$s$)),
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  active_plan_expires_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_message TEXT,
  details JSONB NOT NULL DEFAULT $s${}$s$::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bot_id)
);
ALTER TABLE public.game_plan_refresh_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS $s$Users read own Game Plan refresh status$s$ ON public.game_plan_refresh_status;
CREATE POLICY $s$Users read own Game Plan refresh status$s$
  ON public.game_plan_refresh_status FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE ALL ON public.game_plan_refresh_status FROM anon;
GRANT SELECT ON public.game_plan_refresh_status TO authenticated;
GRANT ALL ON public.game_plan_refresh_status TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = $s$game-plan-authority-refresh-15min$s$;

SELECT cron.schedule(
  $s$game-plan-authority-refresh-15min$s$,
  $s$*/15 * * * *$s$,
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $s$supabase_url$s$) || $s$/functions/v1/game-plan-refresh$s$,
    headers := jsonb_build_object(
      $s$Content-Type$s$, $s$application/json$s$,
      $s$Authorization$s$, $s$Bearer $s$ || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $s$service_role_key$s$),
      $s$x-cron-secret$s$, (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $s$cron_secret$s$)
    ),
    body := jsonb_build_object(
      $s$action$s$, $s$refresh$s$,
      $s$source$s$, $s$scheduled$s$,
      $s$userId$s$, account.user_id
    )
  )
  FROM public.paper_accounts account
  WHERE account.bot_id = $s$smc$s$
    AND account.is_running = true;
  $cron$
);
