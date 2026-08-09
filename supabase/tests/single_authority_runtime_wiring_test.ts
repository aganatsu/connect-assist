import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyAuthorityOwnershipToGateResults } from "../functions/_shared/authorityGateOwnership.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("live and backtest apply the shared gate ownership boundary", async () => {
  const [live, backtest, pending] = await Promise.all([
    read("supabase/functions/bot-scanner/index.ts"),
    read("supabase/functions/backtest-engine/index.ts"),
    read("supabase/functions/zone-confirmation-scanner/index.ts"),
  ]);
  for (const source of [live, backtest]) {
    assertStringIncludes(source, "applyAuthorityOwnershipToGateResults({");
    assertStringIncludes(source, "_canonicalDealingRangeAvailable");
    assertStringIncludes(source, "final decision hierarchy owns authorization");
  }
  for (const source of [live, backtest, pending]) {
    assertStringIncludes(source, "gamePlanEnabled:");
    assert(!source.includes('gamePlanEnabled: config.gamePlanEnabled && !(["enforce", "enforce_live"]'));
  }
  assertStringIncludes(live, 'pairConfig.gpEnforcementMode !== "off" && gpCtx');
  assertStringIncludes(backtest, 'pairConfig.gpEnforcementMode === "off"');
});

Deno.test("canonical location replaces rolling P/D while operational safety remains", () => {
  const results = applyAuthorityOwnershipToGateResults({
    gates: [
      { passed: false, reason: "premium_discount" },
      { passed: false, reason: "tier1_minimum" },
      { passed: false, reason: "structural_conviction" },
      { passed: false, reason: "duplicate_position" },
    ],
    requestedMode: "enforce",
    runtimeTarget: "paper",
    canonicalRangeAvailable: true,
    normalizeCode: (reason) => reason,
  });
  assertEquals(results.map((result) => result.passed), [true, true, true, false]);
});
