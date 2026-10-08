-- D1 — revoke client EXECUTE on the legacy exposure-writing RPCs (production security hole).
--
-- finalize_market_entry, finalize_pending_order_fill, finalize_live_broker_position and
-- retarget_pending_to_impulse_candidate are SECURITY DEFINER baseline functions with NO caller
-- check: each writes paper_positions and/or pending_orders for whatever p_user_id it is given.
-- None ever had a REVOKE, so they kept Supabase's default EXECUTE for PUBLIC / anon /
-- authenticated (reviewer confirmed in production for the first two), and PostgREST publishes
-- them. No code calls any of them (repo-wide search: only the generated types in
-- src/integrations/supabase/types.ts mention the first two; the live paths are
-- route2_place_order / route2_claim_and_fill, already service-role only).
--
-- Change: client EXECUTE revoked; service_role keeps EXECUTE (nothing changes for any server
-- path). Bodies, search_path and SECURITY DEFINER are untouched (search_path is already
-- 'public' on all four — asserted below). Nothing is dropped.
DO $pre$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f, p.prosecdef, p.proconfig FROM pg_proc p
            WHERE p.oid IN ('public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)'::regprocedure,
                            'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)'::regprocedure,
                            'public.finalize_live_broker_position(uuid,text,text)'::regprocedure,
                            'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)'::regprocedure) LOOP
    IF NOT r.prosecdef OR NOT COALESCE(r.proconfig, '{}') @> ARRAY['search_path=public'] THEN
      RAISE EXCEPTION 'D1_ABORTED: % is not SECURITY DEFINER with search_path=public as expected', r.f;
    END IF;
  END LOOP;
END $pre$;

REVOKE ALL ON FUNCTION public.finalize_market_entry(uuid, text, text, jsonb, jsonb, integer, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_pending_order_fill(uuid, uuid, text, numeric, numeric, text, jsonb, text, jsonb, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_live_broker_position(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retarget_pending_to_impulse_candidate(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_market_entry(uuid, text, text, jsonb, jsonb, integer, integer, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_pending_order_fill(uuid, uuid, text, numeric, numeric, text, jsonb, text, jsonb, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_live_broker_position(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retarget_pending_to_impulse_candidate(uuid, uuid, text) TO service_role;

DO $post$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)',
                           'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)',
                           'public.finalize_live_broker_position(uuid,text,text)',
                           'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)'] LOOP
    IF has_function_privilege('anon', f, 'execute') OR has_function_privilege('authenticated', f, 'execute')
       OR NOT has_function_privilege('service_role', f, 'execute')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'D1_ABORTED: ACL of % not as designed', f;
    END IF;
  END LOOP;
END $post$;
