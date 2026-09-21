# D.2 — status: git step complete, live steps BLOCKED on access

**Steps 1–5 were not executed. Nothing was applied and nothing was deployed.**

Not by choice, and not for caution's sake: this machine has no mechanism that
can reach the Supabase project, and the one mechanism that exists in CI cannot
express the staging D.2 requires. Details and the two options are below.

---

## 0. What WAS completed

### Git — done and verified

```
commit   e9f12f14  feat(ipo): Phase D paper trading + D.1 persistent engine state
local    e9f12f14850d30dc4d30276e859f31df57abe62a
origin   e9f12f14850d30dc4d30276e859f31df57abe62a    MATCH
tree     clean (0 modified, 0 untracked)
origin/main  74558cd8  unchanged; e9f12f14 is on feature/ipo-live-integration only
```

Not merged. `git branch -r --contains e9f12f14` returns the feature branch and
nothing else.

Phase D and D.1 went in as one commit. They were validated as one tree — the
Phase D worker imports the D.1 state module — so splitting them would have
produced a commit that never existed and never ran green. The message says so.

### The superseded ledger path — RETIRED

The reconciliation you asked for turned into a removal, because the audit found
the path had never become real.

**Audit.** Nothing depends on it:

| | on `origin/main`? | consequence |
|---|---|---|
| `20260921120000_ipo_paper_ledger.sql` | **no** | never applied — there is no migration CI at all, and the file never reached main |
| `supabase/functions/ipo-paper-trading/` | **no** | never deployed — `deploy-functions.yml` fires on push to main |
| `_shared/ipoForwardLedger.ts` | **no** | the row DTO for that table; consumers were the function and its own test, nothing else |

All three were added on this branch by `ddece731`. No cron references IPO. No
frontend file references `ipo_paper_ledger`. `excursions()`, `auditLedger()`,
`toJsonl()` and `summarize()` had no consumer outside the retired function.

**Two findings that made retirement the right call rather than hardening.**

1. **`db push` would have created it anyway.** It is not selective — it applies
   every migration absent from the remote history. "Apply only the Phase D
   migration" was never achievable, so the ledger table would have become
   production schema purely because its file was pending.

2. **The staged hardening patch did not apply.** `git apply --check` fails with
   `No valid patches in input` — prose preamble, `@@` headers with no line
   numbers. It had been described since Phase B as staged for this phase and
   would have failed the moment anyone reached for it.

**Removed:** the migration, the function, `ipoForwardLedger.ts`, both their test
files (11 + 14 tests), and `docs/patches/` entirely.

**Preserved:** the research evidence stands in `docs/IPO_RESEARCH_FREEZE.md`
(16,169 ledger rows over the validation windows, `auditLedger()` returning zero
violations) and the code is recoverable from `ddece731`.
`docs/IPO_FORWARD_TRADING_SPEC.md` §10 — which specified the ledger as the live
contract — is rewritten to point at the three Phase D tables, with the mapping
from the old fields: `noFillReason` is now `reason_codes` on a `REFUSED` event,
and `OPEN`/`NOT_FILLED` no longer exist as exit reasons because an open position
is a row in `ipo_paper_positions` and a non-fill is an event, not a history row
with empty columns. What `auditLedger()` checked in TypeScript the database now
enforces as `ipo_paper_history_outcome_coherent`.

The Phase A and system-integration audits still mention the table. Those are
dated records of what was true when they were written and were left alone.

**Guard added:** a test walks every migration and every function and fails if
`ipo_paper_ledger`, `ipo-paper-trading` or `ipoForwardLedger` reappears.

---

## 1. Why Steps 1–5 could not run

| Mechanism | State |
|---|---|
| `supabase` CLI | not installed |
| `npx supabase` | npm registry returns 503 from this sandbox |
| `psql` | not installed |
| `docker` | not installed |
| `SUPABASE_*` env vars | none |
| `.env` / `~/.supabase/access-token` | none |
| network to `api.supabase.com` | reachable, **401** — no credential |
| network to the project REST API | reachable, **401** — no credential |
| `gh` CLI | installed, authenticated as `aganatsu`, scopes `repo` + `workflow` |

This is by design, and the repo says so. `set-shadow-flag.yml` documents it:

