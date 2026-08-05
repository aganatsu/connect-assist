import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/pages/RejectedSetups.tsx"),
  "utf8",
);

describe("Rejected Setups complete export", () => {
  it("downloads one comprehensive bundle instead of triggering many files", () => {
    const handler = source.slice(
      source.indexOf("const downloadAll = () =>"),
      source.indexOf("// Pie chart data"),
    );

    expect(handler).toContain("rejected-setup-evidence.v1");
    expect(handler).toContain("rawRejectedScans: filteredRawSetups");
    expect(handler).toContain("distinctOpportunities: setups");
    expect(handler).toContain("closedTradeEvidence: filteredClosedTradeEvidence");
    expect(handler).toContain("shadowEvidence: shadowEvidenceReport");
    expect(handler).toContain("strategyEvidenceCertificates");
    expect(handler).toContain("strategyActivations");
    expect(handler).toContain("ictEntryZoneAuthorityValidation");
    expect(handler).toContain("zoneLocalValidation");
    expect(handler).toContain("tradeDecisionComparison");
    expect(handler).toContain("streamlinedDecisionComparison");
    expect(handler).toContain("canonicalDealingRangeComparison");
    expect(handler).toContain("advisor");
    expect(handler.match(/downloadFile\(/g)).toHaveLength(1);
    expect(handler).not.toContain("downloadSummary()");
  });
});
