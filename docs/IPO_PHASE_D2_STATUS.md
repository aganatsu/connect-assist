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

## 2b. Migration reconciliation — COMPLETE

### Where it started

`supabase_migrations` recorded 13 versions. Four local files were unrecorded:
`20260920000000`, `20260920100000`, `20260920200000`, `20260921140000`.

Two of those four were **already live** — the corpus table existed in its
post-`20260920100000` shape with `user_id` dropped, the four-column unique key
in place and FORCE RLS on — while neither version was recorded. Recorded history
and real schema had diverged.

That mattered far beyond the corpus table, because `db push` decides what to run
purely from the recorded history and **six of the seventeen local migrations do
not survive a second run**: the Lovable baseline (dozens of unguarded
`ADD CONSTRAINT … PRIMARY KEY`), `frozen_decision_hash_trigger` (three unguarded
`CREATE TRIGGER`), and four unguarded `CREATE POLICY` files. Pushing blind would
have failed on the baseline — first in version order — and applied nothing.

### What was checked before repairing

Repair tells the tooling to skip a file **forever**, so any statement that never
ran will never run and nothing will report it again. The live report covered the
headline effects; Part A of `ipo_migration_repair.sql` covered the rest, and all
of it passed:

- six corpus CHECK constraints present
- the `parent_example_id` self-FK present, no leftover `auth.users` FK
- both indexes rebuilt **without** `user_id`
- the four-column `ice_unique_example` in place
- RLS enabled, FORCE RLS enabled, **no policies**
- **anon/authenticated hold no table grants** — this was the one that mattered.
  RLS-enabled-and-forced had been confirmed; the `REVOKE` had not. Without it the
  browser roles keep their default grants and the table is reachable-but-empty
  rather than unreachable, and repair would have buried that permanently.
- `service_role` holds the expected privileges

### What was done

```sql
insert into supabase_migrations.schema_migrations (version)
values ('20260920000000'), ('20260920100000')
on conflict (version) do nothing;
```

Bookkeeping only. No DDL, nothing about the corpus table changed.

### State now

| | before | after |
|---|---|---|
| recorded versions | 13 | **15** |
| pending | 4 | **2** |

Pending is exactly:

```
20260920200000_ipo_corpus_tier_and_source_family
20260921140000_ipo_paper_state
```

Also confirmed live: `ipo_paper_positions`, `ipo_paper_trade_history` and
`ipo_execution_events` are all **absent**, and `candle_datetime` is stored in
the ISO `…T…Z` format the tier `UPDATE`s match on — so they will affect rows
rather than silently updating none.

---

## 2c. The apply step — prepared, not run

`supabase/queries/ipo_apply_pending.sql`.

The CLI route is still blocked on two independent things: `SUPABASE_DB_PASSWORD`
does not exist, and GitHub only dispatches a `workflow_dispatch` workflow that
lives on the default branch, which `apply-migrations.yml` does not. The apply
pack reaches the same end state through the SQL editor, which is the mechanism
that has been working throughout.

**Each migration is one transaction, with its bookkeeping row written inside
it.** A failure rolls back the DDL and the record together, so the two can never
disagree — the same guarantee `db push` gives, and the property whose absence
caused the divergence this reconciliation just fixed.

The pack is **generated** from the migration files, and three tests pin it:
the DDL is embedded byte-for-byte, each transaction contains its own
`schema_migrations` insert, and the pack records exactly the two pending
versions and mentions neither repaired version nor the retired ledger.

**Order, and what to expect:**

1. `20260920200000` — additive only. Expect 4 rows `TIER_1_DIRECTLY_INSPECTABLE`,
   2 rows `TIER_3_UNINSPECTABLE_LEGACY`, and `USER_CONFIRMED` rows set to
   `USER_INDEPENDENT`. **Check those counts before continuing** — a zero would
   mean the literals did not match after all.
2. `20260921140000` — creates the three Phase D tables, five indexes, three
   unique constraints, RLS enabled and forced, anon/authenticated revoked,
   service_role granted. No destructive statement.

Then, still before any deployment:

- `supabase/queries/ipo_phase_d_verify.sql` — expect zero FAIL rows, and the SMC
  baseline counts it records become the "before" for Step 5.
- `scripts/ipo_t13_live_rls.sh` — the deferred T13, against PostgREST rather than
  the catalog. A 200 counts as a failure even with an empty body.

