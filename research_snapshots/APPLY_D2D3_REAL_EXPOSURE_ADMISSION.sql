-- D2/D3 — apply migration 20261009030000_d2_d3_real_exposure_admission (approved 2026-10-08). Run ONCE, after D1 is applied +
-- verified and PRECHECK_D2D3 returned ready_to_apply = t. One transaction; fails closed before and after.
-- Migration embedded verbatim from PR #656 commit d10f4646 (md5 of the file: 7ab12187e35218b14984687aef47b693); it carries its own privilege/trigger postcheck.
begin;
set local lock_timeout = '5s';
do $pre$
begin
  if not ((select count(*) from supabase_migrations.schema_migrations where version = '20261009020000') = 1
   and not (has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute') or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute') or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
            or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute') or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute'))) then
    raise exception 'D2_APPLY_ABORTED: D1 (20261009020000) is not applied and closed';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261009030000')
     or to_regprocedure('public.real_exposure_admission_guard()') is not null
     or exists (select 1 from pg_trigger where tgname = 'a_real_exposure_admission') then
    raise exception 'D2_APPLY_ABORTED: 20261009030000 already recorded or its objects exist — do not re-run';
  end if;
  if (select count(*) from public.paper_positions p where not exists (select 1 from public.paper_accounts a where a.user_id = p.user_id and coalesce(a.bot_id, 'smc') = coalesce(p.bot_id, 'smc')))
   + (select count(*) from public.pending_orders o where o.status in ('pending', 'awaiting_confirmation', 'triggered') and o.dry_run is not true
        and not exists (select 1 from public.paper_accounts a where a.user_id = o.user_id and coalesce(a.bot_id, 'smc') = coalesce(o.bot_id, 'smc'))) <> 0 then
    raise exception 'D2_APPLY_ABORTED: real exposure exists without a paper account (D3 would orphan it)';
  end if;
  if (select count(*) from public.paper_accounts where bot_id = 'smc') <> 1
     or (select count(*) from public.paper_accounts where bot_id = 'smc' and balance = 100000 and is_paused and entries_locked) <> 1
     or (select count(*) from public.paper_positions) <> 0
     or (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) <> 0 then
    raise exception 'D2_APPLY_ABORTED: live state is not the locked baseline ($100,000, paused, entries locked, 0 positions, 0 active real orders)';
  end if;
end $pre$;

