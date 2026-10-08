-- STEP 17-C — atomic reset / exposure serialisation.
--
-- The races (PRE_UNLOCK_DECISION_PACKAGE_V1 §3, STEP17C_EFFECT_REPORT.md):
--   (1) position vs reset: a settlement is pre-epoch (credited $0) when
--       position.created_at < account.ledger_reset_at. created_at defaulted to now() —
--       the TRANSACTION START — while ledger_reset_at is clock_timestamp(), and nothing
--       serialised a position insert against a reset.
--   (2) order vs reset: route2_place_order inserts a real pending order without
--       touching paper_accounts, so a reset could check "flat", a real order could be
--       created concurrently, and the reset still commit.
--
-- ONE lock — the user's paper_accounts row (UNIQUE(user_id)):
--   reset_paper_account_if_flat            SELECT … FOR UPDATE, then (new statement,
--                                          new snapshot) counts positions + active real
--                                          orders; refuses with no data change, or runs the
--                                          existing reset in the same transaction;
--   every paper_positions INSERT           BEFORE trigger: FOR KEY SHARE, then stamps
--                                          created_at := clock_timestamp() AFTER the lock;
--   every REAL order entering an active    BEFORE trigger: FOR KEY SHARE.
--   status (insert, or update from a
--   non-active status)
-- FOR KEY SHARE conflicts with FOR UPDATE (writer ⟂ reset serialise) but not with
-- FOR NO KEY UPDATE (the scanner's frequent account heartbeat UPDATEs) or with another
-- FOR KEY SHARE (fills / placements do not block each other).
--
-- Active = pending | awaiting_confirmation | triggered. 'triggered' is in the
-- CHECK constraint and system-reset already treats it as live (LIVE_PENDING);
-- the guard is at least as strict.
--
-- created_at: a BEFORE trigger cannot tell an omitted value from the column default
-- now() (both arrive as the transaction start) — proven in the effect report. So the
-- default is DROPPED: an omitted created_at arrives as NULL and the trigger stamps
-- clock_timestamp() after taking the lock; an explicit value (historical fixtures,
-- backfills) is kept. No production insert path sets created_at. If the trigger were
-- ever missing, NOT NULL makes the insert fail closed.
--
-- reset_paper_account is unchanged (system-reset keeps using it, service role). Its
-- client EXECUTE is revoked, so the guarded function is the only client reset path.

-- ── 1. position inserts: lock the account row, then stamp created_at ─────────
ALTER TABLE public.paper_positions ALTER COLUMN created_at DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.paper_positions_serialize_with_reset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- SECURITY DEFINER: a row lock needs UPDATE privilege and passes RLS UPDATE
  -- policies for the inserting role; the lock must not depend on who inserts
  -- (service role or a signed-in user). It only locks NEW.user_id's account row.
  PERFORM 1 FROM public.paper_accounts WHERE user_id = NEW.user_id FOR KEY SHARE;
  IF NEW.created_at IS NULL THEN
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS paper_positions_serialize_with_reset ON public.paper_positions;
CREATE TRIGGER paper_positions_serialize_with_reset BEFORE INSERT ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.paper_positions_serialize_with_reset();

-- ── 2. real orders entering an active status: lock the account row ───────────
CREATE OR REPLACE FUNCTION public.pending_orders_serialize_with_reset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.dry_run IS NOT TRUE
     AND NEW.status IN ('pending', 'awaiting_confirmation', 'triggered')
     AND (TG_OP = 'INSERT' OR OLD.status IS NULL OR OLD.status NOT IN ('pending', 'awaiting_confirmation', 'triggered')) THEN
    PERFORM 1 FROM public.paper_accounts WHERE user_id = NEW.user_id FOR KEY SHARE;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS pending_orders_serialize_with_reset ON public.pending_orders;
CREATE TRIGGER pending_orders_serialize_with_reset BEFORE INSERT OR UPDATE OF status ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.pending_orders_serialize_with_reset();

-- ── 3. the guarded reset ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reset_paper_account_if_flat(
  p_user_id uuid,
  p_bot_id text,
  p_new_balance numeric,
  p_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- SECURITY DEFINER: it must call reset_paper_account, which is service-role only;
-- the caller is authorised first, exactly as reset_paper_account authorises.
DECLARE
  v_positions int;
  v_real int;
  v_dry int;
BEGIN
  IF NOT public._paper_ledger_caller_ok(p_user_id) THEN
    RETURN jsonb_build_object('reset', false, 'code', 'forbidden');
  END IF;

  -- (1) the lock every position insert and every real-order activation also takes
  PERFORM 1 FROM public.paper_accounts WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('reset', false, 'code', 'account_missing');
  END IF;

  -- (2) exposure, read AFTER the lock (each statement takes a new snapshot)
  SELECT count(*) INTO v_positions FROM public.paper_positions WHERE user_id = p_user_id;
  SELECT count(*) FILTER (WHERE dry_run IS NOT TRUE), count(*) FILTER (WHERE dry_run IS TRUE)
    INTO v_real, v_dry
    FROM public.pending_orders
   WHERE user_id = p_user_id AND status IN ('pending', 'awaiting_confirmation', 'triggered');

  IF v_positions > 0 OR v_real > 0 THEN
    RETURN jsonb_build_object('reset', false, 'code', 'reset_refused_real_exposure',
      'exposure', jsonb_build_object('openPositions', v_positions, 'activeRealOrders', v_real, 'activeDryRunOrders', v_dry));
  END IF;

  -- (3) flat: the existing reset, same transaction, lock still held
  RETURN public.reset_paper_account(p_user_id, p_bot_id, p_new_balance, p_reason)
    || jsonb_build_object('exposure', jsonb_build_object('openPositions', 0, 'activeRealOrders', 0, 'activeDryRunOrders', v_dry));
END $function$;

-- ── 4. ACLs: revoke everything first, then grant exactly the intended roles ───
REVOKE ALL ON FUNCTION public.reset_paper_account(uuid, text, numeric, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reset_paper_account(uuid, text, numeric, text) TO service_role;

REVOKE ALL ON FUNCTION public.reset_paper_account_if_flat(uuid, text, numeric, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reset_paper_account_if_flat(uuid, text, numeric, text) TO authenticated, service_role;

-- trigger functions: no role needs EXECUTE for a trigger to fire
REVOKE ALL ON FUNCTION public.paper_positions_serialize_with_reset() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pending_orders_serialize_with_reset() FROM PUBLIC, anon, authenticated, service_role;
