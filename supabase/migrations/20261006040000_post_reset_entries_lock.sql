-- Post-reset entries lock.
--
-- The $100,000 reset is an accounting/state boundary, NOT a restart. After it,
-- the bot must not trade the old configuration: no new entries until the
-- simplified, fixed, frozen configuration is built, verified and approved.
--
-- `is_paused` alone is soft — the app's Start/Resume button clears it. This
-- lock is independent: while `entries_locked` is true the scanner treats the
-- account as paused regardless of `is_paused`, and neither Route 2 fill poller
-- fills. The reset sets it; nothing in the app clears it. Unlocking is a
-- deliberate, separate step (hand-applied, docs/SYSTEM_RESET_WORKFLOW_V1.md).
--
-- Ships false: no behaviour change until the reset runs.

ALTER TABLE public.paper_accounts
  ADD COLUMN IF NOT EXISTS entries_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entries_locked_reason text,
  ADD COLUMN IF NOT EXISTS entries_locked_at timestamptz;

-- Signed-in users can update their own paper_accounts row through the API
-- (RLS "Users manage own paper account"). They must not be able to lift the
-- lock from the browser. Only the service role (edge functions) or a direct
-- database session (the SQL editor) may change it.
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
    IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
       AND session_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'entries lock can only be changed by the server or a database administrator';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_paper_accounts_entries_lock_guard ON public.paper_accounts;
CREATE TRIGGER trg_paper_accounts_entries_lock_guard
  BEFORE UPDATE ON public.paper_accounts
  FOR EACH ROW EXECUTE FUNCTION public.paper_accounts_entries_lock_guard();
