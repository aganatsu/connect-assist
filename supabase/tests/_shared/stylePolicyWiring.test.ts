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
  assertStringIncludes(scanner, "baseConfig: config");
  assert(
    /buildGamePlanConfigSnapshot\(\s*config,\s*scanStylePolicy,\s*runtimeConfigProvenance,\s*\)/
      .test(
        scanner,
      ),
    "automatic Gameplan must snapshot the resolved scan policy",
  );
  assertStringIncludes(scanner, "stylePolicy: pairStylePolicy");
  assertStringIncludes(
    scanner,
    "style_policy_hash: pairStylePolicy.policyHash",
  );
  assertStringIncludes(
    scanner,
    "style_base_policy_hash: pairStylePolicy.basePolicyHash",
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
    "stylePolicy: pendingPolicyResolution.policy",
  );
  assertStringIncludes(
    fastScanner,
    "stylePolicy: pendingPolicyResolution.policy",
  );
});

Deno.test("manual Gameplan and backtest expose their effective style policy", () => {
  assertStringIncludes(manualGamePlan, "const stylePolicy = await");
  assertStringIncludes(
    manualGamePlan,
    "buildGamePlanConfigSnapshot(",
  );
  assertStringIncludes(manualGamePlan, "const config = styleResolution.config");
  assertStringIncludes(backtest, "const stylePolicy = await");
  assertStringIncludes(backtest, "stylePolicy,");
});

Deno.test("every runtime surface imports a canonical configuration authority", () => {
  for (
    const [surface, source] of [
      ["automatic scanner", scanner],
      ["fast confirmation scanner", fastScanner],
      ["manual Gameplan refresh", manualGamePlan],
    ] as const
  ) {
    assertStringIncludes(
      source,
      'from "../_shared/runtimeConfigStore.ts"',
      `${surface} must use the fail-closed runtime config store`,
    );
  }
  assertStringIncludes(
    backtest,
    'from "../_shared/runtimeConfigResolver.ts"',
    "backtest must use the canonical resolver",
  );
});
