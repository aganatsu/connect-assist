# Step 17-C — atomic reset / exposure serialisation: design and effect report

**Status:** built; PR open for review. **External two-session PostgreSQL proof: PASSED** (2026-10-08; §7b).

**Not done:**
- the migration is **not applied**;
- the PR is **not merged**.

**Unchanged:**
- the account stays $100,000, paused and entries-locked;
- no config, cron, resolver, fill-floor or Route 2 behaviour change.

## 1. The races (verified against the repo)

| # | Race | Evidence | Real? |
|---|---|---|---|
| 1 | position insert vs reset | settlement is pre-epoch (credited **$0**) when `position.created_at < account.ledger_reset_at` (step 15 settle, lines 111–112). `created_at` defaulted to `now()` = the **transaction start**; `ledger_reset_at` = `clock_timestamp()`. Nothing serialised a position insert against a reset | **yes** |
| 2 | **real order creation vs reset** | `route2_place_order` inserts the order via dynamic `INSERT … jsonb_populate_record` (PR 2 migration line 248) and **never touches `paper_accounts`**. The step 8 `entries_lock_insert_guard` only does a plain `SELECT` (no row lock). So: reset locks and counts 0 → a real `pending` order is inserted and commits → the reset commits | **yes**. Fixed here |
| 3 | client bypass | production grants `reset_paper_account` to **`authenticated`** (ledger migration line 773). Any signed-in client can call it over PostgREST and skip every guard | **yes**. Closed here |

**Order paths checked:**
- the only `pending_orders` INSERT is `route2_place_order`;
- in-code status writes move between active states (`awaiting_confirmation` ↔ `pending`) or out of them; none moves a terminal order back into an active state;
- the trigger also covers UPDATE generally.

**Active set:** `pending`, `awaiting_confirmation`, **`triggered`**.
- `triggered` is allowed by `pending_orders_status_check`, and system-reset already treats it as live (`system-reset/index.ts:30` `LIVE_PENDING`). No current writer was found; it is included so the guard is at least as strict as system-reset.
- `reconciliation_required` / `broker_rejected` are not included: they are broker-mirror states with no writer and no paper meaning. **Flagged for review.**

## 2. Lock ordering

There is **one lock: the user's `paper_accounts` row** (`UNIQUE(user_id)`).

| Side | Statement | Mode |
|---|---|---|
| guarded reset (`reset_paper_account_if_flat`) | `SELECT … WHERE user_id = p_user_id FOR UPDATE`, **then** the exposure counts as new statements (new snapshot each, READ COMMITTED), **then** `reset_paper_account` in the same transaction | `FOR UPDATE` |
| every `paper_positions` INSERT (BEFORE trigger) | `SELECT … WHERE user_id = NEW.user_id FOR KEY SHARE`, **then** `created_at := clock_timestamp()` if omitted | `FOR KEY SHARE` |
| every **real** order entering an active status (BEFORE INSERT / UPDATE OF status) | `SELECT … WHERE user_id = NEW.user_id FOR KEY SHARE` | `FOR KEY SHARE` |

**Lock compatibility:**
- `FOR KEY SHARE` × `FOR UPDATE`: **conflict**, so every writer serialises with the reset;
- `FOR KEY SHARE` × `FOR NO KEY UPDATE`: compatible, so the scanner's frequent account heartbeat UPDATEs are not blocked;
- `FOR KEY SHARE` × `FOR KEY SHARE`: compatible, so fills and placements do not block each other.

**Why no ordering escapes:**

| Who takes the lock first | What happens |
|---|---|
| a writer | the reset's `FOR UPDATE` waits until the writer commits (or rolls back). Its exposure query then runs as a new statement, sees the committed position / order, and refuses |
| the reset | the writer's `FOR KEY SHARE` waits until the reset commits. The position's `created_at` is stamped after that, so `created_at > ledger_reset_at` and the close is credited. The order exists only after the reset; it never existed at the check |

