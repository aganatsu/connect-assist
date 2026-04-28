# Task: fix-reset-daily-baseline-v2

## Branch: manus/fix-reset-daily-baseline-v2

## Behavior changes

1. **Paper-trading reset paths now use the correct column `daily_pnl_base_date`** instead of the legacy `daily_pnl_date`. Previously, resets wrote to the wrong column, so the bot-scanner's Gate 7 never saw the reset date and would fall back to using current balance as the base (making daily loss always 0%).

2. **Paper-trading `reset_account` now sets `is_paused: true`** instead of `is_paused: false`. Previously, a full reset would leave the bot running, which could immediately start taking trades on a freshly wiped account before the user reviews settings.

3. **Paper-trading `reset_account` now deletes from the `trades` table** in addition to the existing 5 tables. Previously, live/pending trade records were orphaned after a full reset.

4. **Paper-trading `reset_account` response now includes `paused: true`** so the frontend can reflect the paused state immediately without a refetch.

5. **Bot-scanner Gate 7 now reads `daily_pnl_base_date`** instead of `daily_pnl_date`. This aligns it with what both the paper-trading and bot-scanner day-rollover paths write.

6. **Bot-scanner day-rollover now writes `daily_pnl_base_date`** instead of `daily_pnl_date`. This aligns it with the paper-trading day-rollover and with Gate 7.

7. **Migration added to drop the legacy `daily_pnl_date` column** from `paper_accounts`. This prevents future confusion between the two columns.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/paper-trading/index.ts` | Fixed column name in `set_balance`, `reset_balance_only`, `reset_account` paths (daily_pnl_date -> daily_pnl_base_date with today's date). Fixed `reset_account`: is_paused -> true, added trades table deletion, added paused:true to response. |
| `supabase/functions/bot-scanner/index.ts` | Fixed Gate 7 column read (daily_pnl_date -> daily_pnl_base_date). Fixed day-rollover column write (daily_pnl_date -> daily_pnl_base_date). |
| `supabase/functions/paper-trading/reset.test.ts` | New test file with 14 tests covering all reset paths, column names, Gate 7 math. |
| `supabase/migrations/20260428120000_drop_legacy_daily_pnl_date.sql` | Migration to drop the orphaned `daily_pnl_date` column. |

## Extra caution file changes

### paper-trading/index.ts

Three reset/set paths (`set_balance`, `reset_balance_only`, `reset_account`) were writing to the legacy column `daily_pnl_date` (which existed in the DB but was never read by Gate 7 after the `daily_pnl_base_date` column was introduced). All three now write to `daily_pnl_base_date` with today's ISO date string. The `reset_account` path also had `is_paused: false` changed to `is_paused: true` (preventing the bot from auto-starting after a full reset), and a new `trades` table deletion was added to match the other 5 table deletions. The `daily_pnl_base` values remain set to `startBal` (for resets) and `balStr` (for set_balance), which is the correct semantic: the PnL base should equal the current balance at the time of reset.

### bot-scanner/index.ts

Two changes, both column name corrections only:
1. Gate 7 (line 983): `account.daily_pnl_date === todayStr` changed to `account.daily_pnl_base_date === todayStr`. This is required because the day-rollover now writes to `daily_pnl_base_date`. Without this change, Gate 7 would always fall back to `actualBase = balance`, making `dailyLoss = 0` and effectively disabling the daily loss protection.
2. Day-rollover (lines 1963-1966): `daily_pnl_date: todayStr` changed to `daily_pnl_base_date: todayStr`. Aligns with what paper-trading writes and what Gate 7 reads.

No gate logic was changed. The formula `dailyLoss = actualBase - balance; dailyLossPercent = actualBase > 0 ? (dailyLoss / actualBase) * 100 : 0` is untouched.

## Tests added

| Test | Assertion |
|------|-----------|
| `reset_balance_only: daily_pnl_base equals startBal` | Verifies daily_pnl_base is set to startBal, not "0" |
| `reset_balance_only: uses daily_pnl_base_date column` | Verifies correct column name, no legacy column |
| `reset_account: is_paused is true, not false` | Verifies is_paused: true |
| `reset_account: deletes from trades table` | Verifies trades table deletion present |
| `reset_account: daily_pnl_base equals startBal` | Verifies daily_pnl_base is set to startBal, not "0" |
| `reset_account: uses daily_pnl_base_date column` | Verifies correct column name, no legacy column |
| `day-rollover: daily_pnl_base equals currentBalance` | Verifies H17 block sets daily_pnl_base to currentBalance |
| `reset_account: response includes paused: true` | Verifies response includes paused flag |
| `set_balance: uses daily_pnl_base_date column` | Verifies correct column name in set_balance path |
| `global: no references to wrong column in paper-trading` | Scans entire file for legacy column references |
| `reset_account: deletes from all 6 required tables` | Verifies all 6 tables are deleted |
| `bot-scanner: no references to wrong column` | Scans entire bot-scanner file for legacy column references |
| `Gate 7 math: $10000 base, $9500 balance -> 5%` | Verifies Gate 7 triggers at exactly the limit |
| `Gate 7 math: $10000 base, $9999 balance -> 0.01%` | Verifies Gate 7 passes for small losses |

## Tests run

```
$ deno test --allow-all --no-check supabase/functions/_shared/ supabase/functions/paper-trading/ supabase/functions/backtest-engine/
ok | 217 passed | 0 failed (5s)
```

14 new tests + 203 existing tests, all passing.

## Regression check

1. **Gate 7 formula unchanged.** The only changes to bot-scanner Gate 7 are the column name in the date comparison. The arithmetic (`dailyLoss = actualBase - balance`, `dailyLossPercent = ...`) is identical.

2. **daily_pnl_base values correct.** Unlike the previous PR (manus/fix-reset-and-daily-baseline) which set daily_pnl_base to "0" (breaking Gate 7), this PR keeps the original semantics: `startBal` for resets, `currentBalance` for day-rollover, `balStr` for set_balance.

3. **Column alignment verified.** All 3 writers (paper-trading day-rollover, bot-scanner day-rollover, reset paths) and the 1 reader (Gate 7) now use `daily_pnl_base_date`. Verified by grep: zero references to `daily_pnl_date` in non-comment lines of both files.

## Open questions

1. **Migration timing.** The migration to drop `daily_pnl_date` should be applied AFTER this code is deployed. If the migration runs before the code is deployed, the old code (still referencing `daily_pnl_date`) will error. Recommend: deploy code first, verify, then apply migration.

2. **Previous PR branch.** The branch `manus/fix-reset-and-daily-baseline` (from the previous task) set `daily_pnl_base = "0"` which would break Gate 7. That branch should NOT be merged. This branch supersedes it with correct values.

## Suggested PR title and description

**Title:** fix: align daily_pnl_base_date column across scanner, gate, and reset paths

**Description:**

Fixes the column name mismatch between paper-trading and bot-scanner for the daily PnL baseline tracking. All code paths now consistently use `daily_pnl_base_date` instead of the legacy `daily_pnl_date` column.

Also fixes:
- `reset_account` sets `is_paused: true` (was `false` -- bot could auto-start after reset)
- `reset_account` deletes from `trades` table (was missing)
- `reset_account` response includes `paused: true` for frontend

Includes migration to drop the orphaned `daily_pnl_date` column (apply after deploy).

14 new tests, 217 total passing.
