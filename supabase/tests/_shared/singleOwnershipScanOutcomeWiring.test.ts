import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
const detailBreakdown = await Deno.readTextFile(
  "./src/components/ScanDetailBreakdown.tsx",
);

Deno.test("ownership watch exits before generic rejection logging", () => {
  const waitBranch = scanner.indexOf('singleOwnershipScanOutcome.disposition === "wait"');
  const genericRejection = scanner.indexOf('detail.status = "rejected"', waitBranch);
  assert(waitBranch >= 0);
  assert(genericRejection > waitBranch);
  assertStringIncludes(scanner.slice(waitBranch, genericRejection), "scanDetails.push(detail)");
  assertStringIncludes(scanner.slice(waitBranch, genericRejection), "continue");
});

Deno.test("true ownership rejections persist authority reasons and enforcement", () => {
  assertStringIncludes(scanner, "...consolidatedAuthorityReasons");
  assertStringIncludes(scanner, "failedGates: detail.rejectionReasons");
  assertStringIncludes(scanner, "singleOwnershipEnforcement:");
  assertStringIncludes(detailBreakdown, "Trade Decision");
  assertStringIncludes(detailBreakdown, "singleOwnershipDecision");
});
