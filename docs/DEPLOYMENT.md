# Deploying connect-assist

## The rule

**Merging application/function code does NOT apply Supabase migrations.**
Any release that depends on new database objects (tables, columns, functions,
triggers, views) must have its migrations **applied and verified in
production BEFORE the dependent functions go live** — i.e. before the PR is
merged.

## Why

- `deploy-functions.yml` deploys every Edge Function to production about a
  minute after a merge to `main`.
- Nothing applies migrations on merge:
  - the Supabase GitHub integration ("Supabase Preview") fails on every
    merge with *"Remote migration versions not found in local migrations
    directory"* — production `schema_migrations` holds apply-time versions
    (e.g. `20260930164510`) that are not file names in the repo;
  - `apply-migrations.yml` and `apply-one-migration.yml` get **HTTP 403**
    from the Management API with the CI token.
- So a merged function that calls a new RPC runs against a database that
  does not have it.

Incident, 2026-10-05: PR #627 (settlement ledger) was merged on the
assumption the integration would apply its two migrations. Functions went
live at 17:04 UTC; `settle_paper_position` did not exist, so every paper
close failed (safely — nothing committed, nothing double-credited — but no
stop or target could be booked) until the migrations were applied by hand.
#624 had gone out correctly on 2026-09-30: migrations applied by hand at
16:45, functions after at 16:49.

## Release order for a PR with a migration

1. **CI green** on the PR (deno, frontend).
2. **Rehearse** the migration against production DDL + real snapshot rows
   (PGlite; see `supabase/tests/_shared/paperSettlementLedger.test.ts` for
   the harness). A migration that guards data (e.g. refuses to convert an
   unparseable value) must be run against the real rows, not fixtures.
3. **Pause new entries** if the change touches trading paths:
   `paper_accounts.is_paused = true` stops full scans from staging or
   placing trades; the 1-minute `manage` cron (closes, trailing) keeps
   running. Note `zone-confirmation-scanner` does not read `is_paused`, so an
   already-armed pending order can still fill.
4. **Apply the migrations by hand** in the SQL editor
   (`https://supabase.com/dashboard/project/rvouzhacxqlbetwcttoe/sql/new`),
   all files in version order inside ONE `begin; … commit;`, followed by
   ```sql
   insert into supabase_migrations.schema_migrations (version, name)
   values ('<14-digit>', '<file name without .sql>'), …
   on conflict (version) do nothing;
   notify pgrst, 'reload schema';
   ```
   so the repo's file versions are recorded and PostgREST sees the new
   objects immediately.
5. **Verify read-only** that PostgREST exposes the new objects
   (`GET /rest/v1/` OpenAPI: the table/view in `definitions`, the function
   under `/rpc/…`) and run the PR's own verification queries.
6. **Only then merge.** Confirm the `deploy-functions.yml` run for the merge
   commit is green.
7. **Unpause** and watch the first live cycle that exercises the new path.

A migration-only change with no dependent code can be applied at any time;
a function-only change needs no migration step. If a dependent function is
ever live before its migration, apply the migration (step 4) — do not
"repair" individual objects piecemeal.

## Verifying what is live

Do not infer deploy state from merges. Check the deploy-functions run for the
merge commit, the `schema_migrations` rows, and the object itself through
PostgREST. The repo squash-merges, so compare by file content, not SHA.
