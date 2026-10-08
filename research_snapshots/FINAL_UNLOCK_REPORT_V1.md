# Final controlled unlock — report V1 (2026-10-08, NOT executed)

## Approved baseline — scan cadence (correction)
- **cron tick: 5 min** (`bot-scanner-every-5min`); **full scan cadence: 10 min**.
- The scan-interval gate (`entry.scanIntervalMinutes 5`) compares against the previous full scan; each scan finishes a few
  seconds after its tick, so the next tick sees < 5 min elapsed and skips. 144 full scans per pair per day on 10-05, 10-07
  and 10-08 — existing / frozen behaviour, not introduced by Step 17. Not changed. `STEP16_FROZEN_BASELINE_V1.md` §"Full scan
  every 5 min" is superseded by this line.
- Route 2 hunt: every minute (`manage-positions-1min`), the only poller.

## Unlock design (revised)
- The staged design (Stage 1 = unlocked + paused, drain, Stage 2 = unpause) is WITHDRAWN: in the paused-but-unlocked state
  the only DB barrier (entries lock) is off, and `is_paused` is enforced only inside the scanner. Reproduced in PGlite: a
  client manual position, a client real pending order, and the client's own Resume (`is_paused=false` with a dry order still
  active) all succeed in that state.
- Replacement: `UNLOCK_ATOMIC_AT_ZERO_DRY.sql` — ONE transaction from locked dry run to live, allowed only when there are zero
  active dry-run orders, zero real orders/positions, no full scan in progress, frozen config, all safety triggers on, ledger
  enforcing with zero drift. No intermediate state exists, so no drain-state exposure path exists. No schema change.
- Re-lock unchanged: `RELOCK_IMMEDIATE.sql`.

## Unlock prerequisites (review status 2026-10-08)
The one-step unlock is approved in principle. `UNLOCK_ATOMIC_AT_ZERO_DRY.sql` now also refuses, fail-closed, unless D1 and
D2/D3 are applied (checked inside the transaction). Neither migration is applied.

### D1 — legacy exposure RPCs (CONFIRMED in production by the reviewer) → `proposed_migrations/20261009020000_d1_revoke_legacy_exposure_rpcs.sql`
- Scope: `finalize_market_entry`, `finalize_pending_order_fill` (reviewer-confirmed: SECURITY DEFINER, EXECUTE for anon /
  authenticated / service_role) **plus** `finalize_live_broker_position` and `retarget_pending_to_impulse_candidate` — the
  same class: SECURITY DEFINER, no caller check, write paper_positions / pending_orders, never revoked (default EXECUTE).
- Callers: none (repo-wide: only `src/integrations/supabase/types.ts` type declarations). Live paths are
  `route2_place_order` / `route2_claim_and_fill`, already service-role only.
- Change: REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role. Bodies / SECURITY DEFINER untouched;
  `search_path=public` already set on all four (asserted, aborts otherwise). Nothing dropped. No scanner/Route 2 change.
- Backlog (not in D1, not exposure): 26 more SECURITY DEFINER baseline functions with default EXECUTE and no REVOKE in the
  repo (scanner locks, alerts, API credit, strategy registry, telegram claims, broker execution ledger, …). Several are called
  by edge functions with the service key; a separate ACL pass should confirm callers and revoke client EXECUTE.

### D2 — client exposure (CONFIRMED as an integrity gap) → `proposed_migrations/20261009030000_d2_d3_real_exposure_admission.sql`
Writer inventory (traced, repo-wide):

| Table / op | Server (service role) | Client (user JWT) |
|---|---|---|
| paper_positions INSERT | Route 2 fill `route2_claim_and_fill`; legacy market path (off) | **paper-trading `place_order` only** (manual trade) |
| pending_orders INSERT | `route2_place_order` | none |
| pending_orders UPDATE | bot-scanner hunt / cancel action (adminClient), zone-confirmation-scanner, system-reset | none |
| paper_positions UPDATE | scanner management | paper-trading `status` (price refresh), `update_position` (SL/TP), MT5 mirror ids — **legitimate, kept** |
| paper_positions DELETE | settlement | via `settle_paper_position` (SECURITY DEFINER, manual close) — **kept** |
| Browser direct writes | — | none (src/ only reads paper_positions) |