**Deadlock review:**
- the reset holds only the account row, and reads (never locks) positions and orders;
- no production path inserts a position / activates an order and then takes the account `FOR UPDATE` in the same transaction (`route2_place_order` and `route2_claim_and_fill` never touch `paper_accounts`; paper-trading's manual order is a separate statement);
- so there is no lock-upgrade cycle. The stress loop asserts this empirically.

Dry-run orders do **not** take the lock: they cannot become positions (DB trigger) or move the balance.

## 3. `created_at`: the PostgreSQL semantics, proven

PGlite (PostgreSQL 16), a BEFORE INSERT spy trigger:

| Column setup | Omitted `created_at` | Explicit `now()` | Explicit historical |
|---|---|---|---|
| `DEFAULT now()` (current production) | `NEW.created_at` = transaction start | `NEW.created_at` = transaction start: **indistinguishable** | kept |
| **no default** | `NEW.created_at` **IS NULL** | the given value | the given value |

Defaults are applied **before** BEFORE triggers run, so with a default the trigger cannot tell "omitted" from an explicit `now()`.

**The design therefore DROPS the column default:**
- an omitted `created_at` arrives NULL and the trigger stamps `clock_timestamp()` **after** taking the lock;
- an explicit value (fixtures, backfills) is kept as given;
- if the trigger were ever missing, `NOT NULL` makes the insert **fail closed**.

**Verified:**
- no production insert path sets `created_at` (bot-scanner, `route2_claim_and_fill`'s position payload, paper-trading's manual order);
- no other BEFORE trigger on `paper_positions` reads `created_at`;
- the earlier triggers (`attach_impulse_entry_lifecycle`, `freeze_*`, `populate_*`, `guard_prezone_*`) were checked function by function.

**Rollback:** `ALTER TABLE paper_positions ALTER COLUMN created_at SET DEFAULT now()` plus drop the trigger.

## 4. Functions and triggers (migration `20261009010000_step17c_atomic_reset.sql`)

1. **`ALTER TABLE public.paper_positions ALTER COLUMN created_at DROP DEFAULT;`**
2. **`paper_positions_serialize_with_reset()`**: SECURITY DEFINER, `search_path = public`.
   - `FOR KEY SHARE` on the user's account row, then `created_at := clock_timestamp()` if NULL.
   - Attached as `BEFORE INSERT ON paper_positions`.
3. **`pending_orders_serialize_with_reset()`**: SECURITY DEFINER, `search_path = public`.
   - When `dry_run IS NOT TRUE` and `status` enters `pending` / `awaiting_confirmation` / `triggered` (INSERT, or UPDATE from a non-active status): `FOR KEY SHARE`.
   - Attached as `BEFORE INSERT OR UPDATE OF status ON pending_orders`.
4. **`reset_paper_account_if_flat(p_user_id, p_bot_id, p_new_balance, p_reason)`**: SECURITY DEFINER, `search_path = public`.
   1. `_paper_ledger_caller_ok(p_user_id)`, else `forbidden` (own account or service role);
   2. lock `FOR UPDATE`;
   3. count positions and active real orders;
   4. on exposure, return `{reset: false, code: "reset_refused_real_exposure", exposure: {openPositions, activeRealOrders, activeDryRunOrders}}`, **with no data change** (the row lock is transaction metadata, not a write);
   5. otherwise, `reset_paper_account(...)` in the same transaction.
5. **`reset_paper_account`: logic unchanged.** Its timestamp (`v_now := clock_timestamp()` in DECLARE) is evaluated before its own lock. That is correct when it runs inside the guarded function, which already holds the lock; and harmless for system-reset (entries locked, and it errs toward crediting). **No change proposed.**

**Why SECURITY DEFINER** (each is genuinely needed):

| Function | Reason |
|---|---|
| guarded reset | must call `reset_paper_account`, which becomes service-role only |
| trigger functions | a row lock requires UPDATE privilege and passes RLS UPDATE policies for the *inserting* role (service role or a signed-in user). The lock must not depend on who inserts |

All three only touch the row of the user being written, and pin `search_path`.

## 5. ACL plan (explicit revoke, then grant)

| Function | PUBLIC | anon | authenticated | service_role |
|---|---|---|---|---|
| `reset_paper_account` | no | no | **no** (revoked) | yes |
| `reset_paper_account_if_flat` | no | no | **yes**, own account only (`forbidden` otherwise) | yes |
| `paper_positions_serialize_with_reset()` | no | no | no | no |
| `pending_orders_serialize_with_reset()` | no | no | no | no |

Trigger functions need no EXECUTE grant to fire. Every function is `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` first, then granted exactly. Tested with `has_function_privilege` for every role × function.

**A client cannot:**
- call the unguarded reset (`permission denied`);
- reset another user's account (`forbidden`);
- bypass the exposure check: the guarded function is the only client reset path, and it refuses with an open position.

## 6. paper-trading

- `resetPaperAccount` (used by `set_balance`, `reset_balance_only`, `reset_account`) now calls **`reset_paper_account_if_flat`**.
- A database refusal maps to the same structured refusal (`code reset_refused_real_exposure`, with the exposure).
- **The 16-D caller-level guard stays as the first layer.** Its active set gained `triggered`, to match.

## 7. Two-session runner (committed)

`supabase/tests/concurrency/step17c/`:

| File | Role |
|---|---|
| `README.md` | how to run on a real PostgreSQL server against a disposable database |
| `build_bootstrap.ts` | builds the schema from the repo's own test-harness setup (the same migrations, incl. 17-C) |
| `two_session_test.py` | the proof |
| `requirements.txt` | psycopg |

**Safety:**
- requires `PG_URI` **and** `S17C_DISPOSABLE_DB=yes`;
- refuses Supabase hosts and the production ref (`rvouzhacxqlbetwcttoe`), before connecting;
- refuses a database whose `public` schema has tables;
- contains no credentials.
- Verified locally: no env / no confirmation / a Supabase direct host / a Supabase pooler host are each refused; a local URI passes the checks.

**Scenarios (each over separate connections; `pg_blocking_pids` recorded):**

| | Scenario |
|---|---|
| A | fill first → reset second |
| B | reset first → fill second |
| C1 | real order first → reset second |
| C2 | reset first → real order second |
| controls | the triggers removed, proving the test detects both bugs |
| D | randomised stress over positions and real orders: no pre-epoch position, no escaped order, no lost P/L, no deadlock |
| E | dry-run only; system-reset; client bypass; another user's account; exposure-check bypass |

**CI guard:** `supabase/tests/_shared/step17cConcurrencyRunner.test.ts` checks that the schema builder still builds and loads, runs the runner's flows sequentially, and pins its safety guards and scenario coverage.

## 7b. External two-session proof — PASSED (2026-10-08)

**Setup:** run by the operator on a separate Mac against **PostgreSQL 16.15**, a disposable database, with the committed runner and `--iterations 60`. This Mac cannot start PostgreSQL (SysV shared memory denied), so the run was external.

**First run:** exposed a **runner fixture bug** in Scenario E, not a defect in the design.
- E sets `entries_locked = true` for the dry-run case, then inserts a REAL position for the exposure-bypass check.
- The step 8 `entries_lock_insert_guard` (BEFORE INSERT on `paper_positions`) correctly refused it: "entries locked".
- **Validated against the code:** nothing in E unlocked the account (the system-reset call does not touch `entries_locked`). Scenarios A–D use freshly created, unlocked accounts and were unaffected.
- **Fix (committed):** unlock the disposable account immediately before the exposure fixture.
- **Regression guards** (`step17cConcurrencyRunner.test.ts`):
  - a source check that the order is lock → unlock → real fixture, with nothing real inserted while locked;
  - a Postgres replay of E's sequence: locked → the guard refuses the real position (the first-run failure); unlocked → it inserts and the guarded reset refuses on exposure.
  - Mutation check: removing the unlock fails the test.

**Second run** (database dropped and recreated). Results as reported by the operator:

| Scenario | Result |
|---|---|
| A: fill first → reset second | PASS |
| B: reset first → fill second | PASS |
| C1: real order first → reset second | PASS |
| C2: reset first → real order second | PASS |
| controls: the old position $0 race and the order-escape race reproduce with the triggers removed | PASS |
| D: 60 randomised races | **violations 0, deadlocks 0, errors 0** |
| E: dry-run-only reset; service-role system-reset; authenticated cannot call the unguarded reset; owner can use the guarded reset; exposure bypass blocked; cross-user reset blocked | PASS |
| **final** | **`=== RESULT: ALL PASS ===`** |

**Transcript:** written on the external machine to `supabase/tests/concurrency/step17c/two_session_transcript.txt`. It is git-ignored by design and **not committed**. It can be added under `docs/step17/` as an artifact if wanted.

**Why the pass is consistent with the design:**
- the runner checks blocking with `pg_blocking_pids` (A, B, C1, C2), and the clock ordering with times taken inside each transaction (B, C2, stress);
- the controls prove the test can detect both bugs: with the triggers removed it reproduces the $0 settlement and the escaped order, so a passing run is meaningful.

## 8. Tests (single-session; the concurrency proof is §7b)

**`paperSettlementLedger.test.ts`** (real Postgres via PGlite, migration applied), 7 × 17-C:
- guarded refusals (real position; real `pending` / `awaiting_confirmation`; real `triggered`) with no data change;
- dry-run only → reset proceeds, the dry-run order is not cancelled;
- `created_at`: default dropped; omitted → stamped after the lock (later than transaction start); explicit historical / explicit `now()` kept;
- a position opened after a guarded reset is credited;
- the order trigger is attached (`BEFORE INSERT OR UPDATE OF status`), excludes dry-run, and real / dry order writes still work;
- the full ACL matrix; SECURITY DEFINER with a fixed `search_path`.

**`step17cConcurrencyRunner.test.ts`** (6): the runner's schema builder, flows, safety and coverage, plus the Scenario E fixture regression (source order + Postgres replay).

**Updated:**
- "a signed-in user cannot … reset another user's account": a client now gets `permission denied` on the unguarded reset, and `forbidden` from the guarded one;
- the 16-D wiring pin expects `reset_paper_account_if_flat` and zero calls to the unguarded reset;
- the 16-D active set includes `triggered`.

**Mutation check** (migration edited, reverted):

| Mutation | Result |
|---|---|
| default kept | 1 fail |
| `triggered` dropped from the guard | 1 fail |
| clients keep the unguarded reset | 2 fail |

**Suites:** Deno **3,468 passed, 0 failed**; `deno check` clean.

## 9. Migration plan (after review and the external proof)

1. **SQL-editor package** (prepared on approval):
   - read-only pre-check: the current `reset_paper_account` ACL includes `authenticated`; neither trigger exists; `created_at` default is `now()`;
   - transactional apply with post-verification (triggers attached, default dropped, ACL matrix exact);
   - rolled-back functional verify;
   - read-only post-check.
2. **Merge** → paper-trading deploys on the guarded call.

**Window:** between the apply and the deploy, the old paper-trading code calls the unguarded reset as `authenticated` and gets `permission denied`. UI resets fail closed for a few minutes. No reset is used while locked; trading is unaffected.

## 10. Live behaviour

**Nothing changes until the migration is applied.** After it:
- position inserts and real-order activations take a brief shared row lock;
- dry-run orders take none;
- `created_at` is stamped after the lock (the same instant within milliseconds, but correctly ordered against any reset);
- UI resets go through the guarded function.

Admission, geometry, sizing, stops, management, caps and Route 2 behaviour are unchanged.