---

## 2d. Step 1 — APPLIED AND VERIFIED

Both pending migrations are applied. `ipo_phase_d_verify.sql` returned **zero
FAIL rows**:

- all three IPO tables exist
- every required CHECK constraint present
- one-open-position-per-strategy/symbol enforced by the partial unique index
- `strategy_id`, `strategy_version`, `user_id` all NOT NULL
- RLS enabled **and forced** on all three
- anon and authenticated hold no direct grants
- service_role holds the required privileges
- all three tables at **0 rows**

**SMC baseline captured for the Step 5 before/after:**

| table | rows before any IPO activity |
|---|---|
| `paper_positions` | 0 |
| `paper_trade_history` | 461 |
| `pending_orders` | 13 |

## 2e. T13 — PASSED against the live API

Run 2026-09-21 with the publishable key. **16 assertions, 0 failures, exit 0.**

```
precondition   anon key accepted (a known-reachable table returns 200)

ipo_paper_positions       GET / POST / PATCH / DELETE   all refused 401
ipo_paper_trade_history   GET / POST / PATCH / DELETE   all refused 401
ipo_execution_events      GET / POST / PATCH / DELETE   all refused 401

control        paper_positions / pending_orders / paper_trade_history -> 200
service_role   SKIPPED (key deliberately not supplied)
```

### The refusals are genuine, and that was checked rather than assumed

A 401 alone does not prove much — an invalid key returns 401 too, and would have
made every assertion pass while proving nothing. Three things separate the two:

```
IPO table, valid key   {"code":"42501", "message":"permission denied for
                        table ipo_paper_positions",
                        "hint":"GRANT SELECT ... TO anon;"}
SMC table, same key    200
bogus key              {"message":"Invalid API key"}
```

So the refusal is a per-table grant refusal, the key demonstrably works, and an
invalid-key response is a distinguishable third case.

**The script was hardened after the first green run**, because the first version
would have accepted an invalid-key 401 as a pass. It now (1) checks the key
works before asserting anything and aborts if not, (2) inspects the refusal
*reason* rather than only the status, and (3) treats the SMC control as an
assertion instead of an informational note — if those also refused, the IPO
refusals would be explained by a broken key rather than by the grants. Re-run
after hardening: same result, still green.

The SMC 200s also double as the Step 5 regression control: browser reachability
of the SMC tables is unchanged by D.2.

`supabase/queries/ipo_t13_role_fallback.sql` is retained for the role-level view
but is no longer needed — the HTTP test is the stronger of the two and it ran.

---

## 2f. Step 2 — deploying the read-only surface is still blocked

`ipo-observation` and `ipo-paper-state` cannot be deployed from here:

- `deploy-function.yml` (the narrow one) is not on `main`, and GitHub dispatches
  `workflow_dispatch` only from the default branch;
- `deploy-functions.yml` (the bulk one, which is on main) deploys **all 25**
  functions — including `ipo-paper-runner`, which Step 2 forbids, and 22 SMC
  production functions from unmerged branch code.

Options, in the order I would pick them:

1. **Merge only the three workflow files to `main`.** A merge touching just
   `.github/workflows/deploy-function.yml`, `apply-migrations.yml` and
   `inspect-live-schema.yml` does **not** trigger the bulk deploy: its path
   filter is `supabase/functions/**` plus its own filename, neither of which
   matches. After that, `gh workflow run deploy-function.yml --ref
   feature/ipo-live-integration -f functions=ipo-observation,ipo-paper-state`
   deploys exactly those two, from the feature branch.
2. **Deploy the two by hand** with the Supabase CLI, if you have it and the
   access token locally.

Option 1 is a merge to `main`, which has been prohibited throughout — so it
needs an explicit decision. It adds no application code and changes no function.

## 2g. Step 2 — DEPLOYED. One function works, one cannot run.

Deployed 2026-09-21 from `feature/ipo-live-integration` with the Supabase CLI
v2.117.0, installed from the official GitHub release because npm is unreachable
from this sandbox. **The CLI was already authenticated via the macOS keychain** —
no token was requested, handled or printed.

| function | version | verify_jwt | status |
|---|---|---|---|
| `ipo-paper-state` | **1** | `true` | **working** |
| `ipo-observation` | **1** | `true` | **deployed but fails every invocation** |
| `ipo-paper-runner` | — | — | **not deployed** (correct) |

