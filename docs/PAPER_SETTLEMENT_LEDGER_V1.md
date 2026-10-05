# Paper settlement ledger V1 — design, tests, deployment

Status: **implemented on branch `fix/settlement-idempotency`. Not committed, not deployed.**
Date: 2026-10-05.

## 1. The defect

A paper close moved money in three separate requests: delete the position,
insert history, then read-modify-write `paper_accounts.balance`. Nothing tied
the balance change to the trade, so anything that ran a close twice credited it
twice.

The proven case, from the 2026-10-05 snapshot:

| | |
|---|---|
| Position | USD/JPY long `0e76555c`, tp_hit at 155.507852, pnl **871.19** |
| close_audit_log `708319c2` | 2026-09-16 18:20:02.533, scan cycle `a3401907` |
| close_audit_log `9590f88a` | 2026-09-16 18:20:03.280, scan cycle `7ca700e6` |
| Credited | 871.19 **twice** |
| History | both inserts failed (decision-contract trigger); row `d582c8b5` backfilled from close_audit_log at 19:10:57 |

#554 made the bot-scanner breach close claim the row with `DELETE … RETURNING`.
It left every other writer as it was:

| Writer | What it did | Double-credit route |
|---|---|---|
| bot-scanner reverse-signal close | delete (no claim) → history → balance | yes |
| paper-trading auto close | history → balance → delete | yes, but **latent**: it only runs when a request sends `processEngine: true` (`paper-trading/index.ts:1007` on main) and nothing in `src/` or cron does; live management is `scannerManagement.ts`. It would race the scanner breach close the moment it is invoked |
| paper-trading manual close | history → balance → delete | yes |
| paper-trading kill switch | history per position → bulk delete → summed balance | yes |
| paper-trading partial TP | CAS claim → history → balance (3 requests) | no double credit, but money and record are not atomic |
| propFirmGate emergency close | delete → history → balance re-summed over **all** open positions | yes, and it credits positions it skipped (FX at weekends) or failed to close; flat `×100,000` P&L is wrong for JPY, metals and crypto |
| paper-trading set_balance / reset_balance_only / reset_account | direct balance write; reset_account **deleted all trade history** | n/a |
| `finalize_paper_position_close` RPC (unused) | atomic, but refused to credit a trade whose history had been backfilled | n/a |

## 2. The design

Migration `20261006010000_paper_settlement_ledger.sql`:

- **`paper_account_ledger`**: append-only. UPDATE, DELETE and TRUNCATE all raise.
  - `UNIQUE (account_id, settlement_key)`. A final close is keyed `close:<bot>:<position_id>`, the same lifecycle identity as `idx_paper_trade_history_final_lifecycle`. A partial is keyed `partial:<bot>:<position_id>:1`, a reset `reset:<epoch>`, an opening `opening:<epoch>`.
  - `CHECK balance_after = balance_before + amount`.
- **`settle_paper_position(row_id, user, bot, history jsonb, source)`**: one transaction.
  1. Lock the account row, then the position row.
  2. If the key is already in the ledger: delete the leftover position, move no money, return `already_settled`.
  3. Write the history row. If a backfilled row already exists for this lifecycle, link it instead and fill its null fields.
  4. Post the ledger entry, then move `balance`/`peak_balance`.
  5. Delete the position.

  If the history insert is refused, it retries once without the decision blobs (the 09-16 failure mode). If that also fails, **nothing commits** and the position stays open for the next cycle.
- **`settle_paper_partial`**: the same for a position's single partial TP. The `partial_tp_fired` compare-and-set, the size reduction, the history row and the credit commit together.
- **`backfill_paper_trade_history`**: service-role only. Writes history; **never** touches the ledger or the balance. A later settlement of that position links the backfilled row and credits once.
- **`reset_paper_account(user, bot, amount, reason)`**:
  - posts a `reset` entry;
  - sets balance, peak and daily baseline;
  - starts a new epoch and sets `ledger_reset_at`.

  A position created before `ledger_reset_at` settles with a **zero-amount** `pre_epoch_close` entry. Its history is kept as evidence, but it cannot move the new balance.
