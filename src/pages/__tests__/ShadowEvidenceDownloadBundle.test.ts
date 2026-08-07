import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const page = fs.readFileSync(path.resolve("src/pages/RejectedSetups.tsx"), "utf8");

describe("Shadow Evidence complete download", () => {
  it("exports every current observation dataset", () => {
    expect(page).toContain('exportVersion: "rejected-setup-evidence.v2"');
    for (const dataset of [
      "ictScannerWorkflowComparison",
      "authorityOutcomeComparison",
      "marketStructureAuthorityEvidence",
      "impulseEntryLifecycleEvidence",
      "impulseLifecycleReplaySummary",
      "impulseLifecycleCertificate",
      "tradeDecisionComparison",
      "streamlinedDecisionComparison",
      "canonicalDealingRangeComparison",
    ]) expect(page).toContain(dataset);
  });
});
