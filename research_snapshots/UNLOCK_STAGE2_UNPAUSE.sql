-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SUPERSEDED — DO NOT RUN. Withdrawn 2026-10-08: the paused-but-unlocked drain state let     ║
-- ║ client paths create real exposure. Replaced by UNLOCK_ATOMIC_AT_ZERO_DRY.sql. Kept only    ║
-- ║ for audit history. The first statement below aborts the script.                            ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
do $superseded$ begin raise exception 'SUPERSEDED — DO NOT RUN: use UNLOCK_ATOMIC_AT_ZERO_DRY.sql'; end $superseded$;

-- FINAL CONTROLLED UNLOCK — STAGE 2 of 2: is_paused → false. LIVE (paper) TRADING STARTS on the next full scan.
-- DO NOT RUN without explicit final approval, and only after STAGE 1 and every stage-1 check passed.
-- Requires ZERO active dry-run orders: a dry-run order still active on a symbol+direction would absorb the first real
-- setup there (same-level refresh in place, or a 'duplicate' on the unique active index) and it can never fill as real.
begin;
set local lock_timeout = '5s';
do $s2$
declare a record; n int;
begin
  lock table public.paper_positions, public.pending_orders in share row exclusive mode;
  if (select count(*) from public.paper_accounts where bot_id = 'smc') <> 1 then raise exception 'STAGE2_ABORTED: expected one SMC account'; end if;
  select * into a from public.paper_accounts where bot_id = 'smc' for update;
  if a.balance is distinct from 100000 or a.is_paused is distinct from true or a.entries_locked is distinct from false
     or a.kill_switch_active is distinct from false or a.execution_mode is distinct from 'paper' then
    raise exception 'STAGE2_ABORTED: account not in the stage-1 state (balance %, paused %, locked %, kill %, mode %)', a.balance, a.is_paused, a.entries_locked, a.kill_switch_active, a.execution_mode;
  end if;
  select count(*) into n from public.paper_positions; if n <> 0 then raise exception 'STAGE2_ABORTED: % position(s)', n; end if;
  select count(*) into n from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true;
  if n <> 0 then raise exception 'STAGE2_ABORTED: % active real order(s)', n; end if;
  select count(*) into n from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is true;
  if n <> 0 then raise exception 'STAGE2_ABORTED: % dry-run order(s) still active — wait for them to finish', n; end if;
  if (select config_version from public.bot_configs where id = '327912ae-4e5b-4677-ad04-7c5d566f7990') is distinct from '1037e6170289f865e4d6618dcf28b94d' then
    raise exception 'STAGE2_ABORTED: config is not the frozen 1037e617';
  end if;
  if (select drift from public.paper_account_reconciliation where account_id = a.id) is distinct from 0 then
    raise exception 'STAGE2_ABORTED: ledger drift';
  end if;
  update public.paper_accounts set is_paused = false where id = a.id;
end $s2$;
commit;
select balance, is_paused, entries_locked, kill_switch_active, now() as live_from from public.paper_accounts where bot_id = 'smc';
-- expect: 100000 | f | f | f | <time>
