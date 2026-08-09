import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("src/pages/Backtest.tsx", "utf8");

describe("Backtest canonical workflow UI", () => {
  it("separates authority, diagnostics, and lifecycle evidence", () => {
    expect(source).toContain('value="workflow"');
    expect(source).toContain("Effective Entry Authority");
    expect(source).toContain("Diagnostic scoring only");
    expect(source).toContain('value="lifecycle"');
    expect(source).toContain("Canonical Trade Lifecycle");
    expect(source).toContain("finalTradeAuthorization");
  });

  it("exposes the entry-timing modes used by the engine", () => {
    expect(source).toContain("impulseEntryLifecycleMode");
    expect(source).toContain("canonicalScannerMode");
    expect(source).toContain("canonicalStructureMode");
    expect(source).toContain("Game Plan Alignment");
    expect(source).toContain("gamePlan?.enforcementMode");
    expect(source).toContain("Hard - Final Block");
    expect(source).toContain("Diagnostic Score");
    expect(source).toContain("Legacy Diagnostic Factors");
    expect(source).toContain("does not authorize trades");
    expect(source).toContain("Entry Bars Processed");
    expect(source).toContain("Entry Bars Reaching Market Analysis");
    expect(source).toContain("Candidates Sent to Entry Gates");
    expect(source).toContain("eligible weekday bars");
    expect(source).not.toContain("Historical Bars Loaded Across Timeframes");
    expect(source).toContain("wait_retracement");
  });
});
