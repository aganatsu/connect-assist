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

### The hardening-patch reconciliation — done, and it mattered

You asked me to reconcile this before applying anything. Two findings.

**1. The patch targeted a different migration, and that migration would have
been applied too.**

`docs/patches/ipo_paper_ledger_rls.patch` hardened
`20260921120000_ipo_paper_ledger.sql`, not the Phase D migration. Both are
pending. `supabase db push` has no "apply only this file" mode — it applies
every migration absent from the remote history, in version order. So "apply the
Phase D migration only" is not a thing the tooling can do: the ledger table
would have been created alongside it, **in its un-hardened state** — `ENABLE`
RLS with no `FORCE` and no `REVOKE`. That is a table PostgREST will query and
RLS will answer with an empty array, rather than a table it cannot reach.

**2. The patch did not apply.**

`git apply --check` fails: `error: No valid patches in input`. The file has a
prose preamble and `@@` hunk headers with no line numbers. It had been sitting
there since Phase B described as "staged for whoever runs the paper-environment
phase", and it would have failed at the moment someone tried to use it.

**Resolution:** the four hardening lines are now in
`20260921120000_ipo_paper_ledger.sql` itself, with the reasoning inline. The
patch file is deleted and `docs/patches/` is empty. Two new tests pin this:

- every IPO table in every pending migration must have all four of ENABLE RLS,
  FORCE RLS, REVOKE from anon/authenticated, GRANT to service_role;
- `docs/patches/` must contain no `.patch` file, because security hardening that
  lives in a patch is a promise, not a guarantee.

**Flagged, not acted on:** applying these two migrations creates a *fourth* IPO
table, `ipo_paper_ledger`, which Phase D's three tables supersede. It is still
written by the `ipo-paper-trading` function from Phase pre-D. It is IPO-owned and
isolated, so this is surface area rather than a contamination risk — but if you
would rather retire it, that is a decision to make before the push, not after.

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

## 3. What I need from you

**Option A — you run the live steps.** Everything is ready:

```
# Step 1
gh workflow run apply-migrations.yml --ref feature/ipo-live-integration \
  -f dry_run=true -f expected_versions=20260921120000,20260921140000
#   ...read the plan, confirm the pending set is exactly those two...
gh workflow run apply-migrations.yml --ref feature/ipo-live-integration \
  -f dry_run=false -f expected_versions=20260921120000,20260921140000 -f confirm=APPLY

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
deno test supabase/tests/ supabase/functions/   2739 passed | 0 failed  (5m16s)
vitest run                                        57 passed | 0 failed  (1.9s)
```

Unchanged from D.1 apart from two new tests pinning the RLS posture across all
pending IPO migrations and the absence of unapplied security patches.

## 5. Still not done, and still not authorised

No cron. No LIVE_CANARY. No LIVE. No MetaAPI/OANDA. No Journal merge. No advisor
integration. No SMC config or correlation fix. `#580` open. Migration unapplied,
functions undeployed.
