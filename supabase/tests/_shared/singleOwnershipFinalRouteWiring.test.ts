import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const main = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const fast = await Deno.readTextFile(
  "./supabase/functions/zone-confirmation-scanner/index.ts",
);

Deno.test("the sole pending-fill route uses the shared ownership evaluator", () => {
  assertStringIncludes(fast, "evaluateSingleOwnershipFillAuthorization({");
  assertStringIncludes(
    fast,
    "frozenDecision: parsedPendingEvidence.singleOwnershipDecision",
  );
  assertStringIncludes(fast, "rawFinalAuthorized:");
  assertStringIncludes(fast, "singleOwnershipEnforcement:");
  if (main.includes("evaluateSingleOwnershipFillAuthorization({")) {
    throw new Error("duplicate pending-fill evaluator");
  }
});

Deno.test("the sole pending-fill route recalculates canonical location at fill price", () => {
  assertStringIncludes(fast, "readFrozenCanonicalDealingRange(");
  assertStringIncludes(fast, "price: actualFillPrice");
  assertStringIncludes(fast, "pendingCanonicalDealingRange.allowed");
});

Deno.test("final hierarchy remains the single Game Plan authorization owner", () => {
  assertStringIncludes(main, "gamePlanEnabled,");
  assertStringIncludes(
    fast,
    "gamePlanEnabled: config.gamePlanEnabled !== false",
  );
});

Deno.test("atomic database fill remains the final writer", () => {
  assertStringIncludes(fast, 'rpc("finalize_pending_order_fill"');
  if (main.includes('rpc("finalize_pending_order_fill"')) {
    throw new Error("duplicate pending-fill writer");
  }
});
