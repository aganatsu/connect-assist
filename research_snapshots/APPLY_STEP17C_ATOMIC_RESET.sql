-- STEP 17-C — apply migration 20261009010000_step17c_atomic_reset (approved 2026-10-08, after the external two-session proof PASSED).
-- Run ONCE in the SQL editor, after PRECHECK_STEP17C_READONLY.sql returned ready_to_apply = t, and BEFORE merging PR #655.
-- One transaction. FAILS CLOSED before (unexpected production state) and after (anything not exactly as designed).
-- Migration file embedded verbatim (md5 of the file: 14fe41843503558aca1b8ec1b64a81f8).
-- The live-state gate (one SMC account, $100,000, paused, entries locked, 0 positions, 0 active REAL
-- orders) is re-checked HERE, inside the apply transaction: the standalone precheck is a separate
-- transaction and the state could have changed since. The tables and the account row are locked
-- before the check so it holds until COMMIT; lock_timeout makes a busy table abort the run (rolled
-- back, nothing changed) instead of queueing the scanner behind it. Active dry-run orders are allowed.

begin;
set local lock_timeout = '5s';

do $pre$
declare
  v_accounts int; v_positions int; v_real int; v_acct record;
begin
  -- the migration itself takes ACCESS EXCLUSIVE on paper_positions and SHARE ROW EXCLUSIVE on
  -- pending_orders (CREATE TRIGGER); taking write-blocking locks first only moves them earlier
  lock table public.paper_positions, public.pending_orders in share row exclusive mode;
  select count(*) into v_accounts from public.paper_accounts where bot_id = 'smc';
  if v_accounts <> 1 then
    raise exception 'STEP17C_APPLY_ABORTED: expected exactly one SMC paper account, found %', v_accounts;
  end if;
  select * into v_acct from public.paper_accounts where bot_id = 'smc' for update;
  if v_acct.balance is distinct from 100000 or v_acct.is_paused is distinct from true or v_acct.entries_locked is distinct from true then
    raise exception 'STEP17C_APPLY_ABORTED: SMC account state changed (balance %, paused %, entries_locked %)', v_acct.balance, v_acct.is_paused, v_acct.entries_locked;
  end if;
  select count(*) into v_positions from public.paper_positions;
  if v_positions <> 0 then
    raise exception 'STEP17C_APPLY_ABORTED: % open paper position(s)', v_positions;
  end if;
  select count(*) into v_real from public.pending_orders
   where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true;
  if v_real <> 0 then
    raise exception 'STEP17C_APPLY_ABORTED: % active REAL order(s)', v_real;
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '20261009000000') <> 1 then
    raise exception 'STEP17C_APPLY_ABORTED: Step 17-A (20261009000000) is not recorded';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261009010000') then
    raise exception 'STEP17C_APPLY_ABORTED: 20261009010000 is already recorded — do not re-run';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure) is distinct from '246e0ddefc1f8b0662974af2cd32f293' then
    raise exception 'STEP17C_APPLY_ABORTED: reset_paper_account is not the expected ledger-migration function';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public._paper_ledger_caller_ok(uuid)'::regprocedure) is distinct from 'ce94550c15e60d653c71958150a4e00c' then
    raise exception 'STEP17C_APPLY_ABORTED: _paper_ledger_caller_ok is not the expected function';
  end if;
  if to_regprocedure('public.reset_paper_account_if_flat(uuid,text,numeric,text)') is not null
     or exists (select 1 from pg_trigger where tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')) then
    raise exception 'STEP17C_APPLY_ABORTED: a Step 17-C object already exists';
  end if;
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') is distinct from 'now()' then
    raise exception 'STEP17C_APPLY_ABORTED: paper_positions.created_at default is not now()';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.paper_accounts'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (user_id)') then
    raise exception 'STEP17C_APPLY_ABORTED: paper_accounts is not UNIQUE(user_id) — the one-row lock assumption does not hold';
  end if;
end $pre$;

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

