import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729130000_unify_trade_decision_contract.sql",
    import.meta.url,
  ),
);

Deno.test("Phase 3B migration creates versioned Direction Verdict authority", () => {
  assertStringIncludes(
    sql,
    "CREATE TABLE IF NOT EXISTS public.active_direction_verdicts",
  );
  assertStringIncludes(
    sql,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_direction_verdict_one_active",
  );
  assertStringIncludes(
    sql,
    "CREATE OR REPLACE FUNCTION public.activate_direction_verdict",
  );
  assertStringIncludes(sql, "game_plan_version UUID");
});

Deno.test("Phase 3B migration persists the same context on pending orders and positions", () => {
  assertStringIncludes(sql, "ALTER TABLE public.pending_orders");
  assertStringIncludes(sql, "ALTER TABLE public.paper_positions");
  assertStringIncludes(sql, "ADD COLUMN IF NOT EXISTS decision_context JSONB");
  assertStringIncludes(sql, "populate_pending_decision_context");
  assertStringIncludes(sql, "populate_position_decision_context");
  assertStringIncludes(
    sql,
    "NEW.thesis_validation := v_context->'thesisValidity'",
  );
  assertStringIncludes(
    sql,
    "NEW.entry_confirmation := v_context->'entryConfirmation'",
  );
});
