import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("../../../src/components/ExpandedPositionCard.tsx", import.meta.url),
);

Deno.test("position card displays BE pips and equivalent R without a 1R clamp", () => {
  assertStringIncludes(source, "? (ef.breakEvenPips * pipSize) / riskDist");
  assertStringIncludes(source, "Trigger: ${fmtPipsDollar(beTriggerPips, beTriggerDollar)} (${beR?.toFixed(2)}R)");\n  assertStringIncludes(source, "SL → ${formatPrice(beStopPrice, p.symbol)} at ${formatPrice(bePrice, p.symbol)}");
});
