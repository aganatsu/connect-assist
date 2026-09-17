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
const hud = readFileSync("src/components/ChartOverlayHUD.tsx", "utf8");

describe("V2 overlay", () => {
  it("is its own toggleable layer, separate from the legacy OB layer", () => {
    expect(chart).toMatch(/\{ id: "obV2", label: "OB2"/);
    expect(chart).toMatch(/\{ id: "orderBlocks", label: "OB"/);
  });

  it("is a different colour from the legacy blocks", () => {
    // Comparing two detectors by eye only works if they don't look identical.
    const legacy = chart.match(/bullOB:\s*"([^"]+)"/)?.[1];
    expect(legacy).toBeTruthy();
    for (const key of ["v2BullD", "v2BearD", "v2Bull4H", "v2Bear4H"]) {
      const v2 = chart.match(new RegExp(`${key}:\\s*"([^"]+)"`))?.[1];
      expect(v2, `${key} is defined`).toBeTruthy();
      expect(v2, `${key} must not match the legacy OB colour`).not.toBe(legacy);
    }
  });

  it("draws bounded segments, not full-width price lines", () => {
    // createPriceLine spans the whole chart. A dozen blocks drawn that way is
    // an unreadable thicket, and it hides the one thing worth seeing: where
    // the zone was created.
    const block = chart.slice(chart.indexOf('visibleLayers.has("obV2")'));
    const body = block.slice(0, block.indexOf("─── FVGs"));
    expect(body).toContain("addSegmentLine");
    expect(body).not.toContain("addLine(");
  });

  it("each segment starts at its own origin candle", () => {
    const block = chart.slice(chart.indexOf('visibleLayers.has("obV2")'));
    const body = block.slice(0, block.indexOf("─── FVGs"));
    expect(body).toMatch(/idxAtOrAfter\(tsOf\(b\.originTime\)\)/);
    // A Daily zone older than the visible window must clamp to the left edge
    // rather than disappear — it is still real on a lower-timeframe chart.
    expect(body).toMatch(/if \(ts <= first\) return 0;/);
  });

  it("the label carries the origin date", () => {
    const block = chart.slice(chart.indexOf('visibleLayers.has("obV2")'));
    const body = block.slice(0, block.indexOf("─── FVGs"));
    expect(body).toMatch(/shortDate\(b\.originTime\)/);
    expect(body).toMatch(/\$\{when\}/);
  });

  it("Daily and 4H are visually distinct", () => {
    // A stack of zones has to be readable by timeframe, not one violet blur.
    for (const k of ["v2BullD", "v2BearD", "v2Bull4H", "v2Bear4H"]) {
      expect(chart).toContain(`${k}:`);
    }
    const d = chart.match(/v2BullD:\s*"([^"]+)"/)?.[1];
    const h4 = chart.match(/v2Bull4H:\s*"([^"]+)"/)?.[1];
    expect(d).not.toBe(h4);
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

  it("is actually reachable from the UI", () => {
    // The layer existed, the data reached the chart, and NOTHING DREW — the
    // controlled-mode mapping in Chart.tsx never added 'obV2', so the whole
    // overlay was unreachable. Built and not wired, the exact failure this
    // repo keeps producing. Three links, all required.
    expect(hud).toMatch(/obV2: boolean/);                       // in the model
    expect(hud).toMatch(/key: 'obV2', label: 'OB2'/);           // a chip exists
    expect(page).toMatch(/overlayVisibility\.obV2\) s\.add\('obV2'\)/); // mapped through
  });

  it("is off by default — it is a debug overlay, not furniture", () => {
    const defaults = hud.slice(hud.indexOf("DEFAULT_VISIBILITY"), hud.indexOf("DEFAULT_VISIBILITY") + 400);
    expect(defaults).toMatch(/obV2:\s*false/);
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
