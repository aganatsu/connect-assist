import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = readFileSync("src/components/PendingOrdersPanel.tsx", "utf8");
describe("Zone Setup confirmation contract", () => {
  it("shows protected pivot, break level and revisions", () => {
    expect(source).toContain("Confirmation contract");
    expect(source).toContain("Protected pivot");
    expect(source).toContain("CHoCH/MSS break");
    expect(source).toContain("Revisions:");
  });
});
