import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const enterTab = readFileSync("src/components/config/EnterTab.tsx", "utf8");
const scanner = readFileSync("supabase/functions/zone-confirmation-scanner/index.ts", "utf8");
const pending = readFileSync("src/components/PendingOrdersPanel.tsx", "utf8");

describe("post-CHoCH retracement wiring", () => {
  it("offers backward-compatible, observe, and wait modes", () => {
    expect(enterTab).toContain("Enter at CHoCH Close");
    expect(enterTab).toContain("Observe FVG/OB Retracement");
    expect(enterTab).toContain("Wait for FVG/OB Retracement");
  });

  it("persists the plan and retains final authorization at retracement fill", () => {
    expect(scanner).toContain("derivePostChochEntryPlan");
    expect(scanner).toContain("post_confirmation_entry");
    expect(scanner).toContain("no deterministic retracement zone could be frozen");
    expect(scanner).toContain("evaluateFinalTradeAuthorization");
    expect(scanner).toContain("finalize_pending_order_fill");
  });

  it("shows the frozen micro-zone in Zone Setups", () => {
    expect(pending).toContain("CHoCH confirmed");
    expect(pending).toContain("RETRACEMENT");
  });
});
