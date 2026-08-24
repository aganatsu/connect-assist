import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = readFileSync("src/components/PendingOrdersPanel.tsx", "utf8");
describe("Zone Setup confirmation contract", () => {
  it("shows protected pivot, break level and revisions", () => {
    expect(source).toContain("Structure confirmation plan");
    expect(source).toContain("Protected pivot");
    expect(source).toContain("CHoCH/MSS break");
    expect(source).toContain("Revisions:");
  });

  it("explains why a structure confirmation plan is still building", () => {
    expect(source).toContain("confirmation_build_diagnostic");
    expect(source).toContain("Waiting for closed");
    expect(source).toContain("No confirmed post-touch protected pivot yet");
    expect(source).toContain("no qualifying opposing break pivot exists");
    expect(source).toContain("Waiting: {buildingReason}");
  });

  it("separates observation-only liquidity sequencing from the structure plan", () => {
    expect(source).toContain("Liquidity → structure observation");
    expect(source).toContain("OBSERVE ONLY");
    expect(source).toContain("Structure confirmation plan");
    expect(source).toContain("does not authorize or block this order");
  });

  it("does not render a null deferred size as an empty lot value", () => {
    expect(source).toContain("Calculated at final authorization");
  });

  it("shows the real expiry while confirmation is active", () => {
    expect(source).toContain('nestedPoiEnforced ? "Nested trigger active" : "Confirmation active"');
    expect(source).toContain("getTimeRemaining(order.expires_at)");
    expect(source).not.toContain("Confirmation active — no time limit");
  });

  it("does not claim the structure trigger is building before zone touch", () => {
    expect(source).toContain("STARTS AFTER TOUCH");
    expect(source).toContain('order.impulse_entry_lifecycle.mode === "enforce"');
    expect(source).toContain("OBSERVE ONLY");
    expect(source).toContain("ENFORCED");
  });

  it("names the enforced structure break instead of promising a generic CHoCH/BOS trigger", () => {
    expect(source).toContain("pendingOrderConfirmationPresentation");
    expect(source).toContain("requires a later displaced close through its locked MSS/CHoCH break");
    expect(source).not.toContain(' : "CHoCH/BOS"');
  });

  it("renders nested POI orders without claiming CHoCH or retracement ownership", () => {
    expect(source).toContain("pendingOrderNestedPoiPresentation");
    expect(source).toContain("Outer zone entered — awaiting frozen nested POI");
    expect(source).toContain("Nested POI market plan");
    expect(source).toContain("Nested POI observation");
    expect(source).toContain('nestedPoi.route === "observe"');
    expect(source).toContain("current market price is used only after fresh final authorization");
    expect(source).toContain("!nestedPoiEnforced && order.impulse_entry_lifecycle?.confirmation");
    expect(source).toContain('{nestedPoiEnforced ? "Nested trigger active" : "Confirmation active"}');
  });

  it("shows whether the frozen Zone Setup stop policy can affect paper and live execution", () => {
    expect(source).toContain("zoneSetupStopPolicyAppliedAtArm");
    expect(source).toContain("Zone stop policy");
    expect(source).toContain("PAPER + LIVE");
    expect(source).toContain("broker constraints");
  });

  it("labels an enforced pre-armed stop as arm-time geometry", () => {
    expect(source).toContain('const stopLossLabel = zoneStopPolicyAppliedAtArm ? "Arm-time SL" : "SL"');
    expect(source).toContain("Final SL recalculated at authorization");
  });
});
