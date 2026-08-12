-- Who is spending the budget?
--
-- 20260812020000 made the spend enforceable; it did not make it attributable.
-- Measured immediately after deploy, the budget sits pinned at exactly 50/min
-- (50, 49, 50, ...) — saturated, refusing requests above the cap. Demand
-- genuinely exceeds the plan.
--
-- Deciding what to do about that — fewer pairs, longer intervals, WebSocket for
-- live prices, or a bigger plan — depends on which caller is spending it, and
-- nothing currently records that. This column is the difference between tuning
-- and guessing.

ALTER TABLE public.api_credit_usage
  ADD COLUMN IF NOT EXISTS caller TEXT;

CREATE INDEX IF NOT EXISTS api_credit_usage_caller_time
  ON public.api_credit_usage (provider, caller, reserved_at DESC);

CREATE OR REPLACE FUNCTION public.reserve_api_credit(
  p_provider TEXT,
  p_limit INT,
  p_window_seconds INT DEFAULT 60,
  p_caller TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  used INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('api_credit:' || p_provider));

  DELETE FROM public.api_credit_usage
   WHERE provider = p_provider
     AND reserved_at < now() - make_interval(secs => p_window_seconds * 2);

  SELECT count(*) INTO used
    FROM public.api_credit_usage
   WHERE provider = p_provider
     AND reserved_at > now() - make_interval(secs => p_window_seconds);

  IF used >= p_limit THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.api_credit_usage (provider, caller) VALUES (p_provider, p_caller);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_api_credit(TEXT, INT, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_api_credit(TEXT, INT, INT, TEXT) TO service_role;

-- The 3-arg signature is KEPT, delegating with an explicit label.
--
-- Dropping it looked tidier, but migrations run before functions redeploy, and
-- in that window already-deployed code still calls the 3-arg form. PostgREST
-- would 404, reserveApiCredit fails open by design, and enforcement would
-- silently switch off for the length of the deploy — the exact failure this
-- whole line of work exists to prevent. A brief gap in attribution is a much
-- cheaper cost than a brief gap in enforcement.
--
-- 'unattributed' rather than NULL so a stale deploy is visible in the breakdown
-- instead of blending into rows that simply have no caller.
CREATE OR REPLACE FUNCTION public.reserve_api_credit(
  p_provider TEXT,
  p_limit INT,
  p_window_seconds INT DEFAULT 60
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.reserve_api_credit(p_provider, p_limit, p_window_seconds, 'unattributed');
$$;

REVOKE ALL ON FUNCTION public.reserve_api_credit(TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_api_credit(TEXT, INT, INT) TO service_role;
