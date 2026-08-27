import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const fast = await Deno.readTextFile(
  "./supabase/functions/zone-confirmation-scanner/index.ts",
);
const endpoint = await Deno.readTextFile(
  "./supabase/functions/bot-config/index.ts",
);
const ui = await Deno.readTextFile("./src/components/config/ScanTab.tsx");
const policy = await Deno.readTextFile(
  "./supabase/functions/_shared/singleOwnershipEnforcement.ts",
);

Deno.test("enforcement follows the selected account while legacy live values remain compatible", () => {
  assertStringIncludes(endpoint, '"observe", "enforce", "enforce_live"');
  assertStringIncludes(ui, '<SelectItem value="enforce">Enforce</SelectItem>');
  assertStringIncludes(
    ui,
    'config.strategy?.streamlinedDecisionMode === "enforce" ? "enforce" : "observe"',
  );
  assertStringIncludes(
    policy,
    'requested === "enforce_live"',
  );
  assertStringIncludes(
    policy,
    'effectiveMode: requestedMode === "observe" ? "observe" : "enforce"',
  );
});

Deno.test("live enforcement reaches placement and the sole pending fill route", () => {
  assertStringIncludes(scanner, "singleOwnershipEnforcementRequested");
  assertStringIncludes(
    scanner,
    '["enforce", "enforce_live"].includes((pairConfig as any).singleOwnershipMode)',
  );
  assertStringIncludes(
    fast,
    "requestedMode: (config as any).singleOwnershipMode",
  );
  assertStringIncludes(fast, "evaluateSingleOwnershipFillAuthorization({");
});

Deno.test("frozen fill and backtest use the same retained-direction policy", async () => {
  const backtest = await Deno.readTextFile(
    "./supabase/functions/backtest-engine/index.ts",
  );
  assertStringIncludes(
    fast,
    'directionVerdictPolicy: "retain_frozen_until_opposed"',
  );
  assertStringIncludes(
    backtest,
    'directionVerdictPolicy: "retain_frozen_until_opposed"',
  );
  if (scanner.includes('directionVerdictPolicy: "retain_frozen_until_opposed"')) {
    throw new Error("Immediate market entries must keep strict current-direction authorization");
  }
});

Deno.test("live routes retain final and atomic operational authorization", () => {
  assertStringIncludes(scanner, "evaluateFinalTradeAuthorization({");
  assertStringIncludes(scanner, "finalize_market_entry");
  assertStringIncludes(fast, "evaluateFinalTradeAuthorization({");
  assertStringIncludes(fast, "finalize_pending_order_fill");
});
