import { describe, expect, it } from "vitest";
import { closeReasonLabel, rMultiple, timeframeForTrade, toChartTrades, tradeExcursion, tradeStoryStart } from "@/lib/chartTrades";

// The owner's BTC short, 2026-11-17 22:52 → 2026-11-18 14:40, target hit (+$989.76).
const btcSignal = JSON.stringify({
  summary: "1H bearish impulse, supply OB",
  originalSL: 65489.22, originalTP: 63421.56,
  unifiedZone: {
    state: "triggered", selectedTF: "1H",
    impulse: { direction: "bearish", high: 66100, low: 64500, startTime: "2026-11-17T12:00:00Z", endTime: "2026-11-17T19:00:00Z" },
    zone: { low: 64700, high: 64950, type: "ob", fibLabel: "71.0%" },
  },
});
const status = {
  positions: [{
    id: "open-1", symbol: "EUR/USD", direction: "long", entryPrice: 1.1, currentPrice: 1.103,
    stopLoss: 1.098, takeProfit: 1.104, openTime: "2026-11-18T10:00:00Z", pnl: 30, signalReason: "",
  }],
  tradeHistory: [{
    id: "btc-1", symbol: "BTC/USD", direction: "short", entryPrice: 64777.4, exitPrice: 63421.56,
    stopLoss: 65489.22, takeProfit: 63421.56, openTime: "2026-11-17T22:52:02Z", closedAt: "2026-11-18T14:40:02Z",
    closeReason: "tp_hit", pnl: 989.76, signalReason: btcSignal,
  }],
};

describe("toChartTrades", () => {
  const trades = toChartTrades(status);

  it("lists open trades first, then closed", () => {
    expect(trades.map((t) => [t.id, t.status])).toEqual([["open-1", "open"], ["btc-1", "closed"]]);
  });

  it("closed trade: realised R against the planned stop, and the reason", () => {
    const btc = trades[1];
    expect(btc.direction).toBe("short");
    expect(btc.r).toBeCloseTo((64777.4 - 63421.56) / (65489.22 - 64777.4), 6);   // ≈ +1.90R
    expect(btc.closeReason).toBe("tp_hit");
    expect(closeReasonLabel(btc.closeReason)).toBe("Target hit");
  });

  it("closed trade: the impulse and zone come from the record at entry", () => {
    const btc = trades[1];
    expect(btc.impulse).toMatchObject({ direction: "bearish", fromPrice: 66100, toPrice: 64500, fromTime: "2026-11-17T12:00:00Z" });
    expect(btc.zone).toMatchObject({ low: 64700, high: 64950 });
    expect(btc.zone?.label).toContain("71.0%");
  });

  it("open trade: running R from the latest price", () => {
    expect(trades[0].r).toBeCloseTo(1.5, 6);   // +0.003 on a 0.002 risk
    expect(trades[0].impulse).toBeNull();      // no record → nothing drawn, nothing invented
  });

  it("tolerates a missing or empty status", () => {
    expect(toChartTrades(undefined)).toEqual([]);
    expect(toChartTrades({ positions: [{ symbol: "X" }] })).toEqual([]);
  });
});

describe("rMultiple", () => {
  it("is signed by direction and null without a stop", () => {
    expect(rMultiple("long", 100, 102, 99)).toBe(2);
    expect(rMultiple("short", 100, 102, 101)).toBe(-2);
    expect(rMultiple("long", 100, 102, null)).toBeNull();
  });
});

describe("timeframeForTrade", () => {
  const now = Date.parse("2026-11-18T15:00:00Z");
  const at = (h: number) => ({ ...toChartTrades(status)[1], openTime: new Date(now - h * 3_600_000).toISOString() });
  it("picks the finest timeframe whose 500-bar window reaches the entry", () => {
    expect(timeframeForTrade(at(10), now)).toBe("5min");     // 120 bars + 60
    expect(timeframeForTrade(at(16), now)).toBe("5min");     // 192 + 60 = 252 bars
    expect(timeframeForTrade(at(40), now)).toBe("15min");    // 480 5m bars too many; 160 15m bars
    expect(timeframeForTrade(at(200), now)).toBe("1h");
    expect(timeframeForTrade(at(2000), now)).toBe("4h");
  });
  it("reaches back to the impulse the trade was built on, not just the entry", () => {
    // Entered 2h ago on a 1H impulse that started 40h ago: 5M (504 bars) can't show both.
    const t = { ...at(2), impulse: { ...at(2).impulse!, fromTime: new Date(now - 40 * 3_600_000).toISOString() } };
    expect(tradeStoryStart(t)).toBe(t.impulse.fromTime);
    expect(timeframeForTrade(t, now)).toBe("15min");
    // No impulse times recorded → the entry decides.
    const bare = { ...at(2), impulse: null };
    expect(tradeStoryStart(bare)).toBe(bare.openTime);
    expect(timeframeForTrade(bare, now)).toBe("5min");
  });
});

describe("tradeExcursion", () => {
  it("best and worst prices over the candles the trade was open on", () => {
    const btc = toChartTrades(status)[1];
    const candles = [
      { datetime: "2026-11-17T21:00:00Z", high: 99999, low: 1 },        // before entry: ignored
      { datetime: "2026-11-17T22:00:00Z", high: 64900, low: 64700 },    // contains the entry
      { datetime: "2026-11-18T03:00:00Z", high: 65200, low: 64300 },
      { datetime: "2026-11-18T14:00:00Z", high: 64000, low: 63400 },    // contains the exit
      { datetime: "2026-11-18T15:00:00Z", high: 99999, low: 1 },        // after exit: ignored
    ];
    const ex = tradeExcursion(btc, candles)!;
    expect(ex.best).toBe(63400);    // short: lowest low
    expect(ex.worst).toBe(65200);   // short: highest high
    expect(ex.worstR).toBeLessThan(0);
    expect(ex.bestR).toBeGreaterThan(1.9);
  });
});
