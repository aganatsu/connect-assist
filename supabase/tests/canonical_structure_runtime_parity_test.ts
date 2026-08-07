import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(new URL("../functions/bot-scanner/index.ts", import.meta.url));
const backtest = await Deno.readTextFile(new URL("../functions/backtest-engine/index.ts", import.meta.url));

Deno.test("live scanner builds one structure and confirmation snapshot from role candles", () => {
  assertStringIncludes(scanner, "buildCanonicalStructureAuthority(\n      roleCandles.structure");
  assertStringIncludes(scanner, "buildCanonicalStructureAuthority(\n      roleCandles.confirmation");
  assertStringIncludes(scanner, "buildCanonicalLiquiditySequences(\n      canonicalConfirmationStructure");
  assertStringIncludes(scanner, "canonicalStructureAuthority,");
});

Deno.test("backtest builds the same canonical contracts from bounded role candles", () => {
  assertStringIncludes(backtest, "buildCanonicalStructureAuthority(\n          roleCandles.structure");
  assertStringIncludes(backtest, "buildCanonicalStructureAuthority(roleCandles.confirmation)");
  assertStringIncludes(backtest, "_canonicalLiquiditySequence");
  assertStringIncludes(backtest, "evaluateCanonicalStructureEnforcement({");
  assertStringIncludes(backtest, "Market Structure Authority:");
});
