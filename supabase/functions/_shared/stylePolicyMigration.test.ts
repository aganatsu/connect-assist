import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  "./supabase/migrations/20260729200000_add_style_policy_observability.sql",
);

Deno.test("style policy migration adds nullable evidence to every lifecycle authority", () => {
  for (
    const table of [
      "active_game_plans",
      "active_direction_verdicts",
      "staged_setups",
      "pending_orders",
      "paper_positions",
    ]
  ) {
    assertStringIncludes(sql, `ALTER TABLE public.${table}`);
  }
  assertStringIncludes(sql, "style_policy_version TEXT");
  assertStringIncludes(sql, "style_policy_hash TEXT");
  assertStringIncludes(sql, "style_policy JSONB");
});

Deno.test("style policy migration derives evidence without changing authorization", () => {
  assertStringIncludes(sql, "populate_execution_style_policy");
  assertStringIncludes(sql, "populate_strategy_style_policy");
  assertStringIncludes(
    sql,
    "final_authorization'->'decisionContext'->'stylePolicy",
  );
  assertStringIncludes(sql, "config_snapshot'->'stylePolicy");
  assertStringIncludes(sql, "verdict_json'->'stylePolicy");
  assertStringIncludes(sql, "without a policy snapshot remain NULL");
});
