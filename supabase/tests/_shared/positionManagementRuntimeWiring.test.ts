import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const scannerManagement = await Deno.readTextFile("./supabase/functions/_shared/scannerManagement.ts");
const paperTrading = await Deno.readTextFile("./supabase/functions/paper-trading/index.ts");
const scanner = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");

Deno.test("management state is persisted for every runtime reader", () => {
  assertStringIncludes(scannerManagement, "exit_flags: sharedDecision.updatedExitFlags");
  assertStringIncludes(scannerManagement, "close_reason: \"be\"");
  assertStringIncludes(scannerManagement, "close_reason: \"trail\"");
  assertStringIncludes(scannerManagement, "exit_flags: updatedSignalData.exitFlags");
});

Deno.test("paper trailing uses frozen entry risk and shared policy", () => {
  assertStringIncludes(paperTrading, "resolvePositionManagementPolicy(");
  assertStringIncludes(paperTrading, "signalData.originalSL");
  assertStringIncludes(paperTrading, "riskPips * 0.5");
  assertStringIncludes(paperTrading, "exit_flags: ratchetedFlags");
});

Deno.test("paper polling does not force-close max hold positions", () => {
  assert(!paperTrading.includes("closeReason = \"time_exit\""), "scannerManagement must remain the only max-hold authority");
});

Deno.test("broker partial close failures are visible to the operator", () => {
  assertStringIncludes(scanner, %Q[activeActions.filter((a) => a.action === "partial_tp_executed")]);
  assertStringIncludes(scanner, "partialFailures");
  assertStringIncludes(scanner, "BROKER PARTIAL CLOSE RECONCILIATION REQUIRED");
  assertStringIncludes(scanner, "Broker Reconciliation Required");
});
