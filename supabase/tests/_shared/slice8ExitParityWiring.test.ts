import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scannerManagement = await Deno.readTextFile(
  new URL("../../functions/_shared/scannerManagement.ts", import.meta.url),
);
const backtestEngine = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);

Deno.test("live and backtest call the same partial-close authority", () => {
  assertStringIncludes(
    scannerManagement,
    "const partialDecision = computePartialCloseDecision({",
  );
  assertStringIncludes(
    scannerManagement,
    'executionPriceMode: "observed_market"',
  );
  assertStringIncludes(
    backtestEngine,
    "const partialDecision = computePartialCloseDecision({",
  );
  assertStringIncludes(
    backtestEngine,
    'executionPriceMode: "threshold"',
  );
  assertEquals(scannerManagement.includes("calcPartialPnl("), false);
});

Deno.test("live and backtest build the same structure evidence", () => {
  assertStringIncludes(
    scannerManagement,
    "structureEvidence = buildStructureInvalidationEvidence({",
  );
  assertStringIncludes(
    backtestEngine,
    "structureEvidence = buildStructureInvalidationEvidence({",
  );
  assertStringIncludes(
    scannerManagement,
    "structureCheck: structureEvidence?.structureCheck || null",
  );
  assertStringIncludes(
    backtestEngine,
    "structureCheck: structureEvidence?.structureCheck || null",
  );
});

Deno.test("both surfaces persist exit-parity evidence", () => {
  assertStringIncludes(scannerManagement, "partialCloseEvidence:");
  assertStringIncludes(scannerManagement, "evidence: structureEvidence");
  assertStringIncludes(backtestEngine, "exitParityEvidence:");
  assertStringIncludes(backtestEngine, "partialClose: partialDecision");
});