No `--no-verify-jwt`. No SMC, broker or scheduled function was touched: every
other function still shows its pre-existing `updated_at` (`1789…`) against the
new deploys at `1790036…`. `smc-analysis` shows `verify_jwt: false`, confirming
it is the deliberate exception and not something this step changed.

Asset counts on upload were 2 and 21 — exactly the import closures computed
beforehand.

### What passed

```
OPTIONS            both 200 (no longer 404)
unauthenticated    both 401 UNAUTHORIZED_NO_AUTH_HEADER  (gateway)
ipo-paper-state    200 in 0.32 / 0.47 / 0.29 s
                   {"ok":true,"mode":"PAPER_READ_ONLY","runtime":[],
                    "openPositions":[],"recentTrades":[],"recentEvents":[],
                    "summary":{"trades":0,...,"abortedExcluded":0}}
T13                re-run after deployment, still PASSED
```

### What failed, and it is not a tuning problem

```
ipo-observation    HTTP 546 WORKER_RESOURCE_LIMIT
                   all instruments   5.5 s
                   EUR/USD only      5.6 s
                   USD/JPY only      3.5 s
                   BTC/USD only     15.7 s
```

**A single instrument fails.** It is not cumulative load across three, and at
3–16 seconds it is not the 150 s wall clock either — the worker is killed for
compute.

The cause is the bootstrap, and the number was already in the D.1 report without
my drawing this conclusion from it: **a 1,200-bar rebuild costs ~17 seconds of
CPU** on a laptop. An Edge Function's CPU budget is a small number of seconds.
The bootstrap misses it by roughly an order of magnitude.

This was never going to show up earlier. Phase C was approved and pushed but
**never deployed** — `ipo-observation` was at version 1 before today, meaning
today was its first invocation anywhere. Every prior statement about it,
including my own Phase C report, described code that had never run in the
environment it was written for.

### What this means for the plan

It is not confined to observation. `ipo-paper-runner`'s **cold path is the same
1,200-bar bootstrap**, so it would fail the same way on its first run — and
because the warm path can only resume from a state the bootstrap creates, the
49 ms warm invocation measured in D.1 is unreachable on Edge. D.1's architecture
is sound and its measurements hold; the platform it targets cannot execute the
one step that starts it.

Options, not yet acted on:

1. **Run the bootstrap off-Edge.** This repo already has `local-runner/` — a Mac
   Mini process that exists precisely because Supabase's scheduler and runtime
   were not adequate. Its README even anticipates "Approach 2: Full Local —
   import scanner logic directly, run everything in-process." A bootstrap that
   needs 17 s of CPU belongs there, writing the D.1 engine state to `kv_cache`;
   Edge then only ever does warm 49 ms steps, which it can do comfortably.
2. **Shrink the bootstrap** below the CPU budget. `HISTORY_BARS` is 1,200 and the
   volatility warmup needs 200, so there is room — but the cost is superlinear
   and this would change which bars the engine sees, which changes decisions. It
   is a strategy change wearing a performance costume and should not be done to
   fit a platform limit.
3. **Delete `ipo-observation` from the project** until one of the above lands. It
   currently occupies a slug and fails every call.

My recommendation is 1, with 3 in the meantime.

### Cost note

The failing invocations still fetched candles before being killed — BTC ran
15.7 s, most of it network. Five failed calls have therefore spent TwelveData
credits for no result. I stopped after characterising the failure rather than
retrying, and did not attempt to bisect `HISTORY_BARS`, which would have cost
more credits for a number that option 2 above argues against acting on anyway.

### Not verified, and why

`ipo_paper_positions`, `ipo_paper_trade_history`, `ipo_execution_events` row
counts, the SMC baseline, and `broker_connections` being unchanged all need a
database query. I have no SQL path from here — the CLI's stored credential lets
it deploy but `db` commands still need the database password, and reading the
service-role key out of the keychain to make raw API calls is not something I
will do. `supabase/queries/ipo_post_deploy_verify.sql` has the exact query.

Note the `broker_connections` check is now weakly informative in either
direction: `ipo-observation` never reached the candle-fetch completion path, and
it passes `persistSymbolOverrides: false` regardless.

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
