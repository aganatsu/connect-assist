import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("scanner safety gates accept only a resolved trade direction", () => {
  const start = scanner.indexOf("async function runSafetyGates(");
  const end = scanner.indexOf("): Promise<GateResult[]>", start);
  assert(start >= 0 && end > start);
  const signature = scanner.slice(start, end);

  assertStringIncludes(signature, 'direction: "long" | "short"');
  assertEquals(signature.includes("direction: string"), false);
});

Deno.test("scanner analysis locally owns canonical range telemetry fields", () => {
  assertStringIncludes(
    scanner,
    "type ScannerConfluenceAnalysis = ReturnType<typeof runConfluenceAnalysis> & {",
  );
  assertStringIncludes(
    scanner,
    "_canonicalDealingRangeAvailable?: boolean;",
  );
  assertStringIncludes(
    scanner,
    "_canonicalDealingRangeEvaluation?: ReturnType<",
  );
  assertStringIncludes(
    scanner,
    "typeof evaluateCanonicalDealingRange",
  );
  assertStringIncludes(
    scanner,
    "const analysis: ScannerConfluenceAnalysis = runConfluenceAnalysis(",
  );
});

Deno.test("canonical confirmation telemetry reuses the computed confirmation id", () => {
  const start = scanner.indexOf("const confirmationTime =");
  const end = scanner.indexOf(
    "const canonicalScannerEnforcement =",
    start,
  );
  assert(start >= 0 && end > start);
  const confirmationFlow = scanner.slice(start, end);

  assertStringIncludes(confirmationFlow, "const confirmationId =");
  assertStringIncludes(confirmationFlow, "confirmationId,");
  assertStringIncludes(confirmationFlow, "evidenceId: confirmationId,");
  assertEquals(
    confirmationFlow.includes("candidateConfirmationSignal?.evidenceId"),
    false,
  );
});
