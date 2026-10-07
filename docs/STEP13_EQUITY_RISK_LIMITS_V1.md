# Step 13 — equity-based daily loss and overall floor (pre-merge report)

**Status:** built and tested (PR, not merged). The account stays **paused and entries-locked**. FTMO stays disconnected.

**Activation (after merge, separate approval):** `prop_firm_config.is_active = true`. Until then, the gate returns "no active profile" and changes nothing. Gates 7, 8 and 15 keep running as today.

## The profile (all values on the `prop_firm_config` row; none hard-coded)

| | Value | Column |
|---|---|---|
| Initial balance | $100,000 | `initial_balance` |
| FTMO hard daily limit | 5% = $5,000 | `max_daily_loss_pct` |
| FTMO hard overall floor | $90,000 | `max_overall_loss_pct` 0.10 |
| Our daily entry stop | 3% = $3,000 | `daily_entry_stop_pct` (new) |
| Our daily flatten | 4% = $4,000 | `daily_flatten_pct` (new) |
| Our overall entry stop | equity ≤ $92,000 | `overall_entry_stop_equity` (new) |
| Our overall flatten | equity ≤ $91,000 | `overall_flatten_equity` (new) |
| Trading day | midnight Europe/Prague (CE(S)T) | `day_boundary_tz` (new) |
| Equity source | paper ledger + open positions | `equity_source` (new; `broker` → blocks entries until reconciliation exists) |
| Size reduction | off | `reduce_size_near_limit` false; the new path has none |
| Profit-target shutdown | off | `profit_target_pct` null; the new path has none |

Migration `20261007010000_step13_risk_profile.sql` adds the columns, plus database constraints that enforce the ordering:
- entry stop < flatten < hard limit;
- hard floor < flatten floor < entry-stop floor < initial balance.

The engine also validates the profile; an invalid profile blocks entries and never flattens.

## How it measures

- **Trading day:** `tradingDayAt(now, tz)` is the only definition: the local date in Europe/Prague, so 22:00 UTC in summer and 23:00 UTC in winter. DST change days are 25 h in October and 23 h in March.
- **Day-start balance:** the settlement-ledger `balance_after` of the last entry before the boundary, in the current epoch. If the epoch began during the day, the reset entry is used. Nothing has to run at midnight.
- **Equity:** balance (all realized P/L) + floating P/L in USD − commissions + swaps. Floating P/L = price move × 100,000 × lots × quote→USD, the same formula as every settlement. Paper charges no commission or swap, so both are 0 today; the calculator takes them as inputs.
- **Daily loss:** day-start balance − equity.

## What changed in the code

1. `_shared/accountRiskLimits.ts` (new, pure):
   - `tradingDayAt`, `dayStartBalanceFromLedger`, `computeEquity`, `validateProfile`, `evaluateAccountRisk`.
2. `_shared/propFirmGate.ts`:
   - `runPropFirmGate` uses the above. It never throws; every failure is a fail-closed data error.
   - Day state is recorded from the ledger.
   - An entry stop or flatten locks the trading day.
   - A locked day can still flatten if the loss deepens.
   - Removed: the ×100,000 equity, the first-scan day start, broker-equity priority, and the three fail-open skips (profile read error, broker equity unavailable, sanity check).
3. `bot-scanner`:
   - The gate is evaluated **once per cycle, before the Route 2 hunt**; any flatten happens there.
   - The hunt checks the result **before both the dry-run and the real fill** (outcome `PROP_FIRM_LOCKED`).
   - Placement is blocked for the cycle when entries aren't allowed.
   - The per-cycle MetaAPI `account-information` fetch for the gate is gone.
4. `prop-firm-daily-reset`:
   - Retired as a day owner: kept, but it writes nothing and reports the current trading day.
   - Its two cron jobs are removed from `setup_cron.sql` and unscheduled below.
5. `prop-firm` (status API):
   - Uses `tradingDayAt`.
   - Shows broker equity only for a `broker` profile.

**Fail-closed rule:** missing FX rate, price, contract spec, ledger, epoch or profile value, or an unsupported equity source, blocks entries and fills. It **never** flattens. Only a successful calculation that crosses a flatten threshold sets `shouldCloseAll`.

## Tests

- `supabase/tests/_shared/step13EquityRiskLimits.test.ts` (23 tests) covers:
  - the trading day (summer, winter, DST days, agreement with the old rule on every day of a year);
  - day start from the ledger;
  - USD conversion for USD/JPY, CHF/JPY, NZD/CAD and NZD/CHF;
  - commissions and swaps;
  - exact 3%/4% and $92k/$91k thresholds, and profile-driven hard limits;
  - data errors that never flatten;
  - invalid profiles;
  - the gate's I/O, lock, flatten-while-locked and next-day unlock;
  - the overnight position;
  - source wiring;
  - the migration on real Postgres.
- `propFirmGate.test.ts` and `propFirmBrokerEquity.test.ts`: the old tests that asserted fail-open behaviour are replaced by tests asserting fail-closed behaviour.

## Deploy steps (after approval)

1. SQL editor (one transaction): the migration, its `schema_migrations` row, the profile values, and the cron unschedules:

```sql
begin;
-- contents of supabase/migrations/20261007010000_step13_risk_profile.sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20261007010000', '20261007010000_step13_risk_profile') on conflict (version) do nothing;
update public.prop_firm_config
   set firm_type = 'ftmo_2step', initial_balance = 100000,
       max_daily_loss_pct = 0.05, max_overall_loss_pct = 0.10, trailing_drawdown = false,
       daily_entry_stop_pct = 0.03, daily_flatten_pct = 0.04,
       overall_entry_stop_equity = 92000, overall_flatten_equity = 91000,
       day_boundary_tz = 'Europe/Prague', equity_source = 'paper',
       reduce_size_near_limit = false, profit_target_pct = null, close_on_breach = true,
       updated_at = now()
 where user_id = '57c79dee-db6b-4fae-b34a-4b64ce33ca34' and bot_id = 'smc';   -- is_active unchanged (false)
select cron.unschedule('prop-firm-daily-reset-summer');
select cron.unschedule('prop-firm-daily-reset-winter');
notify pgrst, 'reload schema';
commit;
```

2. Merge (CI green). Functions deploy; the profile is still inactive, so nothing changes.
3. With approval: set `is_active = true`, then verify the next cycle's `[prop-firm-gate]` record:
   - day 2026-10-07 or 2026-10-08;
   - start balance $100,000 (the reset entry);
   - equity $100,000;
   - `ok`.
