# Task: Fix paper-trading reset & daily PnL baseline bugs

## Branch: manus/fix-reset-and-daily-baseline

## Behavior changes

1. **`reset_balance_only` action:** `daily_pnl_base` is now set to `"0"` instead of `startBal`. The column `daily_pnl_base_date` is set to today's date (previously wrote to the wrong column `daily_pnl_date`).
2. **`reset_account` action:** `daily_pnl_base` is now set to `"0"` instead of `startBal`. `is_paused` is now `true` instead of `false` — the bot will not auto-start after a full reset. The `trades` table is now purged alongside the other 5 tables. The column `daily_pnl_base_date` is set to today's date (previously wrote to the wrong column `daily_pnl_date`). The response now includes `paused: true` so the frontend can reflect the paused state.
3. **`set_balance` action:** The column `daily_pnl_date` (wrong) was changed to `daily_pnl_base_date` (correct) with today's date.
4. **Day-rollover (status action):** `daily_pnl_base` is now set to `"0"` instead of `currentBalance`. This means the daily loss gate (Gate 7 in bot-scanner) will see `actualBase = 0` and the guard `actualBase > 0 ? ... : 0` will produce `dailyLossPercent = 0`, effectively disabling the daily loss gate until the scanner's own day-rollover sets a real base.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/paper-trading/index.ts` | Fixed 4 bugs across 4 code paths: day-rollover (line 766–777), set_balance (line 1441–1456), reset_balance_only (line 1458–1467), reset_account (line 1469–1485). All `daily_pnl_base` values changed from `startBal`/`currentBalance` to `"0"`. All `daily_pnl_date` references changed to `daily_pnl_base_date`. `is_paused` changed from `false` to `true` in reset_account. Added `trades` table deletion in reset_account. |
| `supabase/functions/paper-trading/reset.test.ts` | New test file with 12 structural regression tests. |

### Extra caution note — `paper-trading/index.ts`

This file is on the "extra caution" list. The changes are confined to 4 specific code blocks:

1. **Day-rollover (lines 766–777):** Removed the `currentBalance` variable and the `parseFloat(String(account.balance))` computation. The update now sets `daily_pnl_base: "0"` directly. This is safe because the day-rollover only fires once per day (guarded by `daily_pnl_base_date` comparison).

2. **set_balance (lines 1441–1456):** Changed column name from `daily_pnl_date: ""` to `daily_pnl_base_date: todayDate`. The `daily_pnl_base` value was left as `balStr` (not changed to `"0"`) because set_balance is a manual override — the user is explicitly setting a new balance, so the PnL base should match.

3. **reset_balance_only (lines 1458–1467):** Changed `daily_pnl_base: startBal` to `daily_pnl_base: "0"` and `daily_pnl_date: ""` to `daily_pnl_base_date: todayDate`.

4. **reset_account (lines 1469–1485):** Same `daily_pnl_base` and column name fixes. Added `is_paused: true`. Added `await supabase.from("trades").delete().eq("user_id", user.id)` before the account update. Added `paused: true` to the response object.

No other code paths in this file were modified. The position management, SL/TP detection, and engine processing logic are untouched.

## Tests added

| Test | Assertion |
|------|-----------|
| `reset_balance_only: daily_pnl_base is '0', not startBal` | The reset_balance_only block contains `daily_pnl_base: "0"` and does NOT contain `daily_pnl_base: startBal` |
| `reset_balance_only: uses daily_pnl_base_date column` | The block uses `daily_pnl_base_date:` and does NOT use `daily_pnl_date:` |
| `reset_account: is_paused is true, not false` | The block contains `is_paused: true` and does NOT contain `is_paused: false` |
| `reset_account: deletes from trades table` | The block contains `.from("trades").delete()` |
| `reset_account: daily_pnl_base is '0', not startBal` | The update payload contains `daily_pnl_base: "0"` and NOT `daily_pnl_base: startBal` |
| `reset_account: uses daily_pnl_base_date column` | The block uses `daily_pnl_base_date:` and does NOT use `daily_pnl_date:` |
| `day-rollover: daily_pnl_base is '0', not currentBalance` | The H17 block sets `daily_pnl_base: "0"` and does NOT reference `currentBalance` |
| `daily loss math: with base=0, dailyLoss = ...` | Verifies Gate 7 math produces `dailyLossPercent = 0` when `actualBase = 0` (gate disabled) |
| `reset_account: response includes paused: true` | The response includes `paused: true` |
| `set_balance: uses daily_pnl_base_date column` | The set_balance block uses `daily_pnl_base_date:` and NOT `daily_pnl_date:` |
| `global: no references to wrong column daily_pnl_date` | No non-comment code line in the file references `daily_pnl_date` |
| `reset_account: deletes from all 6 required tables` | All 6 tables (paper_positions, paper_trade_history, trade_reasonings, trade_post_mortems, scan_logs, trades) are deleted |

