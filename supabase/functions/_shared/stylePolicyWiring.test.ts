import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const [scanner, fastScanner, manualGamePlan, backtest] = await Promise.all([
  Deno.readTextFile("./supabase/functions/bot-scanner/index.ts"),
  Deno.readTextFile(
    "./supabase/functions/zone-confirmation-scanner/index.ts",
  ),
  Deno.readTextFile("./supabase/functions/game-plan-refresh/index.ts"),
  Deno.readTextFile("./supabase/functions/backtest-engine/index.ts"),
]);

Deno.test("automatic scanner snapshots one global and one pair style policy", () => {
  assertStringIncludes(scanner, "const scanStylePolicy = await");
  assertStringIncludes(scanner, "const pairStylePolicy = await");
  assertStringIncludes(
    scanner,
    "buildGamePlanConfigSnapshot(\n                config,\n                scanStylePolicy,",
  );
  assertStringIncludes(scanner, "stylePolicy: pairStylePolicy");
  assertStringIncludes(
    scanner,
    "style_policy_hash: pairStylePolicy.policyHash",
  );
  assertStringIncludes(scanner, "stylePolicy: scanStylePolicy");
});

Deno.test("all automated fill paths preserve style policy evidence", () => {
  const pairPolicyUses = scanner.match(/stylePolicy: pairStylePolicy/g) || [];
  assert(
    pairPolicyUses.length >= 6,
    `expected style policy on candidate, pending, direct, breaker, verdict and watchlist paths; found ${pairPolicyUses.length}`,
  );
  assertStringIncludes(
    scanner,
    "parsedPendingEvidence?.decisionContext?.stylePolicy",
  );
  assertStringIncludes(
    fastScanner,
    "parsedPendingEvidence?.decisionContext?.stylePolicy",
  );
});

Deno.test("manual Gameplan and backtest expose their observed style policy", () => {
  assertStringIncludes(manualGamePlan, "const stylePolicy = await");
  assertStringIncludes(
    manualGamePlan,
    "buildGamePlanConfigSnapshot(config, stylePolicy)",
  );
  assertStringIncludes(manualGamePlan, "profileAppliedToRuntime: false");
  assertStringIncludes(backtest, "const stylePolicy = await");
  assertStringIncludes(backtest, "stylePolicy,");
});
