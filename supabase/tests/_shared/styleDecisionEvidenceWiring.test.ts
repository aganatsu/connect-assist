import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const [scanner, backtest, refresh, gamePlan, thesis, conviction, confirmation] =
  await Promise.all([
    Deno.readTextFile("./supabase/functions/bot-scanner/index.ts"),
    Deno.readTextFile("./supabase/functions/backtest-engine/index.ts"),
    Deno.readTextFile("./supabase/functions/game-plan-refresh/index.ts"),
    Deno.readTextFile("./supabase/functions/_shared/gamePlan.ts"),
    Deno.readTextFile("./supabase/functions/_shared/thesisValidator.ts"),
    Deno.readTextFile("./supabase/functions/_shared/thesisConviction.ts"),
    Deno.readTextFile(
      "./supabase/functions/zone-confirmation-scanner/index.ts",
    ),
  ]);

Deno.test("Gameplan uses style-authoritative bias and structure evidence", () => {
  assertStringIncludes(
    gamePlan,
    "options?.decisionEvidence?.layers.bias.trend",
  );
  assertStringIncludes(
    gamePlan,
    "options?.decisionEvidence?.layers.structure.trend",
  );
  assertStringIncludes(refresh, "buildStyleDecisionEvidence(");
  assertStringIncludes(scanner, "decisionEvidence,");
  assertStringIncludes(backtest, "{ decisionEvidence: gpDecisionEvidence }");
});

Deno.test("Direction Verdict, thesis and conviction share one pair evidence snapshot", () => {
  assertStringIncludes(
    scanner,
    "decisionEvidence: pairDecisionEvidence",
  );
  assertStringIncludes(
    scanner,
    "structureContext: pairDecisionEvidence.structureRegime",
  );
  assertStringIncludes(
    scanner,
    "pairDecisionEvidence.labels.structure",
  );
  // The thesis validator no longer reads simpleDirection to decide direction —
  // that was the absolute comparison against the order direction, replaced by
  // the frozen-verdict comparison. It still consumes the SAME shared evidence
  // snapshot for provenance, which is what this test exists to protect.
  assertStringIncludes(
    thesis,
    "opts.decisionEvidence?.labels",
  );
  assertStringIncludes(
    thesis,
    "compareDirectionVerdicts(",
  );
  assertStringIncludes(
    conviction,
    "const structureContext = input.structureContext",
  );
});

Deno.test("live, backtest, manual refresh and fast confirmation build the same evidence contract", () => {
  for (
    const [surface, source] of [
      ["live", scanner],
      ["backtest", backtest],
      ["manual refresh", refresh],
      ["fast confirmation", confirmation],
    ] as const
  ) {
    assertStringIncludes(
      source,
      "buildStyleDecisionEvidence(",
      `${surface} must build the shared evidence contract`,
    );
    assertStringIncludes(
      source,
      "timeframeAuthority",
      `${surface} must resolve authoritative roles`,
    );
  }
  assert(
    !scanner.includes("entry candles are 5m, but we use hourly"),
    "Scalper structural conviction must not fall back to the old 1H proxy",
  );
});
