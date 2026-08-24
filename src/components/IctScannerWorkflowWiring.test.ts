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

  it("shows one workflow stage and keeps diagnostics collapsed", () => {
    expect(detailBreakdown).toContain("ICT Scanner Workflow");
    expect(detailBreakdown).toContain("presentation?.primary?.explanation");
    expect(detailBreakdown).toContain("Diagnostic scores and legacy checks");
  });

  it("shows canonical state on Watchlist cards", () => {
    expect(watchlist).toContain("authorization_result?.canonicalScannerState");
    expect(watchlist).toContain("scannerState?.explanation");
  });
});
