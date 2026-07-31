-- Security follow-up for controlled zone-local enforcement.
--
-- CREATE OR REPLACE FUNCTION preserves role-specific grants. Revoking PUBLIC
-- alone is therefore insufficient when anon or authenticated previously
-- received EXECUTE directly. Keep this SECURITY DEFINER switch callable only
-- by the service role.

REVOKE ALL ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) FROM anon;

REVOKE ALL ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) TO service_role;

DO $$
DECLARE
  v_signature TEXT :=
    'public.set_strategy_runtime_enforcement(uuid,text,text,text,jsonb,boolean,text,uuid,integer)';
BEGIN
  IF has_function_privilege('anon', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION
      'anon must not execute set_strategy_runtime_enforcement';
  END IF;

  IF has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION
      'authenticated must not execute set_strategy_runtime_enforcement';
  END IF;

  IF NOT has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION
      'service_role must execute set_strategy_runtime_enforcement';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.set_strategy_runtime_enforcement(
  UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT, UUID, INTEGER
) IS
  'Service-role-only switch for enabling or disabling previously approved runtime authority.';
