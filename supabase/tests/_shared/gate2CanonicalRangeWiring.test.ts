import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("Gate 2 consumes the canonical dealing-range evaluation", () => {
  const start = scanner.indexOf("// Gate 2: Premium/Discount");
  const end = scanner.indexOf("// Gate 3:", start);
  const gate = scanner.slice(start, end);
  assert(gate.includes("analysis._canonicalDealingRangeEvaluation"));
  assert(!gate.includes("analysis.pd.currentZone"));
  assert(!gate.includes("analysis.pd.zonePercent"));
});

Deno.test("the canonical observation is made available to Gate 2", () => {
  assert(
    scanner.includes("analysis._canonicalDealingRangeEvaluation = canonicalEvaluation"),
  );
});