## Tests run

```
$ deno test --allow-all --no-check supabase/functions/_shared/ supabase/functions/paper-trading/ supabase/functions/backtest-engine/
ok | 215 passed | 0 failed (5s)
```

Full suite: 203 existing tests + 12 new tests = 215 total. All passing.

## Regression check

1. **Structural regression tests:** Tests 1–12 are source-code structural assertions that will fail if any of the 4 bugs are reintroduced (e.g., if someone changes `"0"` back to `startBal`, or `daily_pnl_base_date` back to `daily_pnl_date`).
2. **Gate 7 math regression:** Test 8 verifies the daily loss gate math with `base=0` and confirms the guard produces `dailyLossPercent = 0`, matching the expected behavior.
3. **No changes to scoring, gates, or position sizing:** This change only affects account reset/rollover logic. No confluence scoring, gate definitions, or position sizing code was modified.

## Open questions

1. **bot-scanner/index.ts day-rollover (lines 1963–1969):** This code also sets `daily_pnl_base: account.balance` and uses the wrong column name `daily_pnl_date`. It was NOT modified because the task brief says not to touch gate logic in bot-scanner. However, this means the scanner's day-rollover will continue writing to the wrong column (`daily_pnl_date`) and setting `daily_pnl_base` to `account.balance` (not `0`). The paper-trading status handler reads `daily_pnl_base_date`, so the two never see each other's updates. **Recommend a follow-up task to fix the scanner's day-rollover to match.**

2. **Daily loss gate disabled when base=0:** When `daily_pnl_base = 0`, the Gate 7 guard (`actualBase > 0 ? ... : 0`) produces `dailyLossPercent = 0`, effectively disabling the daily loss gate. This is the intended behavior per the task brief, but it means the gate won't fire until the scanner's own day-rollover sets a real base. If the scanner's day-rollover is also fixed to set base=0, the daily loss gate would be permanently disabled. **Confirm this is acceptable or if a different sentinel value should be used.**

3. **Two columns exist in DB:** Both `daily_pnl_date` (original, never dropped) and `daily_pnl_base_date` (added later) exist. The old column `daily_pnl_date` is now unused by paper-trading/index.ts but is still written to by bot-scanner/index.ts. **Recommend a migration to drop `daily_pnl_date` after the scanner is also fixed.**

## Suggested PR title and description

**Title:** fix(paper-trading): reset daily_pnl_base to 0, fix column name, pause on reset, purge trades

**Description:**

Fixes 4 bugs in the paper-trading reset and day-rollover logic, plus a bonus column name fix in set_balance:

- **Bug 1:** `reset_balance_only` and `reset_account` now set `daily_pnl_base` to `"0"` instead of `startBal`
- **Bug 2:** `reset_account` now sets `is_paused: true` so the bot doesn't auto-start after a full reset
- **Bug 3:** `reset_account` now deletes from the `trades` table alongside the other 5 tables
- **Bug 4:** Day-rollover now sets `daily_pnl_base` to `"0"` instead of `currentBalance`
- **Bonus:** All 3 reset/set paths were using the wrong column `daily_pnl_date` — fixed to `daily_pnl_base_date`

12 new regression tests added. Full suite: 215 passed, 0 failed.

**Note:** `bot-scanner/index.ts` has the same column name bug and day-rollover logic (lines 1963–1969) but was not modified per task scope. Recommend a follow-up task.
