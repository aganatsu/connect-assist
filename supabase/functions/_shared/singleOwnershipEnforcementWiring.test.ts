import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
const backtest = await Deno.readTextFile("./supabase/functions/backtest-engine/index.ts");
const config = await Deno.readTextFile("./supabase/functions/_shared/configMapper.ts");
const endpoint = await Deno.readTextFile("./supabase/functions/bot-config/index.ts");
const ui = await Deno.readTextFile("./src/components/config/ScanTab.tsx");

Deno.test("single ownership enforcement is default-observe and user visible", () => {
  assertStringIncludes(config, 'singleOwnershipMode: "observe"');
  assertStringIncludes(endpoint, "strategy.singleOwnershipMode must be observe or enforce");
  assertStringIncludes(ui, "Single-Ownership Scanner");
  assertStringIncludes(ui, "Enforce (Paper Only)");
});

Deno.test("single ownership bypasses legacy score only when paper enforcement is requested", () => {
  assertStringIncludes(scanner, "legacyScannerEligible || singleOwnershipPaperEnforcement");
  assertStringIncludes(scanner, 'account.execution_mode !== "live"');
  assertStringIncludes(scanner, "allPassed = singleOwnershipEnforcement.authorized");
  assertStringIncludes(backtest, 'pairConfig.singleOwnershipMode !== "enforce"');
  assertStringIncludes(backtest, "allPassed = singleOwnershipEnforcement.authorized");
});

Deno.test("single ownership keeps SL and TP as final requirements", () => {
  assertStringIncludes(scanner, "if (allPassed && analysis.stopLoss && analysis.takeProfit)");
  assertStringIncludes(backtest, "if (!analysis.stopLoss || !analysis.takeProfit)");
});
