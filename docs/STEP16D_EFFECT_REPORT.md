# Step 16-D — real-exposure guard on paper balance resets: effect report

**Status:** built and tested; PR open, **not merged**.

**Unchanged:**
- no migration, config or cron change;
- no change to the fill floor, `MIN_TP_PIPS`, the resolver or the trading path;
- the account stays $100,000, paused and entries-locked.

## Call sites (validated)

| Caller | Path | Reaches |
|---|---|---|
| UI `src/pages/BotView.tsx:164` `resetMut` | `src/lib/api.ts:378` `paperApi.resetAccount()` | paper-trading `reset_account` |
| UI `BotView.tsx:165` `resetBalMut` | `api.ts:379` `paperApi.resetBalanceOnly()` | paper-trading `reset_balance_only` |
| UI `BotView.tsx:167` | `api.ts:380` `paperApi.setBalance(balance)` | paper-trading `set_balance` |

- **The single choke point:** all three call the one helper `resetPaperAccount` → RPC `reset_paper_account`. It is the only `reset_paper_account` call in paper-trading (test-enforced).
- **Not in scope, unchanged:** `system-reset` (`_shared/systemReset.ts` → `system-reset/index.ts:251`), the separate, approved reset workflow. A guard inside the SQL function would break it: it calls `reset_paper_account` *before* clearing active state, by design. So the guard sits in the paper-trading caller.
- `src/lib/api.ts:32` is only the UI's fallback message when the function call fails.

**Client and RLS:**
- paper-trading uses the anon key with the **user's JWT** (index.ts:917).
- RLS lets a user read all of their own rows in both tables: `paper_positions` "Users manage own paper positions" (`auth.uid() = user_id`), and `pending_orders` "Users can view own pending orders".
- The guard filters by the same `user.id`, so it sees exactly the user's exposure.

## Definitions

- **Open real position:** any `paper_positions` row for the user, any status. Every position is real exposure: a DB trigger refuses a position from a dry-run order.
- **Active real order:** `pending_orders.status IN ('pending','awaiting_confirmation')` AND `dry_run IS NOT TRUE`.
  - The status set is the one `idx_pending_orders_unique_active`, the scan (bs:2178) and the hunt (bs:3598) use.
  - **NULL `dry_run` counts as real** (fails safe).
  - The status filter runs server-side; real vs dry-run is classified in code by the same function the real-Postgres test uses.
- **Active dry-run order:** same statuses, `dry_run = true`. **Never blocks**; counted, logged, returned; never cancelled.

## Transaction and refusal behaviour

`resetPaperAccount(amount, reason)` now runs `checkResetAllowed` **first**:

1. **Read** the user's positions and active orders.
   - A read error refuses with `reset_refused_exposure_unknown` (it cannot prove the account is flat).
2. **Any open position or active real order** → `reset_refused_real_exposure`. It returns immediately, **before** the account read, before the `reset_paper_account` RPC, and before the action's follow-up update.
   - **Zero writes:** no ledger entry, no epoch, no balance / peak / daily-base change, no counter or kill-switch reset, no position or order touched.
   - Response: `{ error, refused: true, code, exposure: { openPositions, activeRealOrders, activeDryRunOrders } }`.
3. **Otherwise (flat):** exactly today's path.
   - The same RPC with the same arguments → one reset ledger entry and a new epoch (unchanged SQL).
   - Then the same follow-up updates per action.
   - The success response adds `active_dry_run_orders`, and a log line names any dry-run orders left running.

**`reset_account` no longer deletes `paper_positions`.**
- When flat it deleted nothing, so the line was a no-op on every path the guard allows.
- Removing it makes "never silently delete positions" structural.
- No reset path settles anything; no settlement is invented.

**Known limit:** the check and the RPC are not one database transaction. A real fill landing in the milliseconds between them could slip through.
- While entries are locked, no real fill can happen.
- An atomic version needs a SQL function plus a migration; not proposed.

## The defect (from the audit), now impossible through these actions

`reset_paper_account` starts a new epoch. A position opened before it settles as `pre_epoch_close` with **amount 0**. That is deliberate at the SQL level (existing harness test: CHF/JPY −558.40 recorded, not credited). Before 16-D, any of the three actions could start that epoch with a real position open, and `reset_account` then deleted the position.

**New real-Postgres test** (`paperSettlementLedger.test.ts`), "step 16-D defect":
1. With a real position open, the guarded reset is **refused**. Account snapshot (balance, peak, daily base, epoch, reset time, paused) byte-identical; no ledger entry; position kept.
2. The position then closes **inside the current epoch**: `preEpoch false`, **amount −558.40 credited**, balance 104,979.62 → 104,421.22.
3. Now flat, the same reset proceeds: new epoch, balance $100,000.

## Tests

### `step16AccountResetGuard.test.ts` (new, 12 tests)

- **Definition:** pinned to the unique-active index; terminal statuses ignored; NULL `dry_run` = real.
- **Cases:** flat → allowed; real position → refused; real `pending` and `awaiting_confirmation` order → refused; dry-run only → allowed with the count reported; mixed real + dry-run → refused with both counts.
- **Queries** (recording fake client): positions = `user_id` only; orders = `user_id` + `status in (pending, awaiting_confirmation)`, selecting `status, dry_run`.
- **Fail closed** on either read error.
- **Wiring:**
  - the guard runs first in `resetPaperAccount`, refusing before the account read and the RPC;
  - the only reset RPC in paper-trading;
  - each of the 3 actions refuses before any write;
  - none touches `pending_orders` (no dry-run cancel);
  - no reset path deletes or settles positions;
  - flat-path RPC arguments and follow-up updates unchanged.

### `paperSettlementLedger.test.ts` (+4 real-Postgres tests)

- the defect test above;
- an active real order (`pending`, `awaiting_confirmation`) → refused with zero changes, order untouched;
- dry-run orders only → reset proceeds with a new epoch, dry-run orders still `pending` / `awaiting_confirmation`;
- mixed → refused; a flat account with only terminal orders → reset as today (balance and peak 100,000).

### Updated

`paper-trading/reset.test.ts`: "reset_account: clears open positions, after the ledger reset" is **reversed**. It is now "never deletes positions — refused while any exist", with the reason recorded in the test.

### Mutation check (temporary, reverted)

| Mutation | Result |
|---|---|
| ignore positions | 2 failures (incl. the defect test) |
| count dry-run orders as real | 7 failures |

### Suites

| Suite | Result |
|---|---|
| Deno, CI command | **3,425 passed, 0 failed** |
| `deno check` (paper-trading, guard, tests) | clean |
| frontend | no `src/` change |

## Effect in production

- **Today** the account is flat: 0 positions, 0 active real orders (2 dry-run orders live at 02:55 UTC: 412ca2e7, d2031803). Any of the three actions would therefore **proceed exactly as before**: new epoch, balance set. The only differences are the extra `active_dry_run_orders` field and the log line.
- **No reset runs on merge;** these are user-initiated UI actions.
- **After unlock:** a reset with any real position or active real order is refused instead of losing that P/L.

## Deploy

Merge → `deploy-functions.yml` redeploys the functions. Only paper-trading's behaviour changes, as above. No SQL to apply.
