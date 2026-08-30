import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scannerSource = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("bot scanner uses the canonical Watchlist invalidation contract", () => {
  assertStringIncludes(
    scannerSource,
    'from "../_shared/watchlistInvalidation.ts"',
  );
  assertStringIncludes(scannerSource, "watchlistInvalidationFor(");
  assertStringIncludes(
    scannerSource,
    'reason: "structural_invalidation_breached"',
  );
});

Deno.test("all staged setup protection writes use canonical boundaries", () => {
  const prohibitedWrites = [
    "sl_level: analysis.stopLoss",
    'sl_level: analysis.direction === "long" ? izData.impulse.low : izData.impulse.high',
    "analysis.lastPrice - 0.0050",
    "analysis.lastPrice + 0.0050",
  ];

  for (const write of prohibitedWrites) {
    assertEquals(
      scannerSource.includes(write),
      false,
      `Found legacy Watchlist invalidation write: ${write}`,
    );
  }

  assertStringIncludes(
    scannerSource,
    "sl_level: executionEligible ? watchlistInvalidation?.level : null",
  );
  assertStringIncludes(
    scannerSource,
    "sl_level: zoneWatchInvalidation.level",
  );
  assertStringIncludes(
    scannerSource,
    "sl_level: sweepWatchInvalidation.level",
  );
  assert(
    !/\.from\("staged_setups"\)\.update\(\{[\s\S]{0,700}?sl_level:/
      .test(scannerSource),
    "staged refreshes must not rewrite a boundary after its canonical creation",
  );
});

Deno.test("Watchlist invalidation wording is not presented as an active SL", () => {
  assertEquals(scannerSource.includes("SL level breached"), false);
  assertStringIncludes(
    scannerSource,
    "Structural invalidation breached before entry",
  );
});
