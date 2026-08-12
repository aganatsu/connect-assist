-- Keep enough history to diagnose, without changing what is enforced.
--
-- 20260812020000 pruned rows older than two windows (120s), which is all the
-- enforcement needs — the count only ever looks back 60s. But it also means the
-- table can never show more than ~2 minutes, and the first question asked of it
-- was a shape question: is the budget saturated continuously, or does it spike
-- to the cap and go quiet?
--
-- Those have opposite answers. Continuous saturation means real over-demand:
-- fewer pairs, longer intervals, or a bigger plan. Bursty saturation means the
-- credits exist but are spent in a lump, and the fix is pacing. The first
-- reading (50, 49 back to back) looked continuous; the second (15, 50, 30, 0, 0)
-- looks bursty. Two minutes of visibility cannot settle it.
--
-- Retention is a separate concern from the rate window and is now stated as
-- such. At 50/min, 30 minutes is ~1500 rows.

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
  -- How long rows stick around for inspection. Deliberately unrelated to
  -- p_window_seconds: shortening the rate window must not silently shorten
  -- the audit trail.
  retention_seconds CONSTANT INT := 1800;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('api_credit:' || p_provider));

  DELETE FROM public.api_credit_usage
   WHERE provider = p_provider
     AND reserved_at < now() - make_interval(secs => retention_seconds);

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
