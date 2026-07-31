-- 1. Restrict overly permissive service-role policies to the actual service role
DROP POLICY IF EXISTS "Service role full access on config_backups" ON public.config_backups;
CREATE POLICY "Service role full access on config_backups"
  ON public.config_backups
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on optimizer_runs" ON public.optimizer_runs;
CREATE POLICY "Service role full access on optimizer_runs"
  ON public.optimizer_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2. Revoke direct EXECUTE on SECURITY DEFINER functions from anon/authenticated.
-- These are invoked exclusively by edge functions using the service role, and
-- trigger functions never need direct EXECUTE.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END
$$;