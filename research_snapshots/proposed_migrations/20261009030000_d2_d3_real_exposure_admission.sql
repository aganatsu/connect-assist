-- D2 + D3 — real exposure is admitted only from the server, and only onto a real paper account.
--
-- D2: the baseline grants `authenticated` INSERT/UPDATE/DELETE on paper_positions and
-- pending_orders, and RLS ("own rows") lets the account owner write them directly through
-- PostgREST. Writer inventory (repo-wide):
--   paper_positions INSERT   server: Route 2 fill (route2_claim_and_fill), legacy market path
--                            (bot-scanner, off: marketEntriesEnabled=false); client: ONLY the
--                            paper-trading `place_order` manual trade (user JWT).
--   pending_orders INSERT    server only (route2_place_order). No client writer.
--   pending_orders UPDATE    server only (bot-scanner hunt/cancel, zone-confirmation-scanner,
--                            system-reset). No client writer.
--   paper_positions UPDATE   client: paper-trading `status` (price refresh), `update_position`
--                            (SL/TP edit), MT5 mirror ids — LEGITIMATE, untouched here.
--   paper_positions DELETE   via settle_paper_position (SECURITY DEFINER) — untouched.
-- So the smallest fail-closed rule is a row trigger, not a table-privilege change:
--   * paper_positions INSERT                      → server only;
--   * pending_orders INSERT                       → server only (dry-run too: a client dry-run
--                                                  order could hold a symbol+direction and
--                                                  absorb real setups);
--   * pending_orders status → active (from non-active) → server only.
-- "Server" = auth.role() = 'service_role' (edge functions with the service key; PostgREST sets
-- request.jwt.claims) or a database administrator session (SQL editor). The same predicate as
-- _paper_ledger_caller_ok / the entries-lock guard. A client calling a SECURITY DEFINER
-- function is still a client here (auth.role() and session_user do not change).
--
-- D3: entries_lock_insert_guard looks the lock up by (user_id, bot_id); with no such account
-- the lock reads NULL and the row passes. So a real position, or a real order entering an
-- active status, must belong to an existing paper account (user_id, COALESCE(bot_id,'smc')).
-- Production has one account ('smc') and no position/order rows under any other bot id.
--
-- Not changed: dry-run orders by the server (the locked experiment), every UPDATE/DELETE path
-- above, entries_lock_insert_guard, the step 17-C triggers, the scanner, Route 2.
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
    v_entering := NEW.status IN ('pending', 'awaiting_confirmation', 'triggered')
      AND (TG_OP = 'INSERT' OR OLD.status IS NULL OR OLD.status NOT IN ('pending', 'awaiting_confirmation', 'triggered'));
    IF NOT v_server AND (TG_OP = 'INSERT' OR v_entering) THEN
      RAISE EXCEPTION 'orders are server-only: a client cannot create or activate a pending order' USING ERRCODE = '42501';
    END IF;
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
CREATE TRIGGER a_real_exposure_admission BEFORE INSERT OR UPDATE OF status ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.real_exposure_admission_guard();

REVOKE ALL ON FUNCTION public.real_exposure_admission_guard() FROM PUBLIC, anon, authenticated, service_role;
