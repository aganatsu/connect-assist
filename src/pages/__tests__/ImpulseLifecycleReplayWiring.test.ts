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
    expect(page).toContain("30+ READY");
  });
});
