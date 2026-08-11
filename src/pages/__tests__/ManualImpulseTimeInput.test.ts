import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A datetime-local input with the time left blank is INVALID, so the browser
 * hands back "" — the dates were being silently discarded and resolution fell
 * back to price matching with no error shown. Daily legs are identified by date
 * alone, so asking for a clock time was friction that produced a silent failure.
 */
const src = readFileSync(
  resolve(__dirname, "../ManualImpulse.tsx"),
  "utf8",
);

/** Mirrors toInstant() in the page. */
function toInstant(value: string): string | null {
  if (!value) return null;
  const withTime = value.length === 10 ? `${value}T12:00` : value;
  const d = new Date(withTime);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

describe("manual impulse time input", () => {
  it("a bare date resolves to midday, not midnight", () => {
    // Feeds disagree on where a daily bar starts (17:00 NY, 00:00 UTC). Midday
    // sits inside the intended session either way; midnight straddles it.
    const iso = toInstant("2026-07-27")!;
    expect(iso).toBeTruthy();
    expect(new Date(iso).getHours()).toBe(12);
  });

  it("a full datetime is passed through", () => {
    const iso = toInstant("2026-07-27T14:30")!;
    expect(new Date(iso).getHours()).toBe(14);
    expect(new Date(iso).getMinutes()).toBe(30);
  });

  it("empty and malformed values yield null, never an Invalid Date", () => {
    expect(toInstant("")).toBeNull();
    expect(toInstant("not-a-date")).toBeNull();
  });

  it("Daily uses a date input; intraday keeps datetime-local", () => {
    expect(src).toContain('type={dateOnly ? "date" : "datetime-local"}');
    expect(src).toContain('const dateOnly = timeframe === "D"');
  });

  it("expiry defaults follow the timeframe", () => {
    // A Daily leg outliving 12 hours is the normal case.
    expect(src).toMatch(/DEFAULT_VALID_HOURS[^=]*=\s*\{\s*D:\s*"168"/);
    expect(src).toContain("setValidHours(DEFAULT_VALID_HOURS[v]");
  });

  it("changing timeframe clears the times rather than sending a stale format", () => {
    const at = src.indexOf("onValueChange={(v) => {");
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, at + 500);
    expect(handler).toContain("setHighTime(\"\")");
    expect(handler).toContain("setLowTime(\"\")");
  });
});
