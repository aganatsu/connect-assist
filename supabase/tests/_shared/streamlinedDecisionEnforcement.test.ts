import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateStreamlinedEnforcement } from "../../functions/_shared/streamlinedDecisionEnforcement.ts";

Deno.test("requested enforcement downgrades without a certificate", () => {
  const result = evaluateStreamlinedEnforcement({ requestedMode: "enforce", runtimeTarget: "paper", style: "day_trader", now: "2026-08-03T12:00:00Z" });
  assertEquals(result.effectiveMode, "observe");
  assertEquals(result.authorized, true);
  assertEquals(result.code, "streamlined_enforcement_not_certified");
});

Deno.test("certified enforcement fails closed on incomplete evidence", () => {
  const result = evaluateStreamlinedEnforcement({
    requestedMode: "enforce", runtimeTarget: "paper", style: "day_trader", now: "2026-08-03T12:00:00Z",
    certificate: { certified: true, expiresAt: "2026-09-03T12:00:00Z", runtimeTargets: ["paper"], styles: ["day_trader"], minimumComparable: 100, comparable: 100 },
    summary: null,
  });
  assertEquals(result.effectiveMode, "enforce");
  assertEquals(result.authorized, false);
  assertEquals(result.code, "streamlined_evidence_unavailable");
});
