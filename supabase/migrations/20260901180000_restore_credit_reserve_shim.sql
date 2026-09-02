-- Restore the 3-arg reserve_api_credit to a delegating shim.
--
-- The database was never rolled back with the code. 20260812031000 (caller
-- attribution) and 20260812033000 (30-minute retention) are still live, so the
-- authoritative implementation is the 4-arg form: it records which caller spent
-- each credit and prunes on a retention window deliberately decoupled from the
-- rate window.
--
-- 20260901170000 re-introduced the 3-arg form from before those two migrations,
-- as a full body rather than the shim it had become. Two consequences:
--
--   1. Overload ambiguity. Both signatures accept exactly (p_provider, p_limit,
--      p_window_seconds), so PostgREST refuses to choose — PGRST203, HTTP 300.
--      reserveApiCredit treats a non-OK response as a reason to fail open, so
--      enforcement was off entirely while appearing configured. Verified live
--      against the deployed database before writing this.
--
--   2. The re-introduced body prunes rows older than p_window_seconds * 2, i.e.
--      120 seconds, and inserts a NULL caller. Any call landing on it would
--      have truncated the 30-minute audit trail to two minutes and erased
--      attribution for that provider — deleting the evidence needed to decide
--      what to trim.
--
-- The shim is kept rather than dropped, for the reason 20260812031000 gave:
-- migrations run before functions redeploy, and in that window already-deployed
-- code still calls the 3-arg form. Dropping it would 404, fail open, and switch
-- enforcement off for the length of the deploy. A brief gap in attribution is
-- much cheaper than a brief gap in enforcement.
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

-- Both signatures were callable with the anon key. Verified against the
-- deployed database: a 4-arg call authenticated with the publishable key —
-- the one shipped in the frontend bundle — returned HTTP 200.
--
-- REVOKE ... FROM PUBLIC, which every previous migration here used, does not
-- remove the explicit grants Supabase issues to anon and authenticated via
-- ALTER DEFAULT PRIVILEGES. A PUBLIC revoke only drops the implicit grant.
--
-- The function is SECURITY DEFINER and inserts a row per call, so an
-- unauthenticated caller could pad api_credit_usage until genuine reservations
-- are refused and the scanner loses its data feed. RLS does not cover this:
-- reads are already blocked, but EXECUTE is a separate grant.
REVOKE EXECUTE ON FUNCTION public.reserve_api_credit(TEXT, INT, INT) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_api_credit(TEXT, INT, INT, TEXT) FROM anon, authenticated;
