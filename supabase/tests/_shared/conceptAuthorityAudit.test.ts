/**
 * Source-level guardrails for the concept-authority audit.
 *
 * These tests do not approve the current semantic differences. They make the
 * differences explicit so a detector can no longer be added, removed, or
 * silently rewired without updating the audit and its migration plan.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

function source(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, root));
}

Deno.test("authority audit: live and backtest share the primary scoring and zone engines", () => {
  const scanner = source("bot-scanner/index.ts");
  const backtest = source("backtest-engine/index.ts");

  for (
    const functionName of [
      "runConfluenceAnalysis",
      "findUnifiedZone",
      "findCascadeZone",
    ]
  ) {
    assertStringIncludes(scanner, `${functionName}(`);
    assertStringIncludes(backtest, `${functionName}(`);
  }
});

Deno.test("authority audit: Impulse-to-Tier compatibility credit exists in both orchestrators", () => {
  const scanner = source("bot-scanner/index.ts");
  const backtest = source("backtest-engine/index.ts");

  for (const content of [scanner, backtest]) {
    assertStringIncludes(content, "IMPULSE-ZONE CREDIT");
    assertStringIncludes(content, "FVG (impulse-zone-confirmed)");
    assertStringIncludes(content, "OB (impulse-zone-confirmed)");
  }
});

Deno.test("authority audit: the two Breaker contracts remain explicitly distinct", () => {
  const primary = source("_shared/smcAnalysis.ts");
  const enhancement = source("_shared/breakerBlockDetection.ts");

  assertStringIncludes(
    primary,
    "export function detectBreakerBlocks(",
  );
  assertStringIncludes(
    enhancement,
    "export function detectBreakerBlocks(",
  );
  assertStringIncludes(enhancement, "requireSweep");
  assertStringIncludes(enhancement, "retestComplete");
  assertStringIncludes(enhancement, "displacementStrength");
});

Deno.test("authority audit: the two Judas contracts remain explicitly distinct", () => {
  const sessionJudas = source("_shared/smcAnalysis.ts");
  const preMssJudas = source("_shared/ictJudasSwing.ts");
  const scanner = source("bot-scanner/index.ts");
  const scoring = source("_shared/confluenceScoring.ts");

  assertStringIncludes(sessionJudas, "export function detectJudasSwing(");
  assertStringIncludes(preMssJudas, "export function detectJudasSwing(");
  assertStringIncludes(preMssJudas, "mssIndex");
  assertStringIncludes(preMssJudas, "sweepLookback");
  assertStringIncludes(scanner, "detectICTJudasSwing(");
  assertStringIncludes(scoring, "detectJudasSwing(candles)");
});

Deno.test("authority audit baseline: SMC Enhancements are live-only until parity work is implemented", () => {
  const scanner = source("bot-scanner/index.ts");
  const backtest = source("backtest-engine/index.ts");

  assertStringIncludes(scanner, "runSMCEnhancements(");
  assertEquals(
    backtest.includes("runSMCEnhancements("),
    false,
    "Backtest now runs SMC Enhancements. Update the audit and replace this baseline with behavioral parity fixtures.",
  );
});

Deno.test("authority audit: frontend confluence summary remains non-authoritative", () => {
  const frontend = Deno.readTextFileSync(
    new URL("../../../src/lib/confluenceUnify.ts", import.meta.url),
  );
  const scanner = source("bot-scanner/index.ts");

  assert(frontend.includes("activeFVGs.length > 0"));
  assert(scanner.includes("runConfluenceAnalysis("));
  assertEquals(frontend.includes("executeBrokerOrderWithLedger"), false);
});