-- D2 + D3 — real exposure is admitted only from the server, and only onto a real paper account.
--
-- D2 writer inventory (repo-wide, traced 2026-10-08):
--   pending_orders  INSERT / UPDATE / DELETE: server only — route2_place_order, route2_claim_and_fill
--                   (both run with the caller's rights, granted to service_role only), bot-scanner hunt /
--                   refresh / supersede / expiry and the UI's "Cancel pending" action (cancel_pending, via the
--                   service-role adminClient), zone-confirmation-scanner (service key), system-reset (service
--                   key). The browser only reads (through bot-scanner actions). NO client writer exists.
--   paper_positions INSERT: server (Route 2 fill; legacy market path, off) + ONE client writer, the
--                   paper-trading `place_order` manual trade — intentionally disabled here.
--   paper_positions UPDATE (client: `status` price refresh, `update_position` SL/TP edit, MT5 mirror ids) and
--                   DELETE (manual close via settle_paper_position, SECURITY DEFINER) — LEGITIMATE, untouched.
--
-- pending_orders — PRIVILEGE REVOCATION (primary control): anon / authenticated keep SELECT only. The baseline
--   granted them DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE; RLS ("Users can update own pending
--   orders") let the owner rewrite any column of an active order. Revocation covers every column, DELETE and
--   TRUNCATE (which RLS and row triggers cannot), with no logic to maintain.
-- pending_orders — FULL-ROW TRIGGER (defence in depth): table privileges do not apply inside a SECURITY DEFINER
--   function, which is exactly how the D1 hole worked. So every non-server INSERT/UPDATE/DELETE is refused at
--   row level too, whoever owns the function the client called.
-- paper_positions — NARROW TRIGGER: client INSERT refused; client UPDATE/DELETE flows untouched (no privilege
--   change on paper_positions).
-- "Server" = auth.role() = 'service_role' (edge functions with the service key; PostgREST sets
--   request.jwt.claims) or a database-administrator session (SQL editor, pg_cron) — the predicate already
--   used by _paper_ledger_caller_ok and the entries-lock guard. auth.role() and session_user do not change
--   inside SECURITY DEFINER functions, so a client calling one is still a client.
--
-- D3: entries_lock_insert_guard looks the lock up by (user_id, bot_id); with no such account it reads NULL and
--   passes. A real position, or a real order entering an active status, must belong to an existing paper
--   account (user_id, COALESCE(bot_id,'smc')). Production: one account ('smc'), no rows under any other bot id.
--
-- Unchanged: server dry-run orders (the locked experiment), entries_lock_insert_guard, the step 17-C triggers,
-- the scanner, Route 2, every paper_positions UPDATE/DELETE path.
CREATE OR REPLACE FUNCTION public.real_exposure_admission_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- SECURITY DEFINER only so the account lookup does not depend on the caller's RLS;
  -- auth.role() and session_user still describe the original caller.
  v_server boolean := COALESCE(auth.role(), '') = 'service_role' OR session_user IN ('postgres', 'supabase_admin');
  v_entering boolean;
  v_real boolean;
BEGIN
  IF TG_TABLE_NAME = 'paper_positions' THEN
    IF NOT v_server THEN
      RAISE EXCEPTION 'real exposure is server-only: a client cannot insert a paper position' USING ERRCODE = '42501';
    END IF;
    v_entering := true;
    v_real := true;
  ELSE
    IF NOT v_server THEN
      RAISE EXCEPTION 'pending orders are server-only: a client cannot % them', lower(TG_OP) USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    v_entering := NEW.status IN ('pending', 'awaiting_confirmation', 'triggered')
      AND (TG_OP = 'INSERT' OR OLD.status IS NULL OR OLD.status NOT IN ('pending', 'awaiting_confirmation', 'triggered'));
    v_real := NEW.dry_run IS NOT TRUE;
  END IF;

  IF v_real AND v_entering AND NOT EXISTS (
       SELECT 1 FROM public.paper_accounts a
        WHERE a.user_id = NEW.user_id AND COALESCE(a.bot_id, 'smc') = COALESCE(NEW.bot_id, 'smc')) THEN
    RAISE EXCEPTION 'real exposure needs a paper account: none for user % bot %', NEW.user_id, COALESCE(NEW.bot_id, 'smc')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS a_real_exposure_admission ON public.paper_positions;
CREATE TRIGGER a_real_exposure_admission BEFORE INSERT ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.real_exposure_admission_guard();
DROP TRIGGER IF EXISTS a_real_exposure_admission ON public.pending_orders;
CREATE TRIGGER a_real_exposure_admission BEFORE INSERT OR UPDATE OR DELETE ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.real_exposure_admission_guard();

REVOKE ALL ON FUNCTION public.real_exposure_admission_guard() FROM PUBLIC, anon, authenticated, service_role;

-- pending_orders: clients read only
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.pending_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pending_orders TO anon, authenticated;

DO $post$
BEGIN
  -- has_table_privilege(…, 'A, B') is TRUE if ANY listed privilege is held: right for "must not hold", so every
  -- "must hold" privilege is checked on its own.
  IF has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('anon', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.pending_orders', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.pending_orders', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.pending_orders', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.pending_orders', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.pending_orders', 'DELETE')
     OR (SELECT count(*) FROM pg_trigger WHERE tgname = 'a_real_exposure_admission' AND tgenabled <> 'D'
           AND ((tgrelid = 'public.pending_orders'::regclass AND (tgtype & 28) = 28)       -- INSERT(4) DELETE(8) UPDATE(16)
             OR (tgrelid = 'public.paper_positions'::regclass AND (tgtype & 28) = 4))) <> 2
     OR NOT has_table_privilege('authenticated', 'public.paper_positions', 'UPDATE')   -- client position flows kept
     OR NOT has_table_privilege('authenticated', 'public.paper_positions', 'DELETE') THEN
    RAISE EXCEPTION 'D2_ABORTED: privileges / triggers not as designed';
  END IF;
END $post$;

do $post2$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.real_exposure_admission_guard()'::regprocedure) is distinct from '4ade726424070850f851acef170f36bf' then
    raise exception 'D2_APPLY_ABORTED: guard function body is not the reviewed one';
  end if;
  if (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D'
      and ((tgrelid = 'public.pending_orders'::regclass and tgtype = 31) or (tgrelid = 'public.paper_positions'::regclass and tgtype = 7))) <> 2 then
    raise exception 'D2_APPLY_ABORTED: admission triggers not exactly (pending_orders I+U+D, paper_positions I)';
  end if;
end $post2$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009030000', '20261009030000_d2_d3_real_exposure_admission') on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;

select (select count(*) from supabase_migrations.schema_migrations where version = '20261009030000') as d2_recorded,
       (select md5(prosrc) from pg_proc where oid = 'public.real_exposure_admission_guard()'::regprocedure) as guard_md5,
       (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D'
      and ((tgrelid = 'public.pending_orders'::regclass and tgtype = 31) or (tgrelid = 'public.paper_positions'::regclass and tgtype = 7))) as admission_triggers,
       has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as auth_write_orders,
       has_table_privilege('authenticated', 'public.pending_orders', 'SELECT') as auth_select_orders;
-- expect: 1 | 4ade726424070850f851acef170f36bf | 2 | f | t
