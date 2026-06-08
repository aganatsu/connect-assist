
-- backtest_runs: drop overly permissive policy (service_role bypasses RLS)
DROP POLICY IF EXISTS "Service role full access" ON public.backtest_runs;

-- bot_recommendations: drop overly permissive + duplicate policies
DROP POLICY IF EXISTS "Service role can insert recommendations" ON public.bot_recommendations;
DROP POLICY IF EXISTS "Service role can update recommendations" ON public.bot_recommendations;
DROP POLICY IF EXISTS "Users can view own recommendations" ON public.bot_recommendations;

-- rejected_setups: drop overly permissive policy
DROP POLICY IF EXISTS "Service role can manage rejected setups" ON public.rejected_setups;

-- scheduled_tasks: drop overly permissive policy
DROP POLICY IF EXISTS "Service role full access" ON public.scheduled_tasks;

-- scan_history: enable RLS + owner-scoped policy
ALTER TABLE public.scan_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own scan history"
  ON public.scan_history FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own scan history"
  ON public.scan_history FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- kv_cache: enable RLS — service role bypasses; no public policies needed
ALTER TABLE public.kv_cache ENABLE ROW LEVEL SECURITY;
