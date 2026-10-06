# System reset workflow — V1

The clean $100,000 reset is approved and executed from the **System Reset &
Ledger Health** card in the web app (`/system`, admin-only). Supabase provides
the state and the reset path. Nothing runs automatically.

## Pieces

| Piece | Where |
|---|---|
| Monitor (source of truth for health) | `settlement-monitor` Edge Function, pg_cron every 4h + one-shot 24h final (`supabase/cron/settlement_monitor_cron.sql`); results in `settlement_monitor_runs` |
| Readiness + reset orchestration | `system-reset` Edge Function → `_shared/systemReset.ts` |
| Admins | `app_admins` table, `is_app_admin()`; seeded with the account owner |
| Audit trail | `account_reset_runs`: one row per attempt, including aborted ones. Never deletable, immutable once terminal |
| In-DB pre-reset snapshot | `account_reset_snapshots`: account, full ledger, reconciliation, period history, closed positions, cancelled orders/setups, config + hash. Append-only |
| Execution switch | `system_reset_controls.execute_enabled`. **Ships false** |
| UI | `src/components/SystemResetPanel.tsx`, `src/pages/SystemHealth.tsx`, admin-only rail icon |

## Readiness — READY only if every one holds

1. 24-hour monitoring period completed: the final verdict is recorded and the window has elapsed.
2. All monitoring checks passed, made up of:
   - every periodic run this epoch passed;
   - the final verdict passed;
   - the last run is under 5 hours old (the monitor is alive).
3. Reconciliation drift = $0 (live).
4. Unledgered writes = 0 (live).
5. Unsettled closed trades = 0, in both history and close_audit_log (live).
6. Settlement ledger healthy: all six monitor checks, run live, including duplicate keys and chain continuity.
7. Direct-write guard is **BLOCKING** (`enforce`).
8. Accounting objects present: ledger, reconciliation, guard and its trigger, monitor table, settle/reset functions, `closed_at` as timestamptz.
9. No active settlement error: no failed monitor run in the last 24 hours, and no reset currently running.
10. Prices and FX rates are fresh. This only applies while old positions are open, because they are closed at market.

The card lists every condition with its evidence and names the ones blocking. The approve button is enabled only when READY **and** the execution switch is on.

## Approval

1. Click **Approve Full Demo Reset**. This only opens a dialog.
2. The dialog shows the balance, equity, open positions, pending orders and setups. It warns that old-period exposure is closed or cancelled and that active state is reset, and it confirms that history and snapshots are preserved.
3. The final button enables only on the exact text `RESET 100000`: no trimming, no case folding.
4. The request carries the readiness **fingerprint** the dialog was showing. It covers balance, epoch, guard, the ids of positions, orders and setups, and the final verdict. If anything changed since the dialog opened, the server aborts.

## Server-side authorization

`system-reset` refuses a service-role token. It verifies the user session with `auth.getUser`, then checks `is_app_admin(user)` before any action, readiness included. No service-role credential reaches the browser. The SQL objects grant nothing to `anon`; only admins can read the audit and snapshot tables (RLS).

## The sequence (`runSystemReset`)

1. Recompute readiness from scratch; check the phrase, the execution switch, READY and the fingerprint. On any failure → **aborted**, recorded, nothing touched.
2. Insert a `running` row with a unique `reset_id`. The unique index allows one running reset at a time.
3. Pause new entries (`is_paused`) **and set the entries lock** (`entries_locked`). The management cron keeps running, so prices stay fresh.
4. Cancel old-period pending orders (`placed_at` < start). This deliberately happens **before** closing positions, so an old order can't fill mid-flatten. An order a filler had already claimed becomes a position, and the next pass closes it.
5. Cancel old watched or armed setups.
6. Close every old-period position at market through `settle_paper_position`:
   - source `account_reset_flatten`, booked to the OLD period;
   - P&L uses the scanner formula with fresh FX rates;
   - a missing or stale rate, a missing price, a position newer than the reset start, or any settlement other than `settled`/`already_settled` → **STOP**;
   - up to 3 passes, to catch a late fill.
7. Verify the ledger is clean after the flatten.
8. Take the in-DB snapshot.
9. `reset_paper_account(100000)`: a ledger reset entry and a new epoch. `ledger_reset_at` makes any pre-reset position settle for 0.
10. Clear only active state: counters, kill switch, scan lock, thesis-conviction kv keys.
11. Verify post-reset. Every one must hold:
    - balance and equity are $100,000.00;
    - realized and unrealized P/L are $0;
    - zero positions, orders and setups;
    - daily P/L is $0 and the daily base is $100,000;
    - peak (drawdown baseline) is $100,000;
    - no pre-reset positions remain;
    - the latest ledger entry is `reset`;
    - drift is $0 and there are no unledgered writes.
    - trading is paused and new entries are locked.
12. **Do NOT resume.** A successful reset ends paused and entries-locked.

Any failure from step 3 on → status `failed`, `failed_step` and `failure_reason` recorded, the bot **left paused and locked**, and no further steps run.

## After the reset: PAUSED and LOCKED until the new configuration is approved

The reset is the accounting boundary that closes the old experiment, not a restart:

```
OLD PERIOD → SNAPSHOT → RESET → PAUSE → CLEAN BOT → VERIFY → NEW EXPERIMENT
```

`paper_accounts.entries_locked` (migration `20261006040000`):

- The scanner treats a locked account as paused (no staging, promotion or Route 2 placement), whatever `is_paused` says.
- **Both** Route 2 fill pollers refuse to fill while locked.
- A database trigger lets only the service role or a database administrator change it. The app's Start/Resume button clears `is_paused` but **cannot** lift the lock.

Steps 8–18 of the agreed sequence happen with the account locked:

- simplification;
- Route 2 sizing at fill;
- Route 2 stop anchor;
- one fill poller;
- unified caps;
- FTMO daily loss / drawdown;
- explicit config;
- attribution;
- the minimal frozen config;
- the full test suite;
- your review of the effective configuration and trading path.

**Unlock (step 19, only after your approval)** is one hand-applied statement, like the other production switches:

```sql
update public.paper_accounts
   set entries_locked = false, entries_locked_reason = 'new experiment approved by <you> on <date>, config <hash>',
       entries_locked_at = now(), is_paused = false
 where bot_id = 'smc';
```

## Enabling execution (separate approval)

After reviewing the readiness screen and a dry run (**Preview reset plan**, which changes nothing), enabling is one hand-applied statement (`docs/DEPLOYMENT.md`):

```sql
update public.system_reset_controls set execute_enabled = true, updated_at = now(),
  note = 'enabled by <you> after reviewing readiness + dry run' where id = 1;
```

Even then, the reset needs READY + admin + typed phrase + matching fingerprint.

## Release order

1. Apply migrations `20261006020000` (monitor) and `20261006030000` (this) by hand, in one transaction. Then `20261006040000` (entries lock) the same way, before merging the code that reads it.
2. Merge #629, then this PR. Functions deploy, with execution off.
3. Run `supabase/cron/settlement_monitor_cron.sql`.
4. Open `/system` and review.
5. When the window passes: approve the guard → `enforce`, then approve enabling execution, then use the card.
