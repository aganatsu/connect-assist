# SMC clean $100,000 reset — proposed scope (NOT EXECUTED)

Status: **proposal for approval.** Nothing in this document has been run. The
SQL is kept here, not in `supabase/migrations/`, so merging the settlement PR
cannot execute it by accident.

Snapshot it depends on:
`research_snapshots/2026-10-05_pre_reset_v1/` (121,801 rows, 79 tables,
sha256 per table in `MANIFEST.json`; derived reconciliation in `derived/`).
A **second snapshot is taken immediately before execution** and its manifest
compared with the first, so the gap between them is also preserved.

## 0. State being reset (as of 2026-10-05 16:02 UTC)

| | Stored | True |
|---|---|---|
| Balance | 105,879.62 | **105,008.43** — 100,000 + 5,008.43 realized over 34 trades |
| Phantom credit | — | 871.19 (USD/JPY 0e76555c double credit, 2026-09-16) |
| Open position | CHF/JPY long 4.47 @ 190.31367 (row `82541e09…`, pos `2527bfa5`) | −814.24 unrealized at 190.0259 / USDJPY 157.98 |
| Equity | 105,065.38 (stored balance + unrealized) | **104,194.19** |
| Peak balance | 105,879.62 (inflated by phantom) | 105,008.43 |
| Daily P&L base | 105,485.18 dated 2026-10-05 | — |
| Live pending orders | 2 `awaiting_confirmation`: GBP/USD short `3f39df7b`, USD/JPY short `ed07f20a` | |
| Watching staged setups | 2 | |
| Config | 10 distinct config hashes across the 34 period trades (21 changes since 09-15) | |

## 1. Preconditions (each is checked by the SQL; any failure aborts the whole transaction)

1. The settlement-ledger PR is merged and verified (`docs/PAPER_SETTLEMENT_LEDGER_V1.md` §5 steps 1–4).
2. `paper_ledger_guard.mode = 'enforce'` — so nothing can write the balance outside the ledger once reset.
3. `paper_account_reconciliation.drift = 0` and `unledgered_writes_this_epoch = 0` for the SMC account.
4. Bot paused (`is_paused = true`) so no scan opens or closes anything mid-reset.
5. **Zero open SMC positions** — see decision D1.
6. Fresh pre-execution snapshot exported and its manifest recorded.

## 2. Decisions needed from you

**D1 — the open CHF/JPY position.** It must not be open at the reset.

- **(A) Recommended if you want the reset now:** flatten it at market through `settle_paper_position` *before* the reset, close_reason `account_reset_flatten`. Its real P&L is booked to the OLD period, so the old record is complete and the new period starts flat.
- (B) Wait for it to hit SL (189.860209) or TP (190.64615658) naturally, then reset.
- (C) Delete it without booking. **Not recommended**: the old period's record would silently lose a trade.

**D2 — resume trading after the reset?** The proposal leaves the bot **paused**. You unpause it when you are ready.

## 3. RESET (trading state)

| What | How | Why it affects trading |
|---|---|---|
| balance, peak_balance, daily_pnl_base, daily_pnl_base_date | `reset_paper_account(user,'smc',100000,reason)`: one `reset` ledger entry (amount = 100,000 − current), new epoch, `ledger_reset_at = now()` | sizing, drawdown gate (peak), daily-loss Gate 7 (daily base) |
| realized / unrealized P&L baseline | the new epoch: `paper_account_reconciliation.realized_pnl_this_epoch` starts at 0; no open positions → unrealized 0 | equity, prop-firm gate equity |
| scan_count, signal_count, rejected_count | set 0 | display counters |
| kill_switch_active, scan_lock_until | false, null | a stale lock or kill flag would block scans |
| started_at | now() | "running since" |
| open positions | D1 | |
| live pending orders (`pending`, `awaiting_confirmation`, `triggered`) | `status='cancelled'`, `cancel_reason='account_reset'`, `resolved_at=now()` — **updated, not deleted** | an old order filling into the new account |
| active staged setups (`watching`, `qualified`, `pending`, `awaiting_confirmation`) | `status='cancelled'`, `lifecycle_reason='account_reset'`, `resolved_at=now()` — updated, not deleted | an old watchlist promotion into the new account |
| thesis conviction state | delete `kv_cache` keys `thesis_conviction:<user>:smc:*` (none exist at snapshot time; the step is for completeness) | conviction gate carry-over |
| cooldown, consecutive-loss streak, daily-$ loss (gates 13–15) | **no data change** — the settlement PR makes these read only trades closed since `ledger_reset_at` | otherwise old losses would block the new account |
| win/loss counters, daily P&L, equity curve on the dashboard | **no data change** — the settlement PR makes `paper-trading` state read history since `ledger_reset_at` | otherwise the new account would display old trades |
| duplicate/backfill bookkeeping | handled by the ledger: a pre-reset position can only settle as a zero-amount `pre_epoch_close`; a backfill never credits | an old trade modifying the new balance |
| break-even / trailing state | lives on the position row (`close_reason` tag, `signal_reason.exitFlags`) — gone with zero open positions | |

## 4. PRESERVE (not touched)

