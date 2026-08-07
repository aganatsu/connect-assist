import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/pages/RejectedSetups.tsx", "utf8");
const api = readFileSync("src/lib/api.ts", "utf8");
const edge = readFileSync("supabase/functions/bot-config/index.ts", "utf8");

describe("ICT Scanner Workflow Shadow Evidence", () => {
  it("loads the comparison from authoritative closed and rejected records", () => {
    expect(api).toContain("getICTScannerComparison");
    expect(edge).toContain("ict_scanner.comparison");
    expect(edge).toContain("buildCanonicalScannerComparison");
  });

  it("shows coverage, stages, outcome impact and downloadable data", () => {
    expect(page).toContain("ICT Scanner Workflow Comparison");
    expect(page).toContain("Stage distribution");
    expect(page).toContain("Poor entries rejected");
    expect(page).toContain("ict-scanner-workflow-");
  });

  it("explains that watch is not immediate authorization", () => {
    expect(page).toContain("it does not mean immediate entry");
  });
});
