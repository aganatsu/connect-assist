import { describe, it, expect } from "vitest";
import { buildBotView, directionLines, labelSwings } from "../botView";

describe("labelSwings", () => {
  it("labels against the previous swing of the same type and keeps highs/lows alternating", () => {
    const t = (h: number) => new Date(Date.UTC(2026, 10, 12, h)).toISOString();
    const out = labelSwings([
      { type: "high", price: 177.41, datetime: t(1) },
      { type: "low", price: 177.07, datetime: t(2) },
      { type: "high", price: 177.36, datetime: t(3) },
      { type: "high", price: 177.30, datetime: t(4) },       // less extreme second high → dropped
      { type: "low", price: 177.00, datetime: t(5) },
      { type: "high", price: 177.45, datetime: t(6), significance: "external" },
      { type: "low", price: 177.10, datetime: t(7) },
    ]);
    expect(out.map((s) => s.label)).toEqual(["H", "L", "LH", "LL", "HH", "HL"]);
    expect(out.find((s) => s.label === "HH")?.major).toBe(true);
  });
});

describe("directionLines", () => {
  it("drops the style tag and swing lists, one line per timeframe", () => {
    const r = "[scalper] ✓ 1H bearish → short | 15m: 15m retracing in bearish structure (price 1.42632 above swing low 1.42290, no CHoCH) [15m highs: 1.42655, 1.42708, 1.42700] [15m lows: 1.42290, 1.42619, 1.42648] | 5m: 5m bearish BOS confirmed";
    expect(directionLines(r)).toEqual([
      "1H bearish → short",
      "15m: 15m retracing in bearish structure (price 1.42632 above swing low 1.42290, no CHoCH)",
      "5m: 5m bearish BOS confirmed",
    ]);
  });
});

describe("buildBotView", () => {
  const watching = {
    pair: "XAU/USD", status: "watching_zone",
    simpleDirection: { direction: "short", reason: "[scalper] ✓ 1H bearish → short | 15m: ok" },
    impulseZone: { hasZone: true, selectedTF: "1H", bestZone: { low: 3877.446, high: 3900.71, type: "ob", fibLevel: 0.786, totalScore: 6 } },
    unifiedZone: {
      selectedTF: "1H",
      impulse: { direction: "bearish", high: 3901.178, low: 3833.621, origin: 3901.178, terminus: 3833.621,
        startTime: "2026-11-16T00:00:00Z", endTime: "2026-11-16T05:00:00Z", candleQuality: { bosCloseStrength: 0.94, originCloseStrength: 0.57, bosRejectionWick: 0 } },
      zone: { type: "OB", low: 3877.446, high: 3900.71, fibLabel: "78.6%" },
      entry: { entryPrice: 3893.839, slPrice: 3898.975, tpPrice: null },
      confirmation: { entryReady: false, detail: "Waiting for CHoCH/displacement in bearish direction" },
      price: { distancePips: 340.6 },
    },
  };

  it("reads a watching setup: zone, impulse leg, plan, and what it is waiting for", () => {
    const v = buildBotView(watching, "2026-11-16T15:00:00Z");
    expect(v.decision.tone).toBe("wait");
    expect(v.decision.direction).toBe("short");
    expect(v.zone).toEqual({ low: 3877.446, high: 3900.71, label: "OB @ 78.6%", score: 6 });
    expect(v.impulse).toMatchObject({ direction: "bearish", fromPrice: 3901.178, toPrice: 3833.621, tf: "1H" });
    expect(v.levels).toMatchObject({ entry: 3893.839, sl: 3898.975, tp: null });
    expect(v.decision.breakLine).toBe("Break candle closed 94% toward the move — strong");
    expect(v.decision.waitingFor).toBe("Waiting for CHoCH/displacement in bearish direction");
  });

  it("says a direction refusal plainly and shows the refusal reason", () => {
    const v = buildBotView({
      pair: "EUR/JPY", status: "skipped_no_impulse_zone",
      impulseZone: { hasZone: false, reason: "No direction: [scalper] 1H bullish bias BUT 15m: 15m CHoCH against bullish bias (2 recent bearish CHoCH at 177.15453, 177.07294) → BLOCKED" },
    }, "2026-11-12T02:40:18Z");
    expect(v.decision.tone).toBe("block");
    expect(v.decision.headline).toBe("Blocked — the direction check said no");
    expect(v.decision.directionLines[0]).toContain("15m CHoCH against bullish bias");
    expect(v.zone).toBeNull();
  });

  it("names the failed risk rule on a rejected setup", () => {
    const v = buildBotView({ pair: "BTC/USD", status: "rejected", gates: [{ passed: true, reason: "ok" }, { passed: false, reason: "Already short on BTC/USD — no duplicate" }] }, "2026-11-12T01:45:00Z");
    expect(v.decision.headline).toBe("Skipped — Already short on BTC/USD — no duplicate");
  });
});