- **Balance guard**: a `BEFORE UPDATE` trigger on `paper_accounts`.
  - A change to balance, peak or epoch that did not come through the ledger functions is recorded in `paper_balance_unledgered_writes` (mode `observe`) or refused (mode `enforce`).
  - The ledger functions set a transaction-local flag that PostgREST clients cannot set.
  - Ships in `observe` (§5).
- **`paper_account_reconciliation`** view, per account:
  - account balance vs ledger balance (`drift`);
  - unledgered writes this epoch;
  - history rows closed this epoch with no settlement;
  - realized P&L this epoch;
  - pre-epoch settlements.
- Every existing account gets an `opening` entry for its **current** balance. For the SMC account that still includes the 871.19 phantom credit. The ledger records what the account said when it was introduced; the clean reset is a separate, approved step.
- `finalize_paper_position_close` keeps its signature and becomes a wrapper over `settle_paper_position`.

Migration `20261006000000_trade_history_timestamps.sql`:

- `paper_trade_history.closed_at` / `open_time`: TEXT → `timestamptz`. The original text is kept verbatim in `closed_at_raw` / `open_time_raw`.
- It **refuses to run** if any value lacks a UTC offset. It re-verifies every row after the conversion and aborts on any mismatch.
- Snapshot check: all 482 rows match. The formats were `…T…Z` (JS) and `… …+00` (Postgres `::TEXT`), and text comparison put the latter before the former on the same day. That is why a `closed_at >= '2026-09-16T…'` filter dropped the backfilled rows.

## 3. Code changes

All in the worktree:

| File | Change |
|---|---|
| `_shared/paperSettlement.ts` (new) | `settlePaperPosition`, `settlePaperPartial`, `interpretSettlement`, `describeSettlementMiss`. Never throws; anything but `settled` means do nothing further. |
| `bot-scanner` breach close | settle; skip audit/broker/notify unless settled |
| `bot-scanner` reverse-signal close | settle |
| `bot-scanner` prop-firm call | passes the instrument-aware `pnlFor` (lot units × quote→USD) |
| `bot-scanner` gates 13–15 | cooldown, loss streak and daily-$ loss read only trades since `ledger_reset_at` (null until the first reset, so no change today) |
| `propFirmGate.propFirmEmergencyClose` | per-position settlement; no aggregate balance write; optional `pnlFor` |
| `paper-trading` partial TP / auto / manual / kill switch | settle |
| `paper-trading` set_balance / reset_balance_only / reset_account | `reset_paper_account`; **reset_account no longer deletes history, reasonings, post-mortems, scan logs or trades** |
| `data-cleanup` | no longer deletes `close_audit_log` (the only independent close evidence; everything before 2026-09-05 was already gone). The 90-day history "archive" step is removed: it upserted 46-column rows into the 18-column `trade_archive`, so it always failed (`trade_archive` has 0 rows), and it would have deleted ledger-referenced history the day it worked. |

## 4. Tests

`supabase/tests/_shared/paperSettlementLedger.test.ts` has 20 tests against real Postgres 16 (PGlite), applied to the production table DDL:

- **The exact USD/JPY failure:**
  - two cycles settle `0e76555c` → credited 871.19 once, one history row, one ledger entry, drift 0;
  - replayed with the **pre-fix 09-16 trigger** and the frozen-decision blob → the trade is still recorded (decision stripped, error reported), the second cycle books nothing, and the close_audit_log backfill returns `exists`.
- A history insert that fails outright rolls everything back; the position stays open, and a retry succeeds.
- A duplicate open row with the same lifecycle identity is removed with no money.
- Backfill before settlement → history only; the settlement links it, fills its gaps and credits once. Backfill after settlement → refused, nothing moves. Backfill is service-role only.
- Partial TP: 16 fires (as `39c5161f` did on 2026-08-07) book once; the final close books the rest.
- Guard:
  - observe mode records the write and shows it as drift;
  - enforce mode refuses balance and peak writes from service code **and** from a signed-in user, while non-money columns stay writable and settlement still works.
- The ledger is append-only.
- Reset:
  - a position opened before it settles for 0, with history kept;
  - a new position credits normally;
  - a position open when the ledger is introduced settles normally;
  - a new account gets its own opening entry.
