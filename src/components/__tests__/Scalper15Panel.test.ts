import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scalper15Headline } from "@/lib/scalper15";

/** Scan → Detail Breakdown shows Scalper15's own decision; Bot Config → "15m Impulse Scalper" is the switch bot-scanner reads. */
const read = (...p: string[]) => readFileSync(resolve(__dirname, ...p), "utf8");

describe("Scalper15 panel", () => {
  it("headline: the skip reason without its prefix, or the placement line when an order went in", () => {
    expect(scalper15Headline("scalper15_no_order", { bias: 0 }, "Scalper15: no 1H direction (no close beyond a confirmed 1H swing yet)"))
      .toBe("no 1H direction (no close beyond a confirmed 1H swing yet)");
    expect(scalper15Headline("scalper15_order_placed", { bias: 1 }, undefined, "Scalper15: LONG 15m OB 1.0848–1.0854 · SL 1.0847"))
      .toBe("LONG 15m OB 1.0848–1.0854 · SL 1.0847");
    // a risk-gate skip carries its reason in skipReason too
    expect(scalper15Headline("scalper15_risk_blocked", { bias: -1 }, "Scalper15: Max open positions reached")).toBe("Max open positions reached");
    expect(scalper15Headline("paused", {}, undefined, undefined)).toBe("no decision recorded");
  });

  it("the scan detail renders it whenever the row carries Scalper15 data, above the factor list", () => {
    const view = read("..", "..", "pages", "BotView.tsx");
    const start = view.indexOf("function ScanDetailInline");
    const body = view.slice(start);
    const panel = body.indexOf("{d.scalper15 && <Scalper15Panel status={d.status} s={d.scalper15} skipReason={d.skipReason} reason={d.reason} />}");
    expect(panel).toBeGreaterThan(-1);
    expect(panel).toBeLessThan(body.indexOf("<FactorBreakdown"));
    expect(view).toContain("scalper15_order_placed: 2,");
  });

  it("Bot Config writes strategy.scalper15Enabled, off unless set, the scanner reads the same key, and search finds it", () => {
    const ui = read("..", "BotConfigModal.tsx");
    const shared = read("..", "..", "..", "supabase", "functions", "_shared", "scalper15.ts");
    expect(ui).toContain("checked={config.strategy?.scalper15Enabled === true} onChange={v => updateField('strategy', 'scalper15Enabled', v)}");
    expect(shared).toContain("enabled: s.scalper15Enabled === true");
    expect(ui).toMatch(/\{ tab: "strategy", label: "15m Impulse Scalper \(Scalper15\)"/);
  });
});
