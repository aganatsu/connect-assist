-- T13 FALLBACK — role impersonation, for when the anon key is not to hand.
--
-- No DDL, no temp tables, no functions. Six statements, run one at a time.
--
-- WHAT THIS PROVES, AND WHAT IT DOES NOT.
-- PostgREST authenticates a request and then does exactly what the first line
-- of each pair does: it SETs the role carried by the JWT and runs the query. So
-- this exercises the real grant-and-RLS path for `anon` and `authenticated`,
-- which is strictly more than the catalog check — that one asked what is
-- configured, this one asks what happens.
--
-- It is still NOT the HTTP test. It cannot see anything that lives above
-- Postgres: whether the table is in the exposed schema, how PostgREST maps an
-- error to a status code, or what an unauthenticated request actually receives.
-- A table can be correctly locked at the role level and still be visible in the
-- OpenAPI description, and only a real request shows that.
--
-- So: use this now, and still run scripts/ipo_t13_live_rls.sh once the
-- publishable key is available. The two answer different questions.
--
-- EXPECTED RESULT FOR EVERY SELECT BELOW:
--     ERROR: permission denied for table <name>
-- A result set of any kind — including "0 rows" — is a FAILURE, for the same
-- reason the HTTP script treats 200-with-empty-body as a failure: reachable and
-- empty is not the same as unreachable, and the difference only shows up on the
-- day there is something in the table.

-- ── anon ─────────────────────────────────────────────────────────────────────
set role anon;
select count(*) from public.ipo_paper_positions;      -- expect: permission denied
reset role;

set role anon;
select count(*) from public.ipo_paper_trade_history;  -- expect: permission denied
reset role;

set role anon;
select count(*) from public.ipo_execution_events;     -- expect: permission denied
reset role;

-- ── authenticated ────────────────────────────────────────────────────────────
set role authenticated;
select count(*) from public.ipo_paper_positions;      -- expect: permission denied
reset role;

set role authenticated;
select count(*) from public.ipo_paper_trade_history;  -- expect: permission denied
reset role;

set role authenticated;
select count(*) from public.ipo_execution_events;     -- expect: permission denied
reset role;

-- ── a write, because a read-only refusal is only half the guarantee ──────────
set role authenticated;
insert into public.ipo_paper_positions (strategy_id) values ('t13_probe');  -- expect: permission denied
reset role;

-- ── control: the SMC tables must be UNCHANGED by any of this ─────────────────
-- These are expected to be reachable under their own RLS. If one of them has
-- started refusing, D.2 broke something it was not supposed to touch.
set role authenticated;
select 'paper_positions'     as t, count(*) from public.paper_positions
union all select 'pending_orders',      count(*) from public.pending_orders
union all select 'paper_trade_history', count(*) from public.paper_trade_history;
reset role;

-- NOTE on the control: under RLS these counts are filtered by the policy for
-- the current user, and `set role authenticated` sets no JWT claims, so
-- auth.uid() is null and the counts will typically be 0. That is fine — what
-- matters is that the query SUCCEEDS where the IPO tables ERROR. The absolute
-- SMC row counts for the Step 5 before/after come from the service-role
-- baseline already captured by ipo_phase_d_verify.sql
-- (paper_positions 0, paper_trade_history 461, pending_orders 13).
