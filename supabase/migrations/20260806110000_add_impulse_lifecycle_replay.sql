CREATE TABLE IF NOT EXISTS public.impulse_entry_lifecycle_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  lifecycle_id UUID NOT NULL REFERENCES public.impulse_entry_lifecycles(id) ON DELETE CASCADE,
  snapshot_id UUID NOT NULL REFERENCES public.scan_candle_snapshots(id) ON DELETE CASCADE,
  evidence_source TEXT NOT NULL DEFAULT 'retrospective_replay' CHECK (
    evidence_source IN ('forward_observation', 'retrospective_replay', 'backtest')
  ),
  contract_version TEXT NOT NULL DEFAULT 'impulse-lifecycle-replay.v1',
  result JSONB NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost', 'inconclusive', 'no_entry')),
  entered BOOLEAN NOT NULL,
  rescued_deeper_entry BOOLEAN NOT NULL,
  retained_winner BOOLEAN NOT NULL,
  mfe NUMERIC,
  mae NUMERIC,
  replayed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT impulse_lifecycle_replay_unique UNIQUE (
    lifecycle_id, snapshot_id, evidence_source
  ),
  CONSTRAINT impulse_lifecycle_replay_contract CHECK (
    result ->> 'contractVersion' = 'impulse-lifecycle-replay.v1'
  )
);

CREATE INDEX IF NOT EXISTS idx_impulse_lifecycle_replay_summary
  ON public.impulse_entry_lifecycle_replays (
    user_id, bot_id, evidence_source, outcome, rescued_deeper_entry
  );
ALTER TABLE public.impulse_entry_lifecycle_replays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own impulse lifecycle replays"
  ON public.impulse_entry_lifecycle_replays;
CREATE POLICY "Users read own impulse lifecycle replays"
  ON public.impulse_entry_lifecycle_replays FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages impulse lifecycle replays"
  ON public.impulse_entry_lifecycle_replays;
CREATE POLICY "Service manages impulse lifecycle replays"
  ON public.impulse_entry_lifecycle_replays FOR ALL TO service_role
  USING (true) WITH CHECK (true);
GRANT SELECT ON public.impulse_entry_lifecycle_replays TO authenticated, service_role;
GRANT ALL ON public.impulse_entry_lifecycle_replays TO service_role;

CREATE OR REPLACE VIEW public.impulse_entry_lifecycle_replay_summary
WITH (security_invoker = true) AS
SELECT
  user_id, bot_id, evidence_source,
  COUNT(*) AS replay_count,
  COUNT(*) FILTER (WHERE entered) AS entries,
  COUNT(*) FILTER (WHERE rescued_deeper_entry) AS deeper_entries,
  COUNT(*) FILTER (WHERE rescued_deeper_entry AND outcome = 'won') AS rescued_winners,
  COUNT(*) FILTER (WHERE retained_winner) AS winners_retained,
  COUNT(*) FILTER (WHERE rescued_deeper_entry AND outcome = 'lost') AS added_losses,
  COUNT(*) FILTER (WHERE outcome = 'won') AS winners,
  COUNT(*) FILTER (WHERE outcome = 'lost') AS losers,
  ROUND(AVG(mfe), 6) AS avg_mfe,
  ROUND(AVG(mae), 6) AS avg_mae,
  COUNT(*) FILTER (WHERE outcome IN ('won', 'lost')) >= 30 AS minimum_sample_ready
FROM public.impulse_entry_lifecycle_replays
GROUP BY user_id, bot_id, evidence_source;
GRANT SELECT ON public.impulse_entry_lifecycle_replay_summary TO authenticated, service_role;

SELECT cron.schedule(
  'impulse-lifecycle-shadow-monitor-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/impulse-lifecycle-replay',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"action":"monitor"}'::jsonb
  );
  $$
);
