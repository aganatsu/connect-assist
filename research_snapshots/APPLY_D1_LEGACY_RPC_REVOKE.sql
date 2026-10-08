-- D1 — apply migration 20261009020000_d1_revoke_legacy_exposure_rpcs (approved 2026-10-08). Run ONCE, after PRECHECK_D1 returned
-- ready_to_apply = t. One transaction; fails closed before (unexpected state) and after (the migration's own ACL postcheck).
-- Migration embedded verbatim from PR #656 commit d10f4646 (md5 of the file: fddc04ac4b23dedaa4b9e27bc9d3e5b4).
begin;
set local lock_timeout = '5s';
do $pre$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') <> 1 then
    raise exception 'D1_APPLY_ABORTED: Step 17-C (20261009010000) is not recorded';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version in ('20261009020000', '20261009030000')) then
    raise exception 'D1_APPLY_ABORTED: 20261009020000 or 20261009030000 is already recorded — do not re-run';
  end if;
  if (select count(*) from public.paper_accounts where bot_id = 'smc') <> 1
     or (select count(*) from public.paper_accounts where bot_id = 'smc' and balance = 100000 and is_paused and entries_locked) <> 1
     or (select count(*) from public.paper_positions) <> 0
     or (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) <> 0 then
    raise exception 'D1_APPLY_ABORTED: live state is not the locked baseline ($100,000, paused, entries locked, 0 positions, 0 active real orders)';
  end if;
end $pre$;

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

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009020000', '20261009020000_d1_revoke_legacy_exposure_rpcs') on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;

select (select count(*) from supabase_migrations.schema_migrations where version = '20261009020000') as d1_recorded,
       has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
         or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as any_client_exec,
       has_function_privilege('service_role', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') and has_function_privilege('service_role', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') and has_function_privilege('service_role', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') and has_function_privilege('service_role', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') as service_exec;
-- expect: 1 | f | t
