-- Fix: role detection in two triggers used the legacy GUC
-- `request.jwt.claim.role`. Current PostgREST sets only `request.jwt.claims`
-- (JSON), so the legacy setting is empty for every API call.
--
-- Consequence found 2026-10-06 14:44: the post-reset entries-lock guard
-- (20261006040000) saw an empty role and REFUSED the system-reset function's
-- service-role update. Both reset attempts stopped at their first step
-- ("lock entries") — nothing was closed, cancelled, snapshotted or reset; the
-- account was left paused.
--
-- `auth.role()` (Supabase) reads both the legacy setting and
-- `request.jwt.claims ->> 'role'`; the settlement and reset functions already
-- use it, which is why they work. Both triggers now use it too.

CREATE OR REPLACE FUNCTION public.paper_accounts_entries_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.entries_locked IS DISTINCT FROM OLD.entries_locked
     OR NEW.entries_locked_reason IS DISTINCT FROM OLD.entries_locked_reason
     OR NEW.entries_locked_at IS DISTINCT FROM OLD.entries_locked_at THEN
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND session_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'entries lock can only be changed by the server or a database administrator';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- Balance guard: same detection bug, but only in what it RECORDS about an
-- unledgered write (request_role), never in what it allows. Body otherwise
-- identical to 20261006010000.
CREATE OR REPLACE FUNCTION public.paper_accounts_balance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text;
BEGIN
  IF NEW.balance IS NOT DISTINCT FROM OLD.balance
     AND NEW.peak_balance IS NOT DISTINCT FROM OLD.peak_balance
     AND NEW.ledger_epoch_id IS NOT DISTINCT FROM OLD.ledger_epoch_id
     AND NEW.ledger_epoch_started_at IS NOT DISTINCT FROM OLD.ledger_epoch_started_at
     AND NEW.ledger_reset_at IS NOT DISTINCT FROM OLD.ledger_reset_at THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.ledger_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT mode INTO v_mode FROM public.paper_ledger_guard WHERE id = 1;
  v_mode := COALESCE(v_mode, 'enforce');

  IF v_mode = 'enforce' THEN
    RAISE EXCEPTION 'paper_accounts balance can only change through the settlement ledger (settle_paper_position / settle_paper_partial / reset_paper_account)'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.paper_balance_unledgered_writes (
    account_id, old_balance, new_balance, old_peak_balance, new_peak_balance, guard_mode, request_role
  ) VALUES (
    OLD.id, OLD.balance, NEW.balance, OLD.peak_balance, NEW.peak_balance, v_mode, auth.role()
  );
  RETURN NEW;
END $function$;