Strategy code; `bot_configs` and `bot_config_change_log`; the pre-reset
snapshot; and every research / reference table, including:

`paper_trade_history` (all 482 rows; the old period stays queryable by
`closed_at < ledger_reset_at`), `close_audit_log`, `paper_account_ledger`
(append-only — the reset is itself an entry), `trade_reasonings`,
`rejected_setups`, `setup_lifecycle_events`, `pending_orders` and
`staged_setups` history rows, `route2_poll_log`, `scan_logs`, `scan_history`,
`smc_scan_*`, `structural_order_blocks_v2`, `structure_shadow_telemetry`,
`ipo_*` (IPO parked; its own ledger untouched), `ezzy_labelled_examples`,
`ipo_corpus_examples`, `kv_cache` market-data keys (`candles:*`,
`smc_rate_cache:*`), `bot_recommendations`, `broker_*`, `prop_firm_config`,
`scanner_*`, `api_credit_usage`.

Note: until now the UI's **"Full Reset" button deleted** `paper_trade_history`,
`trade_reasonings`, `trade_post_mortems`, `scan_logs` and `trades`. The
settlement PR changes it to keep them.

## 5. Execution SQL (draft — run only after approval, in one transaction)

```sql
begin;
do $$
declare
  c_account constant uuid := '3e4b5dcb-c47e-425b-a5ae-20e90aa81226';
  c_user    constant uuid := '57c79dee-db6b-4fae-b34a-4b64ce33ca34';
  v_acct    public.paper_accounts%rowtype;
  v_rec     record;
  v_reset   jsonb;
begin
  select * into v_acct from public.paper_accounts where id = c_account and user_id = c_user and bot_id = 'smc' for update;
  if not found then raise exception 'SMC account not found'; end if;
  if not v_acct.is_paused then raise exception 'pause the bot first'; end if;
  if (select mode from public.paper_ledger_guard where id = 1) <> 'enforce' then
    raise exception 'ledger guard must be in enforce mode';
  end if;
  select * into v_rec from public.paper_account_reconciliation where account_id = c_account;
  if v_rec.drift <> 0 or v_rec.unledgered_writes_this_epoch <> 0 then
    raise exception 'ledger not reconciled: drift %, unledgered writes %', v_rec.drift, v_rec.unledgered_writes_this_epoch;
  end if;
  if exists (select 1 from public.paper_positions where user_id = c_user and coalesce(bot_id,'smc') = 'smc') then
    raise exception 'open SMC positions remain — resolve D1 first';
  end if;

  update public.pending_orders
     set status = 'cancelled', cancel_reason = 'account_reset', resolved_at = now(), updated_at = now()
   where user_id = c_user and bot_id = 'smc' and status in ('pending','awaiting_confirmation','triggered');

  update public.staged_setups
     set status = 'cancelled', lifecycle_reason = 'account_reset', resolved_at = now(), updated_at = now()
   where user_id = c_user and coalesce(bot_id,'smc') = 'smc'
     and status in ('watching','qualified','pending','awaiting_confirmation');

  delete from public.kv_cache where key like 'thesis_conviction:' || c_user || ':smc:%';

  v_reset := public.reset_paper_account(c_user, 'smc', 100000,
    'clean $100k start; pre-reset snapshot research_snapshots/2026-10-05_pre_reset_v1');
  if (v_reset->>'reset')::boolean is not true then raise exception 'reset refused: %', v_reset; end if;

  update public.paper_accounts
     set scan_count = 0, signal_count = 0, rejected_count = 0,
         kill_switch_active = false, scan_lock_until = null, started_at = now()
   where id = c_account;
end $$;
commit;
```

(Columns verified against the snapshot manifest: `staged_setups` and
`pending_orders` both have `user_id`, `bot_id`, `status`, `resolved_at`,
`updated_at`; `cancel_reason` / `lifecycle_reason` exist respectively.
`terminal_reason` is left NULL — its CHECK list has no reset value — so the
Route 2 forward study must exclude `cancel_reason = 'account_reset'`.)

## 6. Verification after execution (read-only)

| Check | Expected |
|---|---|
| `paper_accounts.balance`, `peak_balance`, `daily_pnl_base` | 100000, 100000, 100000 |
| `paper_account_reconciliation`: `account_balance`, `ledger_balance`, `drift` | 100000, 100000, 0 |
| `realized_pnl_this_epoch`, `pre_epoch_settlements_this_epoch` | 0, 0 |
| open SMC positions | 0 → unrealized 0, equity = 100000 |
| live pending orders / active staged setups | 0 / 0 |
| latest ledger entry | kind `reset`, amount = 100000 − balance before, `balance_after = 100000` |
| guard | a test `update paper_accounts set balance = balance + 1` is **refused** (run inside `begin … rollback`) |
| old trade cannot settle into the new balance | covered by the ledger test "after a reset, a position opened before it cannot move the new balance"; with zero open positions there is nothing left to settle |
| backfill cannot recreate an old settlement | `backfill_paper_trade_history` never posts to the ledger (test "backfill BEFORE/AFTER settlement") |
| gates 13–15 and dashboard | read only trades with `closed_at >= ledger_reset_at` → none |
| snapshot files intact | `MANIFEST.json` sha256 re-verified |
