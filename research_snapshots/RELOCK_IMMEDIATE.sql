-- RE-LOCK — immediate, one statement, NO preconditions (it must never be blocked). Safe at any stage.
-- Effect: the database refuses every new position and every new real order (entries_lock_insert_guard); the hunt refuses
-- real fills (bot-scanner "entries_locked" branch); open positions stay open and keep their SL/TP management and settle
-- through the ledger. With simplification.dryRunWhenLocked=true the scanner resumes placing DRY-RUN orders only.
-- NEVER use kill_switch_active as a re-lock: the manage cron skips kill-switched accounts, so open positions would
-- stop being managed. Do not reset the account.
update public.paper_accounts
   set entries_locked = true, is_paused = true,
       entries_locked_reason = 'RE-LOCK ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z: <reason>',
       entries_locked_at = now()
 where bot_id = 'smc'
returning balance, is_paused, entries_locked, kill_switch_active, entries_locked_reason,
          (select count(*) from public.paper_positions) as open_positions,
          (select count(*) from public.pending_orders where status in ('pending', 'awaiting_confirmation', 'triggered') and dry_run is not true) as active_real_orders;
