import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const page = readFileSync("src/pages/RejectedSetups.tsx", "utf8");
describe("impulse lifecycle replay evidence", () => {
  it("offers exact-snapshot replay and reports the decision outcomes", () => {
    expect(page).toContain('"impulse-lifecycle-replay"');
    expect(page).toContain("Replay 100");
    expect(page).toContain("Winners retained");
    expect(page).toContain("Rescued winners");
    expect(page).toContain("Added losses");
    expect(page).toContain("No entry");
    expect(page).toContain("Inconclusive");
    expect(page).toContain("Resolved outcomes");
    expect(page).toContain("Zone never touched");
    expect(page).toContain("Touch, no trigger lock");
    expect(page).toContain("Trigger locked, no confirmation");
    expect(page).toContain("30+ READY");
    expect(page).toContain("missing initial lifecycle");
    expect(page).toContain("missing candle snapshot");
    expect(page).toContain("insufficient post-activation candles");
  });
});
