import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scanTab = readFileSync("src/components/config/ScanTab.tsx", "utf8");
const detailBreakdown = readFileSync("src/components/ScanDetailBreakdown.tsx", "utf8");
const watchlist = readFileSync("src/components/WatchlistPanel.tsx", "utf8");
const configApi = readFileSync("supabase/functions/bot-config/index.ts", "utf8");

describe("canonical ICT scanner workflow UI", () => {
  it("exposes observe/enforce control behind Trade Decision enforcement", () => {
    expect(scanTab).toContain("ICT Scanner Workflow");
    expect(scanTab).toContain("canonicalScannerMode");
    expect(configApi).toContain("strategy.canonicalScannerMode must be observe or enforce");
  });

  it("keeps the actual scan outcome primary and labels the workflow by authority mode", () => {
    expect(detailBreakdown).toContain("Actual scan outcome");
    expect(detailBreakdown).toContain("Workflow observation");
    expect(detailBreakdown).toContain("Workflow enforcement");
    expect(detailBreakdown).toContain("does not change this scan outcome");
    expect(detailBreakdown).toContain("presentation?.primary?.explanation");
    expect(detailBreakdown).toContain("Diagnostic scores and legacy checks");
    expect(detailBreakdown).not.toContain("current canonical authority");
  });

  it("shows canonical state on Watchlist cards", () => {
    expect(watchlist).toContain("authorization_result?.canonicalScannerState");
    expect(watchlist).toContain("scannerState?.explanation");
  });
});
