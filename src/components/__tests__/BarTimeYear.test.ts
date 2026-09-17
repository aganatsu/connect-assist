import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fmtBarTime } from "@/components/ZoneStoryPanel";

/**
 * Order blocks cross the new year; Zone Story bars do not.
 *
 * fmtBarTime omitted the year, which is right for a panel that only ever shows
 * recent bars. V2 blocks persist for months — the live data has Daily blocks
 * originating 2025-11-15 and 2025-12-17 — so "15 Nov" cannot be located on a
 * chart without knowing which November it means.
 */

const thisYear = new Date().getFullYear();

describe("fmtBarTime year handling", () => {
  it("omits the year by default, as Zone Story expects", () => {
    expect(fmtBarTime(`${thisYear}-05-11T09:00`, "4h")).toBe("11 May 09:00");
    expect(fmtBarTime(`${thisYear - 1}-11-15T00:00`, "4h")).toBe("15 Nov 00:00");
  });

  it("appends the year when the bar is from an earlier one", () => {
    const y = thisYear - 1;
    expect(fmtBarTime(`${y}-11-15T00:00`, "1d", false, true)).toBe(`15 Nov ${y}`);
    expect(fmtBarTime(`${y}-12-17T21:00`, "4h", false, true)).toBe(`17 Dec ${y} 21:00`);
  });

  it("stays quiet for bars in the current year", () => {
    expect(fmtBarTime(`${thisYear}-05-01T00:00`, "1d", false, true)).toBe("1 May");
    expect(fmtBarTime(`${thisYear}-05-11T09:00`, "4h", false, true)).toBe("11 May 09:00");
  });

  it("drops the time on Daily bars, which are all stamped 00:00", () => {
    expect(fmtBarTime(`${thisYear}-05-01T00:00`, "1d")).toBe("1 May");
    expect(fmtBarTime(`${thisYear}-05-01T00:00`, "4h")).toBe("1 May 00:00");
  });

  it("does not go through Date for parsing", () => {
    // new Date(iso).toLocaleString() renders in the BROWSER's timezone, so the
    // same bar reads differently depending on where the dashboard is opened —
    // the shape of the TwelveData bug. The only Date use is reading the
    // current year.
    const src = readFileSync("src/components/ZoneStoryPanel.tsx", "utf8");
    const i = src.indexOf("export function fmtBarTime");
    const fn = src.slice(i, src.indexOf("\n}", i));
    expect(fn).toMatch(/new Date\(\)\.getFullYear\(\)/);
    expect(fn).not.toMatch(/new Date\(iso\)/);
    expect(fn).not.toMatch(/toLocale/);
  });

  it("the V2 panel and the chart label both ask for the year", () => {
    const botView = readFileSync("src/pages/BotView.tsx", "utf8");
    expect(botView).toMatch(/fmtBarTime\(b\.originTime, b\.tf, false, true\)/);
    const chart = readFileSync("src/components/SMCChart.tsx", "utf8");
    const i = chart.indexOf("const shortDate");
    const fn = chart.slice(i, i + 700);
    expect(fn).toMatch(/new Date\(\)\.getFullYear\(\)/);
    expect(fn).not.toMatch(/toLocaleDateString/);
  });
});
