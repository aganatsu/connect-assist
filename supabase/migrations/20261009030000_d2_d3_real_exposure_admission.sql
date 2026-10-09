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
