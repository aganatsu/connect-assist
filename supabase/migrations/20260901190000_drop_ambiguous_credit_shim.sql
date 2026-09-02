-- Drop the 3-arg reserve_api_credit. Keeping it caused the failure it was
-- meant to prevent.
--
-- 20260812031000 kept the 3-arg signature as a delegating shim, reasoning that
-- migrations run before functions redeploy and already-deployed code still
-- calls the 3-arg form; dropping it would 404 and disable enforcement for the
-- length of the deploy. 20260901180000 restored that shim on the same grounds.
--
-- The reasoning does not survive contact with PostgREST. Both signatures accept
-- exactly (p_provider, p_limit, p_window_seconds), so a 3-arg call cannot be
-- resolved and returns PGRST203 / HTTP 300 — which reserveApiCredit treats as a
-- reason to fail open. Measured against the deployed database after applying
-- 20260901180000:
--
--   3 args -> HTTP 300 PGRST203, could not choose the best candidate function
--   4 args -> HTTP 401 42501,    permission denied (anon correctly locked out)
--
-- So the shim does not protect stale callers. It is the reason they fail.
--
-- With only the 4-arg form present, PostgREST resolves a 3-arg call against it
-- directly, because p_caller carries a DEFAULT. Stale code keeps working and
-- keeps being enforced, recording a NULL caller until it redeploys — which is
-- exactly what the shim was supposed to deliver. Dropping is therefore the
-- safer option, not the tidier one.
--
-- Verified before writing: apiCreditBudget.ts is the only caller in the
-- repository, and it now sends all four parameters.

DROP FUNCTION IF EXISTS public.reserve_api_credit(TEXT, INT, INT);

-- Re-assert the grants on the surviving signature. DROP does not touch them,
-- but stating them here keeps the reachable privilege set readable in one place
-- rather than spread across four migrations.
--
-- REVOKE ... FROM PUBLIC does not remove the explicit grants Supabase issues to
-- anon and authenticated through ALTER DEFAULT PRIVILEGES, which is how this
-- function came to be callable with the publishable key from the frontend
-- bundle. Both roles are revoked by name.
REVOKE ALL ON FUNCTION public.reserve_api_credit(TEXT, INT, INT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reserve_api_credit(TEXT, INT, INT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_api_credit(TEXT, INT, INT, TEXT) TO service_role;