> SUPABASE_ACCESS_TOKEN is write-only from outside CI: GitHub encrypts secret
> values so only the runner can decrypt them. Rather than copying a full account
> credential onto a laptop or into a chat transcript, the flag is flipped where
> the token already lives.

That is the correct posture and it matches your standing instruction never to
expose the service-role key or research token. I did not try to work around it.

### The CI path exists but cannot do what D.2 asks

`.github/workflows/deploy-functions.yml` has `workflow_dispatch`, so I *could*
have dispatched it. I did not, because it would have been the wrong action
wearing the right label. It loops over every directory under
`supabase/functions/` and deploys all 25. Dispatching it on this branch would:

- deploy **`ipo-paper-runner`** — which Step 2 explicitly forbids at that stage;
- redeploy **22 SMC production functions from unmerged feature-branch code** —
  a production change, and you have said production changes: no.

There is also **no migration workflow at all**. Nothing in `.github/` runs
`db push`, `migration up`, or any DDL.

So: Step 1 has no path, and Step 2 has a path that violates its own scope.
Steps 3–5 are gated behind them.

---

## 2. What I built so the steps can run as designed

All four are files on the branch. **None of them has been dispatched or run.**

### `.github/workflows/deploy-function.yml` — deploy only what you name

`workflow_dispatch` with a comma-separated list. Validates every name against
`supabase/functions/<name>/index.ts` and **fails on a typo** rather than
silently deploying nothing. Refuses `_shared`. Prints the resolved list first.
Shares the `deploy-functions` concurrency group so two deploys cannot interleave.
Omits `--no-verify-jwt` for the same reason the bulk workflow does.

This is what makes Step 2 ("deploy only ipo-observation and ipo-paper-state")
and Step 3 ("deploy ipo-paper-runner, do not schedule it") expressible at all.
Deploying a function makes it callable; it does not make it run.

### `.github/workflows/apply-migrations.yml` — `db push` with a plan gate

Because `db push` is not selective, the workflow makes that impossible to
forget:

- `dry_run: true` by default — prints the remote history and the computed
  pending set, changes nothing;
- `expected_versions` must match the computed pending set exactly, or the run
  **fails before touching the database**. A migration you did not know about
  becomes a red CI run instead of a surprise table;
- a real apply additionally requires `confirm` to be the literal `APPLY`.

**Prerequisite:** it needs a `SUPABASE_DB_PASSWORD` repository secret in addition
to the two that already exist. `supabase link` and `db push` both require it. If
that secret is not set, add it before dispatching.

### `supabase/queries/ipo_phase_d_verify.sql` — Step 1's verification

One query, one row per required property, `PASS`/`FAIL`/`INFO`. Catalog-driven
rather than DDL-text-driven: what matters is what Postgres enforces, not what the
file asked for. It covers every item you listed —

table existence · `relrowsecurity` · `relforcerowsecurity` ·
`has_table_privilege` for anon and authenticated across SELECT/INSERT/UPDATE/
DELETE · service_role can read and write · `strategy_id`/`strategy_version`/
`user_id` NOT NULL · the paper-only `execution_mode` CHECK · the gap-abort
coherence CHECK · the `exit_reason`, `event_type` and `status` domains · the
partial unique index for one open position per strategy/symbol · all five named
indexes · the three `intent_id`/`event_id` unique constraints · zero rows in all
three tables

— and records baseline counts for `paper_positions`, `pending_orders` and
`paper_trade_history` so Step 5's before/after has a before.

### `scripts/ipo_t13_live_rls.sh` — the deferred T13

The SQL file asks the catalog what is configured; this asks PostgREST what
actually happens. Those come apart, and the gap is the whole point: a table with
RLS on but grants intact answers a browser with `[]` rather than a refusal, and
`[]` is indistinguishable from "no rows yet" right up until it isn't. **A 200 is
recorded as a FAIL even with an empty body.**

Anon SELECT/INSERT/UPDATE/DELETE against all four IPO tables must be refused;
service_role must still work, or the worker cannot run; the three SMC tables are
probed and recorded unchanged. Keys are read from the environment and never
printed.

---

## 2b. The pending migration set — and a correction

I previously told you the pending set was `20260921120000,20260921140000`. That
was wrong in both directions. The repo state after the retirement is:

**On this branch and NOT on `origin/main` — three files:**

