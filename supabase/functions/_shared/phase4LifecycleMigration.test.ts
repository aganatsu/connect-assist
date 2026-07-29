import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729160000_watchlist_zone_setup_lifecycle.sql",
    import.meta.url,
  ),
);

Deno.test("Phase 4 migration installs the canonical lifecycle states", () => {
  for (
    const status of [
      "watching",
      "qualified",
      "pending",
      "awaiting_confirmation",
      "filled",
      "blocked_after_qualification",
      "invalidated",
      "expired",
      "cancelled",
    ]
  ) {
    assertStringIncludes(migration, `'${status}'`);
  }
  assertStringIncludes(migration, "transition_staged_setup");
  assertStringIncludes(migration, "setup_lifecycle_events");
  assertStringIncludes(migration, "audit_staged_setup_transition");
});

Deno.test("Phase 4 migration preserves one active order across confirmation states", () => {
  assertStringIncludes(
    migration,
    "WHERE status IN ('pending', 'awaiting_confirmation')",
  );
  assertStringIncludes(migration, "idx_pending_orders_unique_active");
  assertStringIncludes(migration, "idx_staged_setups_unique_active");
});

Deno.test("Phase 4 migration attaches durable evidence to every stage", () => {
  for (
    const field of [
      "candidate_id",
      "game_plan_id",
      "game_plan_version",
      "direction_verdict_id",
      "thesis_version",
      "originating_zone",
      "confirmation_method",
      "authorization_result",
      "staged_setup_id",
    ]
  ) {
    assertStringIncludes(migration, field);
  }
  assertStringIncludes(migration, "sync_staged_setup_from_pending");
  assertStringIncludes(migration, "sync_staged_setup_from_position");
});

Deno.test("Phase 4 migration rejects untraceable new Watchlist orders", () => {
  assertStringIncludes(migration, "pending_watchlist_identity_required");
  assertStringIncludes(migration, "NOT from_watchlist");
  assertStringIncludes(migration, "staged_setup_id IS NOT NULL");
  assertStringIncludes(migration, "candidate_id IS NOT NULL");
});
