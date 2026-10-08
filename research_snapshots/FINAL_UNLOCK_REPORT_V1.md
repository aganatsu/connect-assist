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

Enforcement (row trigger `a_real_exposure_admission`, no table-privilege change, so no UI update/close flow breaks):
- paper_positions INSERT → server only;
- pending_orders INSERT → server only (dry-run too: a client dry-run order could hold a symbol+direction);
- pending_orders status entering pending / awaiting_confirmation / triggered from a non-active status → server only.
"Server" = `auth.role() = 'service_role'` or a DB-admin session (`postgres` / `supabase_admin`), the predicate already used by
`_paper_ledger_caller_ok` and the entries-lock guard.

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
- Existing settlement suite with D2/D3 applied: 73/73 pass (incl. client settle/reset authorisation, Route 2 placement and fill).
- Dedicated: 25/25 pass — D1 before/after ACL, client calls denied, idempotent, precheck abort; D3 reproduced then closed;
  dry-run experiment (server dry order + route2_place_order) while locked; atomic unlock with D1+D2; client manual position /
  real order / dry order / re-activation refused; server real order, route2_place_order, route2_claim_and_fill fill work;
  client position update and manual close still work; re-lock; unlock refused without D1 / without D2.

## Original open items (superseded by the section above)
- D1 legacy `finalize_market_entry` / `finalize_pending_order_fill`: SECURITY DEFINER, no caller check, unused by any
  function, still exposed by PostgREST. Check `AUDIT_CLIENT_WRITE_PATHS_READONLY.sql`; if anon/authenticated can execute,
  revoke (security hole independent of unlock).
- D2 Route-2-only exposure: after unlock the account owner can still create real exposure outside the strategy (app manual
  place_order; direct REST insert/update under RLS). Option: real positions/orders and real-order activation only by the
  server role. Disables manual trading — product decision.
- D3 entries lock is keyed by (user, bot): a real position/order under a bot_id with no paper account is not refused.
