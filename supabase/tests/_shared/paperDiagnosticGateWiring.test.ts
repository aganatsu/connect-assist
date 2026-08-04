import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
const backtest = await Deno.readTextFile("./supabase/functions/backtest-engine/index.ts");

Deno.test("scanner routes duplicate early vetoes through authority ownership", () => {
  for (const code of [
    "impulse_zone_score", "conflict_count", "htf_alignment", "ict_mss",
    "ict_judas", "ict_fvg_invalidation", "ict_kill_zone",
  ]) {
    assertStringIncludes(scanner, `legacyGateBlocks("${code}"`);
  }
  assertStringIncludes(scanner, 'account.execution_mode !== "live"');
  assertStringIncludes(scanner, "legacyGateDiagnostics:");
});

Deno.test("ICT operational risk follows authority ownership", () => {
  assertStringIncludes(scanner, 'legacyGateBlocks("ict_risk"');
  assertStringIncludes(scanner, "ICT RISK BLOCKED");
});

Deno.test("backtest uses the same disposition for conflict and zone score", () => {
  assertStringIncludes(backtest, "evaluateAuthorityGateDisposition({");
  assertStringIncludes(backtest, 'backtestLegacyGateBlocks("conflict_count"');
  assertStringIncludes(backtest, 'backtestLegacyGateBlocks("impulse_zone_score"');
  assertStringIncludes(backtest, "legacyGateDiagnostics = legacyGateDiagnostics");
});
