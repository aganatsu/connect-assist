import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const main = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
const fast = await Deno.readTextFile("./supabase/functions/zone-confirmation-scanner/index.ts");

Deno.test("both pending-fill routes use the shared ownership fill evaluator", () => {
  for (const source of [main, fast]) {
    assertStringIncludes(source, "evaluateSingleOwnershipFillAuthorization({");
    assertStringIncludes(source, "frozenDecision: parsedPendingEvidence.singleOwnershipDecision");
    assertStringIncludes(source, "rawFinalAuthorized:");
    assertStringIncludes(source, "singleOwnershipEnforcement:");
  }
});

Deno.test("both pending-fill routes recalculate canonical location at fill price", () => {
  for (const source of [main, fast]) {
    assertStringIncludes(source, "readFrozenCanonicalDealingRange(");
    assertStringIncludes(source, "price: actualFillPrice");
    assertStringIncludes(source, "pendingCanonicalDealingRange.allowed");
  }
});

Deno.test("final hierarchy remains the single Game Plan authorization owner", () => {
  assertStringIncludes(main, "gamePlanEnabled: config.gamePlanEnabled !== false");
  assertStringIncludes(fast, "gamePlanEnabled: config.gamePlanEnabled !== false");
});

Deno.test("atomic database fill remains the final writer", () => {
  assertStringIncludes(main, 'rpc("finalize_pending_order_fill"');
  assertStringIncludes(fast, 'rpc("finalize_pending_order_fill"');
});
