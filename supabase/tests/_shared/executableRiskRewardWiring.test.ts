import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const fastScanner = await Deno.readTextFile(
  new URL(
    "../../functions/zone-confirmation-scanner/index.ts",
    import.meta.url,
  ),
);
const backtest = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);
const finalAuthorization = await Deno.readTextFile(
  new URL(
    "../../functions/_shared/finalTradeAuthorization.ts",
    import.meta.url,
  ),
);

Deno.test("live discovery defers R:R until final executable authorization", () => {
  const safetyStart = scanner.indexOf("async function runSafetyGates(");
  const safetyEnd = scanner.indexOf(
    "async function hydratePendingLifecycleRows",
    safetyStart,
  );
  const safety = scanner.slice(safetyStart, safetyEnd);
  assert(safetyStart >= 0 && safetyEnd > safetyStart);
  assert(
    !safety.includes("checkMinRR({"),
    "preliminary analysis geometry must not enforce minimum R:R",
  );
  assertStringIncludes(
    safety,
    "Risk/reward deferred until executable geometry",
  );
  assert(
    !scanner.includes('from "../_shared/gateMinRR.ts"'),
    "the live orchestrator must delegate minimum R:R to final authorization",
  );
});

Deno.test("all final-authorization routes pass cost inputs to the shared R:R owner", () => {
  assertStringIncludes(finalAuthorization, "const riskReward = checkMinRR({");
  assertStringIncludes(
    finalAuthorization,
    "spreadPipsOverride: input.spread.spreadPips",
  );
  assertStringIncludes(
    finalAuthorization,
    "commissionPerLot: input.commissionPerLot",
  );

  assertStringIncludes(scanner, "commissionPerLot: avgCommissionPerLot");
  assertStringIncludes(scanner, "spreadPips: directBestSpread?.spreadPips");
  assertStringIncludes(
    fastScanner,
    "commissionPerLot: executionCommissionPerLot",
  );
  assertStringIncludes(fastScanner, "spreadPips: bestSpread?.spreadPips");
  assertStringIncludes(backtest, "commissionPerLot,");
  assertStringIncludes(
    backtest,
    "spreadPips: spreadPips > 0 ? spreadPips : undefined",
  );
});

Deno.test("breaker placement no longer keeps a separate raw R:R comparison", () => {
  const breakerStart = scanner.indexOf("const breakerRisk");
  const breakerEnd = scanner.indexOf("// Size calculation", breakerStart);
  assert(breakerStart >= 0 && breakerEnd > breakerStart);
  const breakerBlock = scanner.slice(breakerStart, breakerEnd);
  assert(!breakerBlock.includes("breakerRR <"));
});
