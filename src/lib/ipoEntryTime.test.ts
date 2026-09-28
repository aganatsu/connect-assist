/**
 * F · The UI must render the precise entry time and must never round it back
 * to the strategy timeframe.
 *
 * The display layer is where the bug was actually VISIBLE: the runner had the
 * minute in three of eighteen closed rows and the panel showed the bar anyway,
 * because every call site read `entry_time`. These tests pin the contract that
 * `IpoPaperMonitor` and `IpoScanDetail` both go through.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  entryInstant, strategyBar, entryPrecision, entryDiffersFromBar,
  formatInstant, precisionNote,
} from "./ipoEntryTime";

describe("entryInstant", () => {
  it("prefers the proven minute over the bar", () => {
    expect(entryInstant({
      entry_time: "2026-09-27T15:00:00+00:00",
      strategy_bar_time: "2026-09-27T15:00:00+00:00",
      entry_minute_time: "2026-09-27T15:37:00+00:00",
    })).toBe("2026-09-27T15:37:00+00:00");
  });

  it("reads the minute even on a row written before the repointing migration", () => {
    // These rows exist in production today: entry_minute_time was recorded but
    // entry_time still held the bar. Reading entry_time first would show 11:00.
    expect(entryInstant({
      entry_time: "2026-09-25T11:00:00+00:00",
      entry_minute_time: "2026-09-25T11:10:00+00:00",
    })).toBe("2026-09-25T11:10:00+00:00");
  });

  it("falls back to entry_time when no minute was ever proven", () => {
    expect(entryInstant({ entry_time: "2026-09-23T14:00:00+00:00" }))
      .toBe("2026-09-23T14:00:00+00:00");
  });
});

describe("precision labelling", () => {
  it("a stamped row is `minute`", () => {
    expect(entryPrecision({
      entry_time: "2026-09-27T15:37:00Z", entry_minute_time: "2026-09-27T15:37:00Z",
    })).toBe("minute");
  });

  it("a legacy row is `strategy_bar` and says so, rather than claiming exactness", () => {
    const legacy = { entry_time: "2026-09-23T14:00:00+00:00" };
    expect(entryPrecision(legacy)).toBe("strategy_bar");
    expect(precisionNote(legacy)).toMatch(/strategy bar/i);
  });

  it("a stamped row carries no caveat", () => {
    expect(precisionNote({
      entry_time: "2026-09-27T15:37:00Z", entry_minute_time: "2026-09-27T15:37:00Z",
    })).toBe("");
  });

  it("entry exactly at the bar open is still `minute` when the tape proved it", () => {
    // Case D. The rendered string equals the bar, but it is not a fallback, and
    // the panel must not caveat it.
    const r = {
      entry_time: "2026-09-27T13:00:00+00:00",
      strategy_bar_time: "2026-09-27T13:00:00+00:00",
      entry_minute_time: "2026-09-27T13:00:00+00:00",
    };
    expect(entryPrecision(r)).toBe("minute");
    expect(entryDiffersFromBar(r)).toBe(false);
    expect(precisionNote(r)).toBe("");
  });
});

describe("strategyBar", () => {
  it("returns the parent bar alongside a narrowed entry", () => {
    const r = {
      entry_time: "2026-09-27T15:37:00+00:00",
      strategy_bar_time: "2026-09-27T15:00:00+00:00",
      entry_minute_time: "2026-09-27T15:37:00+00:00",
    };
    expect(strategyBar(r)).toBe("2026-09-27T15:00:00+00:00");
    expect(entryDiffersFromBar(r)).toBe(true);
  });

  it("a legacy row's entry_time IS its strategy bar", () => {
    expect(strategyBar({ entry_time: "2026-09-23T14:00:00+00:00" }))
      .toBe("2026-09-23T14:00:00+00:00");
  });
});

describe("formatInstant", () => {
  it("renders the minute, not the strategy-timeframe boundary", () => {
    expect(formatInstant("2026-09-27T15:37:00+00:00")).toBe("2026-09-27 15:37");
  });

  it("keeps seconds when the source carries them", () => {
    expect(formatInstant("2026-09-27T15:37:42+00:00")).toBe("2026-09-27 15:37:42");
  });

  it("converts to UTC without losing the minute", () => {
    // +02:00 local 17:37 is 15:37Z. A zone conversion that rounded or shifted
    // the minute would be a silent misreport of the execution moment.
    expect(formatInstant("2026-09-27T17:37:00+02:00")).toBe("2026-09-27 15:37");
  });

  it("is blank for missing or unparseable values rather than inventing one", () => {
    expect(formatInstant(null)).toBe("—");
    expect(formatInstant(undefined)).toBe("—");
    expect(formatInstant("not a date")).toBe("—");
  });
});

describe("the panels actually go through this module", () => {
  // A guard against the regression returning by the same route it arrived:
  // someone adding `clock(x.entry_time)` back under an "entry time" label.
  const PANELS = [
    "src/components/IpoPaperMonitor.tsx",
    "src/components/IpoScanDetail.tsx",
  ];

  it.each(PANELS)("%s imports the entry-time helpers", (file) => {
    expect(readFileSync(file, "utf8")).toContain("@/lib/ipoEntryTime");
  });

  it.each(PANELS)("%s renders no entry-time label straight off entry_time", (file) => {
    const src = readFileSync(file, "utf8");
    // Any label containing "entry time" whose value expression reads
    // `.entry_time` directly instead of going through entryInstant().
    const offenders = [...src.matchAll(/entry time[^\n]*\n?[^\n]*/gi)]
      .map((m) => m[0])
      .filter((s) => /\.entry_time\b/.test(s) && !/entryInstant/.test(s));
    expect(offenders, "use entryInstant(row), not row.entry_time").toEqual([]);
  });
});
