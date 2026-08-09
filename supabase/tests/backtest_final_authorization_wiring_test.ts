import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const engine = await Deno.readTextFile(
  new URL("../functions/backtest-engine/index.ts", import.meta.url),
);

Deno.test("backtest reauthorizes a confirmed candidate at historical fill", () => {
  assertStringIncludes(engine, "evaluateFinalTradeAuthorization({");
  assertStringIncludes(engine, "evaluateSingleOwnershipFillAuthorization({");
  assertStringIncludes(engine, "projectCanonicalScannerState({");
  assertStringIncludes(engine, "canonicalDealingRangeEvaluation.allowed === true");
  assertStringIncludes(engine, "finalAuthorization.authorized");
  assertStringIncludes(engine, "singleOwnershipFillAuthorization = ownershipFill");
});