```
20260920100000_ipo_corpus_project_owned.sql
20260920200000_ipo_corpus_tier_and_source_family.sql
20260921140000_ipo_paper_state.sql          <- the only Phase D one
```

**"Not on main" is not the same as "not applied", and I cannot tell which from
here.** The two corpus migrations look already-applied out-of-band: the Phase A
audit records `ipo_corpus_examples` as live with FORCE RLS (which only
20260920100000 sets), and the Ezzy Tier-1 work queried `confidence_tier` and
`source_family` columns that only 20260920200000 adds. If they were pasted into
the SQL editor rather than pushed through the CLI, `supabase_migrations` has no
record of them and `db push` will try them again.

**That is safe.** I checked both for re-runnability:

- `20260920100000` — every statement is `IF EXISTS` / `IF NOT EXISTS`, and the
  one unguarded `ADD CONSTRAINT` is immediately preceded by a matching
  `DROP CONSTRAINT IF EXISTS`.
- `20260920200000` — `ADD COLUMN IF NOT EXISTS`, constraints wrapped in
  `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL $$`, and the three
  `UPDATE`s are value-idempotent.

So whichever way the history reads, re-running them changes nothing. **The
dry-run settles it**, and the `expected_versions` gate refuses to apply if the
plan differs from what you typed — which is exactly the case this gate was built
for.

---

## 3. What I need from you

**Option A — you run the live steps.** Everything is ready:

```
# Step 1 — DRY RUN FIRST. See the pending-set note below: the expected list
# depends on whether the two corpus migrations were applied out-of-band.
gh workflow run apply-migrations.yml --ref feature/ipo-live-integration \
  -f dry_run=true -f expected_versions=20260921140000
#   ...read the printed plan. If it also lists 20260920100000 and
#   20260920200000, re-run the dry run with all three, then apply...
gh workflow run apply-migrations.yml --ref feature/ipo-live-integration \
  -f dry_run=false -f expected_versions=<the set the dry run printed> -f confirm=APPLY

# then, in the SQL editor
supabase/queries/ipo_phase_d_verify.sql        # expect zero FAIL rows
SUPABASE_URL=... SUPABASE_ANON_KEY=... ./scripts/ipo_t13_live_rls.sh

# Step 2 — read-only surface only
gh workflow run deploy-function.yml --ref feature/ipo-live-integration \
  -f functions=ipo-observation,ipo-paper-state

# Step 3 — only after 1 and 2 are green
gh workflow run deploy-function.yml --ref feature/ipo-live-integration \
  -f functions=ipo-paper-runner
```

Paste me the verification output and the first two `ipo-paper-runner` responses
(they carry `bootstrapped`, `rebuildReason`, `barsProcessed`, `barsFetched`,
`statePayloadBytes`, `restoreMs`, `processMs`, `persistMs`) and I will complete
Steps 3–5 analysis, including the D.1 warm-vs-cold confirmation and the Step 5
contamination proof.

**Option B — you authorise me to dispatch.** I have `gh` with `workflow` scope,
so I can dispatch these myself. I have not, because Step 1 is production DDL and
because the ledger-table finding above is a decision you should see first. Say
the word and I will run Step 1 dry-run → verify → apply → Steps 2 and 3, stopping
at each gate.

Either way I still cannot run the SQL verification or T13 myself — both need
database or API credentials that deliberately do not exist outside CI. If you
want those automated too, the honest options are a fourth narrow workflow that
runs the verification SQL and uploads the result as a CI artifact, or you run
them and paste the output.

---

## 4. Test state

```
deno test supabase/tests/ supabase/functions/   2715 passed | 0 failed  (3m34s)
vitest run                                        57 passed | 0 failed  (2.2s)
deno check                                        clean on every function and IPO module
```

2739 → 2715 is exactly the retirement: −11 `ipoPaperTrading` tests, −14
`ipoForwardLedger` tests, +1 guard against the path reappearing. The shadow /
import guard and the advisor-isolation suite were run again on their own and
pass.

Unchanged from D.1 apart from two new tests pinning the RLS posture across all
pending IPO migrations and the absence of unapplied security patches.

## 5. Still not done, and still not authorised

No cron. No LIVE_CANARY. No LIVE. No MetaAPI/OANDA. No Journal merge. No advisor
integration. No SMC config or correlation fix. `#580` open. Migration unapplied,
functions undeployed.
