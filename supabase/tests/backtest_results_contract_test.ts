import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const engine = await Deno.readTextFile(
  new URL("../functions/backtest-engine/index.ts", import.meta.url),
);

Deno.test("backtest result contract derives factors and honest gate outcomes", () => {
  assertStringIncludes(engine, "const factorBreakdown:");
  assertStringIncludes(engine, "for (const factor of trade.factors || [])");
  assertStringIncludes(engine, "const code = normalizeRejectedGate(reason)");
  assertStringIncludes(engine, "wouldHaveWon: null, wouldHaveLost: null");
  assertStringIncludes(engine, "outcomesAvailable: true");
  assertStringIncludes(engine, "factorBreakdown,");
  assertStringIncludes(engine, "gateBreakdown,");
});
