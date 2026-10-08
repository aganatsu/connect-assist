-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SUPERSEDED — DO NOT RUN. Withdrawn 2026-10-08: the paused-but-unlocked drain state let     ║
-- ║ client paths create real exposure. Replaced by UNLOCK_ATOMIC_AT_ZERO_DRY.sql. Kept only    ║
-- ║ for audit history. The first statement below aborts the script.                            ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
do $superseded$ begin raise exception 'SUPERSEDED — DO NOT RUN: use UNLOCK_ATOMIC_AT_ZERO_DRY.sql'; end $superseded$;

-- FINAL CONTROLLED UNLOCK — STAGE 1 of 2: entries_locked → false, is_paused stays TRUE.
-- DO NOT RUN without explicit final approval. SQL editor (the entries-lock guard allows only the server / a DB admin).
-- Effect (bot-scanner:2572-2573): dryRunActive = false and isPaused = true → no new orders of any kind (no dry-run,
-- no real); the hunt keeps running, so the remaining dry-run orders finish their lifecycle (≤ 480 min) as dry runs.
-- Fails closed: one transaction; aborts with STAGE1_ABORTED before any change if the state is not exactly the baseline.
begin;
set local lock_timeout = '5s';
do $s1$
declare a record; n int;
begin
  lock table public.paper_positions, public.pending_orders in share row exclusive mode;
  if (select count(*) from public.paper_accounts where bot_id = 'smc') <> 1 then raise exception 'STAGE1_ABORTED: expected one SMC account'; end if;
  select * into a from public.paper_accounts where bot_id = 'smc' for update;
  if a.balance is distinct from 100000 or a.is_paused is distinct from true or a.entries_locked is distinct from true
     or a.kill_switch_active is distinct from false or a.execution_mode is distinct from 'paper' then
    raise exception 'STAGE1_ABORTED: account not at baseline (balance %, paused %, locked %, kill %, mode %)', a.balance, a.is_paused, a.entries_locked, a.kill_switch_active, a.execution_mode;
  end if;
  select count(*) into n from public.paper_positions; if n <> 0 then raise exception 'STAGE1_ABORTED: % position(s)', n; end if;
  select count(*) into n from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true;
  if n <> 0 then raise exception 'STAGE1_ABORTED: % active real order(s)', n; end if;
  if (select config_version from public.bot_configs where id = '327912ae-4e5b-4677-ad04-7c5d566f7990') is distinct from '1037e6170289f865e4d6618dcf28b94d'
     or (select count(*) from public.bot_configs where user_id = a.user_id) <> 1 then
    raise exception 'STAGE1_ABORTED: config is not the frozen 1037e617 (or more than one config row)';
  end if;
  if (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset',
        'trg_paper_positions_entries_lock', 'trg_pending_orders_entries_lock', 'trg_pending_orders_dry_run_immutable')) <> 5 then
    raise exception 'STAGE1_ABORTED: a safety trigger is missing or disabled';
  end if;
  if (select mode from public.paper_ledger_guard where id = 1) is distinct from 'enforce'
     or (select drift from public.paper_account_reconciliation where account_id = a.id) is distinct from 0 then
    raise exception 'STAGE1_ABORTED: ledger guard not enforcing, or ledger drift';
  end if;
  update public.paper_accounts
     set entries_locked = false,
         entries_locked_reason = 'UNLOCKED stage 1 (still paused) for frozen experiment 1037e617 — final approval ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z',
         entries_locked_at = now()
   where id = a.id;
end $s1$;
commit;
select balance, is_paused, entries_locked, kill_switch_active, entries_locked_reason,
       (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is true) as dry_orders_draining,
       (select max(expires_at) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is true) as drained_by
  from public.paper_accounts where bot_id = 'smc';
-- expect: 100000 | t | f | f | UNLOCKED stage 1 … | n | <latest dry expiry>
