import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  "./supabase/migrations/20260729210000_add_style_base_policy_hash.sql",
);

Deno.test("base policy hash migration covers every policy-bearing table", () => {
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
  assertStringIncludes(sql, "style_base_policy_hash TEXT");
});

Deno.test("base policy hash migration updates both population authorities", () => {
  assertStringIncludes(sql, "populate_execution_style_policy");
  assertStringIncludes(sql, "populate_strategy_style_policy");
  assertStringIncludes(sql, "v_policy->>'basePolicyHash'");
  assertStringIncludes(
    sql,
    "Older pair-specific hashes cannot be safely reverse-engineered",
  );
});
