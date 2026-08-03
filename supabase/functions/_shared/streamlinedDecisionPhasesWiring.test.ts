import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (path: string) => Deno.readTextFile(new URL(`../../../${path}`, import.meta.url));

Deno.test("remaining streamlined phases are wired across lifecycle and parity surfaces", async () => {
  const [scanner, confirmation, backtest, config, rejected, migration] = await Promise.all([
    read("supabase/functions/bot-scanner/index.ts"),
    read("supabase/functions/zone-confirmation-scanner/index.ts"),
    read("supabase/functions/backtest-engine/index.ts"),
    read("supabase/functions/bot-config/index.ts"),
    read("src/pages/RejectedSetups.tsx"),
    read("supabase/migrations/20260803130000_add_streamlined_decision_lifecycle.sql"),
  ]);
  assertStringIncludes(scanner, "evaluateStreamlinedEnforcement");
  assertStringIncludes(scanner, "streamlined_decision_origin");
  assertStringIncludes(confirmation, "streamlinedDecisionLatest");
  assertStringIncludes(backtest, "buildStreamlinedTradeDecisionObservation");
  assertStringIncludes(config, 'action === "streamlined_decision.comparison"');
  assertStringIncludes(rejected, "Streamlined Decision Comparison");
  assertStringIncludes(migration, "streamlined decision origin is immutable");
  assert(!scanner.includes("streamlinedTradeDecision.authorized"));
});
