# Step 17-C — two-session PostgreSQL concurrency proof

Proves that the guarded UI reset (`reset_paper_account_if_flat`) serialises with every
real position insert and every real order activation on the user's `paper_accounts`
row, so no ordering lets a reset start a new ledger epoch while real exposure is being
created, and no position opened after a reset settles as pre-epoch `$0`.

**This needs a real PostgreSQL server and a NEW, EMPTY, disposable database.** It cannot
run in the single-connection PGlite harness, and it must never run against production:
the script refuses Supabase hosts, the production project ref, and any database whose
`public` schema already has tables.

## Run

```bash
# 1. a throwaway database on a local / test server you control (PostgreSQL 14+)
createdb s17c_test                        # or: psql -c 'create database s17c_test'
export PG_URI='postgresql://postgres@localhost:5432/s17c_test'
export S17C_DISPOSABLE_DB=yes

# 2. dependencies
python3 -m pip install -r supabase/tests/concurrency/step17c/requirements.txt
# deno must be on PATH (the schema is built from the repo with build_bootstrap.ts), or pass --bootstrap

# 3. run (from the repo root)
python3 supabase/tests/concurrency/step17c/two_session_test.py --iterations 60

# 4. afterwards
dropdb s17c_test
```

The schema is the repo's own test-harness setup (`build_bootstrap.ts` extracts
`baseDb` + `applyMigrations` from `supabase/tests/_shared/paperSettlementLedger.test.ts`;
CI checks it still builds and loads: `step17cConcurrencyRunner.test.ts`).

## What it proves (exit 0 = all PASS; transcript in `two_session_transcript.txt`)

| | Scenario | Must hold |
|---|---|---|
| A | fill first → reset second | reset blocks on the fill (pg_blocking_pids), then refuses; the close is credited in full |
| B | reset first → fill second (fill's transaction began earlier) | fill blocks until the reset commits; `created_at > ledger_reset_at`; close credited, never `$0` |
| C1 | real order first → reset second | reset blocks, then refuses (`activeRealOrders = 1`) |
| C2 | reset first → real order second | the order insert completes only after the reset committed (no escape) |
| controls | triggers removed | both races reproduce (pre-epoch `$0`; an order escaping a successful reset) — the test can detect the bugs |
| D | randomised races (positions and real orders) | no pre-epoch position, no escaped order, no lost P/L, no deadlock |
| E | dry-run only; system-reset; client access | dry-run does not block; service_role still resets; clients cannot call the unguarded reset, cannot bypass the exposure check, cannot reset another user |

The 16-D caller-level guard (paper-trading TypeScript) is covered by the Deno suite.
