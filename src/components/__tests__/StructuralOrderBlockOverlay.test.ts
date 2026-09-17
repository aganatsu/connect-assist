import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The V2 overlay is a DEBUG view, not a trading surface.
 *
 * The agreed line is: displaying V2 output is allowed in shadow mode, acting on
 * it is not. These tests pin the "displaying" half — that it exists, that it is
 * visually separable from the legacy detector, and that it cannot be confused
 * with it while the two are being compared against the reference charts.
 */

const chart = readFileSync("src/components/SMCChart.tsx", "utf8");
const page = readFileSync("src/pages/Chart.tsx", "utf8");

describe("V2 overlay", () => {
  it("is its own toggleable layer, separate from the legacy OB layer", () => {
    expect(chart).toMatch(/\{ id: "obV2", label: "OB2"/);
    expect(chart).toMatch(/\{ id: "orderBlocks", label: "OB"/);
  });

  it("is a different colour from the legacy blocks", () => {
    // Comparing two detectors by eye only works if they don't look identical.
    const v2 = chart.match(/v2Bull:\s*"([^"]+)"/)?.[1];
    const legacy = chart.match(/bullOB:\s*"([^"]+)"/)?.[1];
    expect(v2).toBeTruthy();
    expect(legacy).toBeTruthy();
    expect(v2).not.toBe(legacy);
  });

  it("draws the sweep level outside the zone, dotted", () => {
    // sweepLevel is the base's wick extreme and is NOT a boundary. Drawing it
    // like one would undo the distinction the whole engine rests on.
    const block = chart.slice(chart.indexOf('visibleLayers.has("obV2")'));
    expect(block).toContain("COLORS.v2Sweep");
    expect(block).toMatch(/lineStyle:\s*LineStyle\.Dotted/);
  });

  it("hides invalidated blocks", () => {
    const block = chart.slice(chart.indexOf('visibleLayers.has("obV2")'));
    expect(block).toMatch(/status !== "INVALIDATED"/);
  });

  it("reads from the scan record, not the live analysis call", () => {
    // The detector runs inside bot-scanner on Daily/4H candles. Sourcing it
    // from the live smc-analysis call would silently show something else.
    expect(page).toMatch(/sig\?\.structuralOrderBlocksV2/);
  });

  it("the overlay cannot place or modify a trade", () => {
    const block = chart.slice(chart.indexOf('visibleLayers.has("obV2")'));
    const end = block.indexOf("─── FVGs");
    const body = block.slice(0, end > 0 ? end : 2000);
    for (const forbidden of ["fetch(", "supabase", "onClick", "navigate"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
