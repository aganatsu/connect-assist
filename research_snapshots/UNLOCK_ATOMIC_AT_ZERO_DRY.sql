-- FINAL CONTROLLED UNLOCK — ONE atomic transition: locked dry run → live (paper), with NO intermediate state.
-- Replaces UNLOCK_STAGE1 + UNLOCK_STAGE2: the paused-but-unlocked drain state let non-scanner paths (manual
-- place_order, direct client inserts/updates, legacy finalize_* RPCs, the app's Resume) create real exposure.
-- PREREQUISITES: D1 (20261009020000) and D2/D3 (20261009030000) applied and verified — checked below, fail closed.
-- DO NOT RUN without explicit final approval. SQL editor (the entries-lock guard allows only the server / a DB admin).
-- Succeeds ONLY in a moment with ZERO active dry-run orders (they would absorb real setups: same-level refresh in place /
-- unique-index duplicate, and dry_run is immutable) and no full scan in progress. Otherwise it aborts with nothing changed:
-- retry in a zero-dry window (observed 49–98 min windows on weekdays; all dry orders end ≤ 480 min after the Friday FX close).
-- The tables and the account row are locked for the check, so no order can appear between the check and COMMIT.
begin;
set local lock_timeout = '5s';
do $u$
declare a record; n int;
begin
  lock table public.paper_positions, public.pending_orders in share row exclusive mode;
  if (select count(*) from public.paper_accounts where bot_id = 'smc') <> 1 then raise exception 'UNLOCK_ABORTED: expected one SMC account'; end if;
  select * into a from public.paper_accounts where bot_id = 'smc' for update;
  if a.balance is distinct from 100000 or a.is_paused is distinct from true or a.entries_locked is distinct from true
     or a.kill_switch_active is distinct from false or a.execution_mode is distinct from 'paper' then
    raise exception 'UNLOCK_ABORTED: account not at baseline (balance %, paused %, locked %, kill %, mode %)', a.balance, a.is_paused, a.entries_locked, a.kill_switch_active, a.execution_mode;
  end if;
  select count(*) into n from public.paper_positions; if n <> 0 then raise exception 'UNLOCK_ABORTED: % position(s)', n; end if;
  select count(*) into n from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true;
  if n <> 0 then raise exception 'UNLOCK_ABORTED: % active real order(s)', n; end if;
  select count(*) into n from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is true;
  if n <> 0 then raise exception 'UNLOCK_ABORTED: % dry-run order(s) still active — retry in a zero-dry window', n; end if;
  if a.scan_lock_until is not null and a.scan_lock_until > now() then
    raise exception 'UNLOCK_ABORTED: a full scan is in progress (lock until %) — retry in a minute', a.scan_lock_until;
  end if;
  if (select config_version from public.bot_configs where id = '327912ae-4e5b-4677-ad04-7c5d566f7990') is distinct from '1037e6170289f865e4d6618dcf28b94d'
     or (select count(*) from public.bot_configs where user_id = a.user_id) <> 1 then
    raise exception 'UNLOCK_ABORTED: config is not the frozen 1037e617 (or more than one config row)';
  end if;
  if (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset',
        'trg_paper_positions_entries_lock', 'trg_pending_orders_entries_lock', 'trg_pending_orders_dry_run_immutable')) <> 5 then
    raise exception 'UNLOCK_ABORTED: a safety trigger is missing or disabled';
  end if;
  -- D1 / D2+D3 must be in place: no client RPC or client write can create real exposure after unlock
  if (select count(*) from pg_trigger where tgname = 'a_real_exposure_admission' and tgenabled <> 'D'
        and ((tgrelid = 'public.pending_orders'::regclass and (tgtype & 28) = 28)      -- INSERT + UPDATE + DELETE
          or (tgrelid = 'public.paper_positions'::regclass and (tgtype & 28) = 4))) <> 2 -- INSERT
     or has_table_privilege('authenticated', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('anon', 'public.pending_orders', 'INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 'UNLOCK_ABORTED: D2/D3 not in place (admission triggers, or client write privileges on pending_orders)';
  end if;
  if has_function_privilege('anon', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)', 'execute')
     or has_function_privilege('anon', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)', 'execute')
     or has_function_privilege('anon', 'public.finalize_live_broker_position(uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.finalize_live_broker_position(uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.retarget_pending_to_impulse_candidate(uuid,uuid,text)', 'execute') then
    raise exception 'UNLOCK_ABORTED: D1 not applied — a client can still execute a legacy exposure RPC';
  end if;
  if (select mode from public.paper_ledger_guard where id = 1) is distinct from 'enforce'
     or (select drift from public.paper_account_reconciliation where account_id = a.id) is distinct from 0 then
    raise exception 'UNLOCK_ABORTED: ledger guard not enforcing, or ledger drift';
  end if;
  update public.paper_accounts
     set entries_locked = false, is_paused = false,
         entries_locked_reason = 'UNLOCKED (atomic, zero dry-run orders) for frozen experiment 1037e617 — final approval ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z',
         entries_locked_at = now()
   where id = a.id;
end $u$;
commit;
select balance, is_paused, entries_locked, kill_switch_active, entries_locked_at as live_from, entries_locked_reason
  from public.paper_accounts where bot_id = 'smc';
-- expect: 100000 | f | f | f | <time> | UNLOCKED (atomic …
-- then, after the next scan: select count(*) from pending_orders where dry_run is true and created_at > <live_from>;  → 0
-- (a manual "Scan Now" already in flight across the commit could still place ONE dry-run order with the old flags: no real
--  exposure, but it would hold its symbol+direction up to 480 min — see the post-unlock checklist)
