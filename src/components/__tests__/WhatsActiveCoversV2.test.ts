import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Anything observational must be listed as observational.
 *
 * The What's Active tab exists so a measurement is never mistaken for live
 * behaviour, and so a live gate is never mistaken for a measurement. V2 was
 * detecting, scoring, storing and drawing on the chart while that tab said
 * nothing about it — a violet overlay appearing with no entry anywhere reads
 * like a feature that is running.
 */

const panel = readFileSync("src/components/SignalStatusPanel.tsx", "utf8");

describe("What's Active covers V2", () => {
  it("lists the V2 detector", () => {
    expect(panel).toContain("Structural order blocks (V2)");
  });

  it("marks it observational, not live", () => {
    const i = panel.indexOf("Structural order blocks (V2)");
    const entry = panel.slice(i, i + 1200);
    expect(entry).toMatch(/observationalOnly:\s*true/);
    expect(entry).toMatch(/waitingFor:/);
  });

  it("says plainly that nothing trades on it", () => {
    // The whole point of the entry. Someone seeing OB2 boxes on the chart
    // needs to know they describe nothing the bot acted on.
    const i = panel.indexOf("Structural order blocks (V2)");
    const entry = panel.slice(i, i + 1200);
    expect(entry.toLowerCase()).toContain("nothing trades on it");
  });

  it("every observational entry states what it is waiting for", () => {
    // An observation with no stated question is one nobody will ever come
    // back to. This has already happened once: a flag left off pending
    // evidence that only the flag could produce.
    const blocks = panel.split(/\n  \{\n/).filter((b) => b.includes("observationalOnly: true"));
    expect(blocks.length).toBeGreaterThan(3);
    for (const b of blocks) {
      expect(b, `an observational entry has no waitingFor: ${b.slice(0, 80)}`).toMatch(/waitingFor:/);
    }
  });
});
