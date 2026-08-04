import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SingleOwnershipDecisionResult } from "../../functions/_shared/singleOwnershipDecision.ts";
import type { SingleOwnershipEnforcementResult } from "../../functions/_shared/singleOwnershipEnforcement.ts";
import { resolveSingleOwnershipScanOutcome } from "../../functions/_shared/singleOwnershipScanOutcome.ts";

Deno.test("duplicate Zone Story and Confirmation waiting reasons collapse", () => {
  const result = resolveSingleOwnershipScanOutcome({
    enforcement: { effectiveMode: "enforce", requestedMode: "enforce", runtimeTarget: "paper", authorized: false, affectsAuthorization: true, code: "owned_authorities_do_not_allow" } as SingleOwnershipEnforcementResult,
    decision: { decision: "watch", reasonCodes: ["zone_story_waiting", "confirmation_waiting"], completeness: { complete: true, unavailable: [] } } as SingleOwnershipDecisionResult,
  });
  assertEquals(result.disposition, "wait");
  assertEquals(result.reasons, ["Entry Confirmation is not ready"]);
});

Deno.test("Enforce rejection output separates legacy diagnostics from owned reasons", async () => {
  const source = await Deno.readTextFile(new URL("../bot-scanner/index.ts", import.meta.url));
  const start = source.indexOf("const enforcingOwnedAuthorities");
  const end = source.indexOf("// ── Rejected Setup Logging", start);
  const section = source.slice(start, end);
  assertStringIncludes(section, `code === "premium_discount"`);
  assertStringIncludes(section, "legacyGateDiagnostics.push");
  assertStringIncludes(section, "canonicalRejection.explanation");
  assertStringIncludes(section, "...blockingGateReasons");
  assertStringIncludes(section, "...consolidatedAuthorityReasons");
});
