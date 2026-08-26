import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const confirmation = await Deno.readTextFile(
  "./supabase/functions/zone-confirmation-scanner/index.ts",
);
const backtest = await Deno.readTextFile(
  "./supabase/functions/backtest-engine/index.ts",
);

Deno.test("both live pending monitors wire the shared frozen-verdict comparison", () => {
  for (const [surface, source] of [
    ["five-minute pending monitor", scanner],
    ["one-minute confirmation monitor", confirmation],
  ] as const) {
    assertStringIncludes(
      source,
      "buildDirectionVerdictThesisOptions({",
      `${surface} must adapt persisted verdict evidence through the shared thesis owner`,
    );
    assertStringIncludes(
      source,
      "...directionVerdictThesisOptions",
      `${surface} must pass the shared frozen/current verdict comparison into thesis validation`,
    );
  }
});

Deno.test("backtest freezes and evaluates the same verdict comparison while a setup waits", () => {
  assertStringIncludes(
    backtest,
    "frozenLifecycleExecution?.directionVerdict || null",
  );
  assertStringIncludes(backtest, "...directionVerdictThesisOptions");
  assertStringIncludes(backtest, "cancelBacktestTradeLifecycle({");
});

Deno.test("pending reversal validation reuses the persisted verdict instead of rebuilding direction", () => {
  if (scanner.includes("loadCurrentDecisionEvidence")) {
    throw new Error(
      "The five-minute pending monitor must consume the stored verdict rather than refetching its inputs",
    );
  }
  if (confirmation.includes("buildStyleDecisionEvidence(")) {
    throw new Error(
      "The one-minute confirmation monitor must consume the stored verdict rather than rebuilding a second one",
    );
  }
});
