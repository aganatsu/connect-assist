import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
const fast = await Deno.readTextFile("./supabase/functions/zone-confirmation-scanner/index.ts");
const endpoint = await Deno.readTextFile("./supabase/functions/bot-config/index.ts");
const ui = await Deno.readTextFile("./src/components/config/ScanTab.tsx");
const policy = await Deno.readTextFile("./supabase/functions/_shared/singleOwnershipEnforcement.ts");

Deno.test("live enforcement is explicit across config and policy", () => {
  assertStringIncludes(endpoint, '"observe", "enforce", "enforce_live"');
  assertStringIncludes(ui, 'value="enforce_live"');
  assertStringIncludes(ui, "Enforce Live (Real Orders)");
  assertStringIncludes(policy, 'requestedMode === "enforce_live"');
});

Deno.test("live enforcement reaches scanner and both fill routes", () => {
  assertStringIncludes(scanner, "singleOwnershipEnforcementRequested");
  assertStringIncludes(scanner, 'singleOwnershipMode === "enforce_live"');
  assertStringIncludes(scanner, "evaluateSingleOwnershipFillAuthorization({");
  assertStringIncludes(fast, 'singleOwnershipMode === "enforce_live"');
  assertStringIncludes(fast, "evaluateSingleOwnershipFillAuthorization({");
});

Deno.test("live routes retain final and atomic operational authorization", () => {
  for (const source of [scanner, fast]) {
    assertStringIncludes(source, "evaluateFinalTradeAuthorization({");
    assertStringIncludes(source, 'rpc("finalize_pending_order_fill"');
  }
});