- Auth: another user cannot settle or reset; the owner can.
- Invalid closes are refused with no side effects; the legacy RPC settles once.
- `closed_at`: all three production formats convert; the date filter that lost `0e76555c` now includes it; chronological order is by instant; microseconds and raw text survive; a value without an offset aborts the migration and leaves the column as TEXT.

Source assertions:

- `closeClaimGuard.test.ts`: no edge function writes `balance`/`peak_balance` or inserts/deletes `paper_trade_history` directly, and every close path settles and checks the outcome.
- `partialTpClaimOrdering`, `route2Provenance`, `closeWritesHistory` and `paper-trading/reset.test.ts` are updated to assert the same guarantees against the new calls.

Full suite: `deno test --no-check … supabase/tests/ supabase/functions/` — see the PR description for the final count. `deno check` is clean on bot-scanner, paper-trading, propFirmGate, paperSettlement and data-cleanup.

## 5. Deployment

Merging to `main` applies migrations (Supabase GitHub integration) **and** deploys functions (`deploy-functions.yml`) at nearly the same time. Both orders are safe:

- **Migrations first:** the old functions keep working. Their direct balance writes are allowed in `observe` and recorded; their ISO-string history inserts parse into `timestamptz`.
- **Functions first:** the RPCs don't exist for a minute, so every settlement returns `failed`, **nothing commits**, and positions stay open until the next cycle. Closes are delayed, never doubled.

Steps:

1. **Before merge:** take a fresh snapshot (`local-runner/recon/snapshot.py`). Pausing the bot (`is_paused = true`) is recommended but not required.
2. **Merge.** Confirm both the migration check and the deploy-functions run are green.
3. **Read-only verification:**
   - `select * from paper_account_reconciliation;` → `drift = 0`;
   - `select count(*) from paper_account_ledger;` → one `opening` row per account;
   - `select data_type from information_schema.columns where table_name='paper_trade_history' and column_name='closed_at';` → `timestamp with time zone`;
   - `select count(*) from paper_trade_history where closed_at_raw is null;` → 0 at deploy time.
4. **Observe for 24h of normal trading.** `paper_balance_unledgered_writes` must stay **empty** and `drift` must stay 0. Any row there names a writer this change missed.
5. **Enforce:** a one-line migration, `update paper_ledger_guard set mode = 'enforce' where id = 1;`. From then on a direct balance write raises.
6. **Then** the approved clean reset (`docs/SMC_RESET_SCOPE_PROPOSAL_V1.md`) runs `reset_paper_account(…, 100000, …)`.

Rollback:

- **Functions:** revert the merge commit; deploy-functions redeploys the old code.
- **Guard:** set mode back to `observe`. The ledger tables and functions are additive and can stay.
- **Timestamps:** `alter table paper_trade_history alter column closed_at type text using coalesce(closed_at_raw, to_char(closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`, and the same for `open_time`. The raw text is still there.

## 6. Known limits

- A role with a direct database connection (postgres) can still set the flag and write the balance. The guard closes the API paths: PostgREST, edge functions and the browser. Note that the `Users manage own paper account` RLS policy lets a signed-in user update their own balance through the API today; in `enforce` mode that write is refused.
- The ledger records the P&L the caller computed. P&L *formula* errors (like the prop-firm `×100,000`) are not detected by the ledger. The prop-firm path now receives the scanner's instrument-aware formula.
- The existing 871.19 phantom is **not** corrected by this migration. It is recorded in the opening balance and disappears at the approved reset.

## 7. Which writers are live (from `docs/SMC_ENGINE_INVENTORY_V1.md`)

On production main, the only close path that actually ran in the last 30 days
is the bot-scanner breach close (77 `scanner_breach_check` rows in
close_audit_log, plus one old `reverse_signal`). Manual close, kill switch and
the resets are user-triggered; the paper-trading auto close is unreachable
without `processEngine: true`; the prop-firm emergency close is inactive
(`prop_firm_config.is_active = false`). All of them are rewired anyway — a
latent double-credit path is still a double-credit path.
