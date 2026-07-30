import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  "./supabase/migrations/20260730233000_add_strategy_evidence_certificates.sql",
);

Deno.test("Phase 8B stores immutable owner-readable evidence certificates", () => {
  assertStringIncludes(
    sql,
    "CREATE TABLE IF NOT EXISTS public.strategy_evidence_certificates",
  );
  assertStringIncludes(sql, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, "auth.uid() = user_id");
  assertStringIncludes(
    sql,
    "Strategy evidence certificate payload is immutable",
  );
});

Deno.test("Phase 8B stores evidence quality and performance measures", () => {
  for (
    const field of [
      "resolved_count",
      "changed_count",
      "coverage_percent",
      "beneficial_rate_percent",
      "expectancy_delta_r",
      "max_drawdown_delta_percent",
      "good_trade_retention_percent",
      "out_of_sample_passed",
      "walk_forward_consistent",
    ]
  ) {
    assertStringIncludes(sql, field);
  }
});

Deno.test("Phase 8B publication is service-only and cannot activate runtime", () => {
  assertStringIncludes(
    sql,
    "REVOKE ALL ON FUNCTION public.publish_strategy_evidence_certificate",
  );
  assertStringIncludes(sql, "TO service_role");
  assertStringIncludes(sql, "'runtimeEnforced', false");
  if (sql.includes("transition_strategy_activation(")) {
    throw new Error("Certificate publication must not transition activation");
  }
});
