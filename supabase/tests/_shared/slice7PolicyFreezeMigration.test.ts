import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729220000_freeze_setup_strategy_context.sql",
    import.meta.url,
  ),
);

Deno.test("Slice 7 installs immutable strategy context on every lifecycle table", () => {
  for (
    const table of [
      "staged_setups",
      "pending_orders",
      "paper_positions",
    ]
  ) {
    assertStringIncludes(migration, `ALTER TABLE public.${table}`);
  }
  for (
    const field of [
      "frozen_strategy_context",
      "frozen_strategy_hash",
      "policy_frozen_at",
    ]
  ) {
    assertStringIncludes(migration, field);
  }
  assertStringIncludes(migration, "freeze_setup_strategy_context()");
  assertStringIncludes(
    migration,
    "frozen strategy context is immutable",
  );
  assertStringIncludes(
    migration,
    "NEW.style_policy := OLD.style_policy",
  );
  assertStringIncludes(
    migration,
    "CREATE TRIGGER zz_freeze_pending_order_strategy_context",
  );
});

Deno.test("Slice 7 propagates origin evidence through Watchlist and pending fill paths", () => {
  assertStringIncludes(
    migration,
    "v_signal->'watchlistLifecycle'->'frozenStrategyContext'",
  );
  assertStringIncludes(migration, "v_row->>'staged_setup_id'");
  assertStringIncludes(migration, "v_row->>'source_pending_order_id'");
  assertStringIncludes(migration, "FROM public.staged_setups AS setup");
  assertStringIncludes(migration, "FROM public.pending_orders AS pending");
});

Deno.test("Slice 7 backfill is truthful and keeps scenario matching observational", () => {
  assertStringIncludes(migration, "'scenario-zone-story.v1'");
  assertStringIncludes(migration, "'observe_only'");
  assertStringIncludes(migration, "'selectedScenarioIndex', NULL");
  assertStringIncludes(migration, "'no_directional_scenario'");
  assertStringIncludes(
    migration,
    "no scenario match was inferred",
  );
});

Deno.test("Slice 7 stores and constrains a deterministic evidence fingerprint", () => {
  assertStringIncludes(
    migration,
    "NEW.frozen_strategy_hash := md5(v_context::TEXT)",
  );
  for (
    const constraint of [
      "staged_frozen_strategy_hash_matches",
      "pending_frozen_strategy_hash_matches",
      "position_frozen_strategy_hash_matches",
    ]
  ) {
    assertStringIncludes(migration, constraint);
  }
});