**Revised enforcement (2026-10-08, after review):**
- **pending_orders — privilege revocation (primary).** anon / authenticated keep SELECT only; INSERT, UPDATE, DELETE, TRUNCATE,
  REFERENCES, TRIGGER revoked (the baseline granted all of them; RLS let the owner rewrite any column of an active order).
  Chosen over a trigger-only fix because it covers every column, DELETE and TRUNCATE (which RLS and row triggers cannot), has
  no logic to maintain, and no client writer exists (the UI's "Cancel pending" goes through bot-scanner `cancel_pending` with
  the service-role client).
- **pending_orders — full-row trigger (defence in depth).** `a_real_exposure_admission` now fires BEFORE INSERT OR UPDATE OR
  DELETE and refuses every non-server write, because table privileges do not apply inside a SECURITY DEFINER function — exactly
  how the D1 hole worked. It also carries D3 for real orders entering an active status.
- **paper_positions — unchanged narrow rule.** BEFORE INSERT: client refused (+ D3). No privilege change; client UPDATE
  (status refresh, SL/TP edit, mirror ids) and manual close via `settle_paper_position` preserved.
- "Server" = `auth.role() = 'service_role'` or a DB-admin session (`postgres` / `supabase_admin`).
- Postcheck in the migration: client write privileges on pending_orders all false, client SELECT true, service_role
  SELECT/INSERT/UPDATE/DELETE each true, trigger events exact (pending_orders I+U+D, paper_positions I), client UPDATE and DELETE
  on paper_positions still true; otherwise `D2_ABORTED`.

**Push-back / required companion change:** `place_order` is the only client writer and is intentionally disabled by D2. Today
it ignores the insert error and returns `{success: true}`, so after D2 the app would report a manual trade that does not exist.
Proposed one-line code change, to ship with D2 (paper-trading/index.ts:1576):
`const { error: insErr } = await supabase.from("paper_positions").insert({...}); if (insErr) throw new Error(`Order refused: ${insErr.message}`);`
Manual trading from the app ends — the intended production model.

### D3 — bot-id hole (REPRODUCED) → same migration
- `entries_lock_insert_guard` looks the lock up by (user_id, bot_id); with no such account it reads NULL and passes. PGlite,
  SMC account LOCKED: a server position, a real order, and a client position under bot `ghost` were all created.
- Fix: a real position, or a real order entering an active status, must belong to an existing paper account
  (user_id, COALESCE(bot_id,'smc')). Production: one account (`smc`), zero position/order rows under any other bot id.
- Consequence: historical verify scripts that placed REAL orders under bot `step15_verify` would now be refused (they were
  always rolled back).

### Tests (PGlite; `proposed_tests/d1_d2_d3_atomic_unlock.test-snippet.ts`)
- Existing settlement suite with the revised D2/D3 applied (after mirroring production's pending_orders grants): 73/73 pass.
- Dedicated: 55/55 pass — D1 (before/after ACL, client calls denied, idempotent, precheck abort); D3 reproduced then closed;
  locked dry-run experiment (server dry order, server hunt update of a dry order, route2_place_order as service_role); atomic
  unlock; client manual position refused; client pending_orders INSERT, UPDATE of entry_price / stop_loss / take_profit /
  direction / symbol / size / expires_at / dry_run, status pending↔awaiting_confirmation, active→cancelled, re-activation, and
  DELETE all refused, anon update refused, both active orders byte-identical afterwards; client SELECT of own orders works;
  client write through a SECURITY DEFINER function refused by the row trigger; service_role insert, touch, reset, same-level
  refresh, supersede/cancel, expire, delete all work; route2_place_order and route2_claim_and_fill as service_role work; client
  paper_positions update and manual close work; re-lock; unlock refused without D1, without D2, and if client UPDATE on
  pending_orders is re-granted.
- Harness fidelity notes: clients via SET SESSION AUTHORIZATION (PostgREST session_user is `authenticator`); service_role given
  production grants and BYPASSRLS.

## Original open items (superseded by the section above)
- D1 legacy `finalize_market_entry` / `finalize_pending_order_fill`: SECURITY DEFINER, no caller check, unused by any
  function, still exposed by PostgREST. Check `AUDIT_CLIENT_WRITE_PATHS_READONLY.sql`; if anon/authenticated can execute,
  revoke (security hole independent of unlock).
- D2 Route-2-only exposure: after unlock the account owner can still create real exposure outside the strategy (app manual
  place_order; direct REST insert/update under RLS). Option: real positions/orders and real-order activation only by the
  server role. Disables manual trading — product decision.
- D3 entries lock is keyed by (user, bot): a real position/order under a bot_id with no paper account is not refused.
