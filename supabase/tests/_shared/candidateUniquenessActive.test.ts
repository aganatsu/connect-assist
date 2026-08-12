// Candidate uniqueness must not be reserved by terminal rows.
//
// Step 2 of docs/PENDING_ORDER_PREARMING_PLAN.md, and a prerequisite for
// step 3. The original index spanned every status:
//
//   UNIQUE (user_id, bot_id, candidate_id) WHERE candidate_id IS NOT NULL
//
// It is dormant today — 30 of 1,325 pending_orders rows carry a candidate_id,
// which is why 511 supersede cancel-and-reinsert cycles never tripped it. Once
// step 3 populates identity, a cancelled or expired row would own that
// candidate_id forever and #318's legitimate supersede path would start failing
// with a constraint violation instead of a cancellation — presenting as a #318
// regression rather than a schema problem.
//
// These tests read SQL rather than behaviour, because the regression is someone
// later "simplifying" the predicate back out. Nothing at runtime would fail
// until identity is populated, by which point the cause is far away.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260812050000_candidate_uniqueness_active_only.sql",
    import.meta.url,
  ),
);

const lifecycle = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729160000_watchlist_zone_setup_lifecycle.sql",
    import.meta.url,
  ),
);

Deno.test("the all-status candidate index is dropped, not left alongside", () => {
  assert(
    /DROP INDEX IF EXISTS public\.idx_pending_orders_candidate;/.test(migration),
    "leaving the old index in place would keep terminal rows reserving identity, " +
      "making the new index pointless",
  );
  assert(
    /DROP INDEX IF EXISTS public\.idx_staged_setups_candidate;/.test(migration),
    "staged_setups had no status predicate at all — same problem, same fix",
  );
});

Deno.test("pending order candidate uniqueness is scoped to active statuses", () => {
  const idx = migration.slice(
    migration.indexOf("idx_pending_orders_candidate_active"),
  );
  const stmt = idx.slice(0, idx.indexOf(";"));
  assert(stmt.includes("candidate_id IS NOT NULL"), "historical nulls must stay unconstrained");
  assert(stmt.includes("status IN"), "uniqueness must be scoped by status");
  assert(stmt.includes("'pending'") && stmt.includes("'awaiting_confirmation'"));
});

Deno.test("terminal statuses do NOT reserve a candidate id", () => {
  const idx = migration.slice(
    migration.indexOf("idx_pending_orders_candidate_active"),
  );
  const stmt = idx.slice(0, idx.indexOf(";"));
  for (const terminal of ["'filled'", "'expired'", "'cancelled'", "'invalidated'"]) {
    assertEquals(
      stmt.includes(terminal),
      false,
      `${terminal} is history — including it would block a new active candidate, ` +
        `which is the exact failure this migration exists to prevent`,
    );
  }
});

Deno.test("active means the same thing as the index that already used the term", () => {
  // idx_pending_orders_unique_active established the predicate. Two partial
  // indexes on one table disagreeing about "active" would be a latent trap.
  const existing = lifecycle.slice(
    lifecycle.indexOf("CREATE UNIQUE INDEX idx_pending_orders_unique_active"),
  );
  const existingStmt = existing.slice(0, existing.indexOf(";"));
  const mine = migration.slice(migration.indexOf("idx_pending_orders_candidate_active"));
  const myStmt = mine.slice(0, mine.indexOf(";"));

  for (const status of ["'pending'", "'awaiting_confirmation'"]) {
    assert(existingStmt.includes(status), `precondition: existing index includes ${status}`);
    assert(myStmt.includes(status), `new index must agree on ${status}`);
  }
});

Deno.test("staged_setups uses the four-status active definition already in use", () => {
  // idx_staged_setups_unique_active (20260729160000) defines active as
  // watching / qualified / pending / awaiting_confirmation. A watchlist row and
  // its pre-armed pending record are one candidate, so they must not disagree
  // about when that candidate stops being active.
  const mine = migration.slice(migration.indexOf("idx_staged_setups_candidate_active"));
  const myStmt = mine.slice(0, mine.indexOf(";"));
  for (const status of ["'watching'", "'qualified'", "'pending'", "'awaiting_confirmation'"]) {
    assert(myStmt.includes(status), `staged active set must include ${status}`);
  }
  for (const terminal of ["'filled'", "'expired'", "'promoted'", "'blocked_after_qualification'"]) {
    assertEquals(myStmt.includes(terminal), false, `${terminal} must not reserve identity`);
  }
});

Deno.test("the migration documents why order matters", () => {
  // This lands before identity is populated and is a no-op until then. Someone
  // reading it later needs to know it is a prerequisite, not housekeeping.
  assert(
    migration.includes("PENDING_ORDER_PREARMING_PLAN"),
    "must point at the plan it is a step of",
  );
  assert(
    /BEFORE step 3|before step 3/.test(migration),
    "the ordering constraint is the whole point and must be stated",
  );
});
