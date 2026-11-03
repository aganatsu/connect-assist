import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
const { foldBreakers, breakerTotals } = await import("@/lib/breakerShadow");

/** Zone Story → Breakers reads the breaker shadow's events; Bot Config → "Breaker Shadow" is the switch the runner reads. */
const Z = "EUR/USD|long|11000.0|11010.0";
const ev = (type: string, arm: string, t: string, payload: Record<string, unknown>) => ({ zone_id: Z, arm, type, t, payload });
const rows = [
  ev("seen", "-", "2026-11-10T07:50:00Z", { zone: { dir: "long", zoneType: "FVG", zl: 1.1, zh: 1.101 } }),
  ev("flipped", "-", "2026-11-10T08:10:00Z", { flipDir: "short", E: 1.1, S: 1.102, T: 1.097 }),
  ev("touched", "C", "2026-11-10T08:20:00Z", {}),
  ev("filled", "L", "2026-11-10T08:20:00Z", { position: { fill: 1.1 } }),
  ev("cancelled", "C", "2026-11-10T08:25:00Z", { reason: "stop_before_entry" }),
  ev("closed", "L", "2026-11-10T08:30:00Z", { result: "TP", net: 1.425 }),
];

describe("breaker shadow", () => {
  it("folds a zone's events: the flip plan and each entry type's outcome", () => {
    const [z] = foldBreakers(rows);
    expect([z.dir, z.zoneType, z.flip?.dir, z.flip?.E, z.flip?.S, z.flip?.T]).toEqual(["long", "FVG", "short", 1.1, 1.102, 1.097]);
    expect([z.arms.C.status, z.arms.C.reason]).toEqual(["cancelled", "stop_before_entry"]);
    expect([z.arms.L.status, z.arms.L.fill, z.arms.L.result, z.arms.L.net]).toEqual(["closed", 1.1, "TP", 1.425]);
  });
  it("leaves out zones that were only seen, and still shows a flip whose 'seen' is older than the query", () => {
    expect(foldBreakers([rows[0]])).toEqual([]);
    const [z] = foldBreakers(rows.slice(1));
    expect([z.dir, z.flip?.dir]).toEqual(["long", "short"]);
  });
  it("totals closed pretend trades per entry type", () => {
    expect(breakerTotals(rows)).toEqual({ C: { n: 0, tp: 0, netR: 0 }, L: { n: 1, tp: 1, netR: 1.425 } });
  });
  it("Bot Config writes strategy.breakerShadowEnabled, off unless set, and the runner reads the same key", () => {
    const ui = readFileSync(resolve(__dirname, "..", "BotConfigModal.tsx"), "utf8");
    const run = readFileSync(resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "breaker", "breakerRun.ts"), "utf8");
    expect(ui).toContain("checked={config.strategy?.breakerShadowEnabled === true} onChange={v => updateField('strategy', 'breakerShadowEnabled', v)}");
    expect(run).toContain("?.strategy?.breakerShadowEnabled) === true");
    expect(ui).toMatch(/\{ tab: "strategy", label: "Breaker Shadow \(flip zones\)"/);
  });
  it("the Breakers section sits under both Zone Story placements", () => {
    const view = readFileSync(resolve(__dirname, "..", "..", "pages", "BotView.tsx"), "utf8");
    expect(view.match(/<V3StoryPanel symbol=\{d\.pair\} \/>\s*<BreakerStoryPanel symbol=\{d\.pair\} \/>/g)?.length).toBe(2);
  });
});