do $post$
declare v text;
begin
  -- live state still as gated (the locks taken in $pre$ are held until COMMIT)
  if (select count(*) from public.paper_accounts where bot_id = 'smc' and balance = 100000 and is_paused and entries_locked) <> 1
     or (select count(*) from public.paper_accounts where bot_id = 'smc') <> 1
     or (select count(*) from public.paper_positions) <> 0
     or (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) <> 0 then
    raise exception 'STEP17C_APPLY_ABORTED: live state changed during the apply transaction';
  end if;
  -- functions: exact bodies, SECURITY DEFINER, fixed search_path; reset_paper_account unchanged
  if (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure) is distinct from '246e0ddefc1f8b0662974af2cd32f293' then
    raise exception 'STEP17C_APPLY_ABORTED: reset_paper_account changed';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account_if_flat(uuid,text,numeric,text)'::regprocedure) is distinct from 'de37b22a841c365c3c83a0712b1eb2db'
     or (select md5(prosrc) from pg_proc where oid = 'public.paper_positions_serialize_with_reset()'::regprocedure) is distinct from '9d32120d64900de95e08b1da8274467d'
     or (select md5(prosrc) from pg_proc where oid = 'public.pending_orders_serialize_with_reset()'::regprocedure) is distinct from 'ded96cbc4ee81e433fc645c2317e30f4' then
    raise exception 'STEP17C_APPLY_ABORTED: a new function body is not the expected one';
  end if;
  if exists (select 1 from pg_proc where proname in ('reset_paper_account_if_flat', 'paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')
             and (not prosecdef or not coalesce(proconfig, '{}') @> array['search_path=public'])) then
    raise exception 'STEP17C_APPLY_ABORTED: a new function is not SECURITY DEFINER with search_path=public';
  end if;
  -- triggers: attached, enabled, exact timing / events
  select pg_get_triggerdef(oid) into v from pg_trigger where tgname = 'paper_positions_serialize_with_reset' and tgenabled <> 'D';
  if v is null or v not like 'CREATE TRIGGER paper_positions_serialize_with_reset BEFORE INSERT ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION %paper_positions_serialize_with_reset()' then
    raise exception 'STEP17C_APPLY_ABORTED: position trigger not as designed: %', v;
  end if;
  select pg_get_triggerdef(oid) into v from pg_trigger where tgname = 'pending_orders_serialize_with_reset' and tgenabled <> 'D';
  if v is null or v not like 'CREATE TRIGGER pending_orders_serialize_with_reset BEFORE INSERT OR UPDATE OF status ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION %pending_orders_serialize_with_reset()' then
    raise exception 'STEP17C_APPLY_ABORTED: order trigger not as designed: %', v;
  end if;
  -- created_at: default dropped, still NOT NULL
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') is not null
     or (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') <> 'NO' then
    raise exception 'STEP17C_APPLY_ABORTED: paper_positions.created_at is not (no default, NOT NULL)';
  end if;
  -- ACL matrix, exact
  if has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute')
     or has_function_privilege('anon', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute')
     or not has_function_privilege('service_role', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
     or has_function_privilege('anon', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
     or not has_function_privilege('service_role', 'public.reset_paper_account_if_flat(uuid,text,numeric,text)', 'execute')
     or has_function_privilege('authenticated', 'public.paper_positions_serialize_with_reset()', 'execute')
     or has_function_privilege('anon', 'public.paper_positions_serialize_with_reset()', 'execute')
     or has_function_privilege('authenticated', 'public.pending_orders_serialize_with_reset()', 'execute')
     or has_function_privilege('anon', 'public.pending_orders_serialize_with_reset()', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a where a.grantee = 0 and p.oid in (
          'public.reset_paper_account(uuid,text,numeric,text)'::regprocedure, 'public.reset_paper_account_if_flat(uuid,text,numeric,text)'::regprocedure,
          'public.paper_positions_serialize_with_reset()'::regprocedure, 'public.pending_orders_serialize_with_reset()'::regprocedure)) then
    raise exception 'STEP17C_APPLY_ABORTED: ACL matrix not as designed';
  end if;
end $post$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009010000', '20261009010000_step17c_atomic_reset') on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;

-- ── read-only result (one row) ───────────────────────────────────────────────
select (select count(*) from supabase_migrations.schema_migrations where version = '20261009010000') as migration_rows,
       (select md5(prosrc) from pg_proc where oid = 'public.reset_paper_account_if_flat(uuid,text,numeric,text)'::regprocedure) as guarded_md5,
       (select count(*) from pg_trigger where tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')) as triggers,
       (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'paper_positions' and column_name = 'created_at') as created_at_default,
       has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') as client_unguarded_reset;
-- expect: 1 | de37b22a841c365c3c83a0712b1eb2db | 2 | NULL | f
