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
  assertStringIncludes(backtest, "validatePendingOrderThesis({");
  assertStringIncludes(backtest, "thesis: { required: true");
  assertStringIncludes(scanner, "singleOwnershipEnforced: singleOwnershipEnforcementRequested");
});

Deno.test("single-ownership evidence travels with lifecycle records", () => {
  assertStringIncludes(scanner, "singleOwnershipDecision:");
  assertStringIncludes(scanner, "(detail as any).singleOwnershipDecision || null");
});

Deno.test("single-ownership enforcement is explicit across runtime targets", () => {
  assertStringIncludes(scanner, "singleOwnershipEnforcementRequested");
  assertStringIncludes(scanner, "evaluateSingleOwnershipEnforcement({");
  assertStringIncludes(backtest, "evaluateSingleOwnershipEnforcement({");
});
