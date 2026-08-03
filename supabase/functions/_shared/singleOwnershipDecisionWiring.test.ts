import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const backtest = await Deno.readTextFile(
  "./supabase/functions/backtest-engine/index.ts",
);

Deno.test("live and backtest attach the same single-ownership contract", () => {
  assertStringIncludes(scanner, "evaluateSingleOwnershipDecision({");
  assertStringIncludes(backtest, "evaluateSingleOwnershipDecision({");
  assertStringIncludes(scanner, "operationalSafetyChecks(");
  assertStringIncludes(backtest, "operationalSafetyChecks(");
});

Deno.test("single-ownership evidence travels with lifecycle records", () => {
  assertStringIncludes(scanner, "singleOwnershipDecision:");
  assertStringIncludes(scanner, "(detail as any).singleOwnershipDecision || null");
});

Deno.test("phase 1 observation cannot authorize or bypass legacy eligibility", () => {
  assert(!scanner.includes("singleOwnershipDecision.decision"));
  assert(!scanner.includes("singleOwnershipDecision.affectsAuthorization"));
  assertStringIncludes(
    scanner,
    "effectiveScore >= conflictAdjustedMinConfluence && analysis.direction",
  );
});
