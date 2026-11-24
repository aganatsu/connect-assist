import { describe, it, expect } from "vitest";
import { saveRange, restoreRange, barSpacingSec, tradeShapeKey } from "@/lib/chartRange";

describe("chartRange — zoom survives a rebuild", () => {
  it("restores the same window on the same chart", () => {
    const saved = saveRange("GBP/NZD|3600|", 500, { from: 420, to: 470 });
    expect(restoreRange(saved, "GBP/NZD|3600|", 500)).toEqual({ from: 420, to: 470 });
  });
  it("a new candle keeps the window anchored to the newest bar", () => {
    const saved = saveRange("k", 500, { from: 440, to: 506 });
    expect(restoreRange(saved, "k", 501)).toEqual({ from: 441, to: 507 });
  });
  it("another pair, timeframe or trade gets the default view", () => {
    const saved = saveRange("GBP/NZD|3600|", 500, { from: 420, to: 470 });
    expect(restoreRange(saved, "EUR/USD|3600|", 500)).toBeNull();
    expect(restoreRange(saved, "GBP/NZD|900|", 500)).toBeNull();
    expect(restoreRange(saved, "GBP/NZD|3600|t1", 500)).toBeNull();
    expect(restoreRange(null, "k", 500)).toBeNull();
  });
  it("bar spacing ignores weekend gaps", () => {
    expect(barSpacingSec([0, 3600, 7200, 7200 + 49 * 3600, 7200 + 50 * 3600])).toBe(3600);
    expect(barSpacingSec([100])).toBe(0);
  });
  it("an open trade's running R / price / P&L don't change its shape; a closed trade's R does", () => {
    const open = { id: "a", status: "open", entryPrice: 1.1, r: 0.3, exitPrice: 1.101, pnl: 5 };
    expect(tradeShapeKey(open)).toBe(tradeShapeKey({ ...open, r: -0.4, exitPrice: 1.099, pnl: -7 }));
    expect(tradeShapeKey(open)).not.toBe(tradeShapeKey({ ...open, sl: 1.09 }));
    const closed = { ...open, status: "closed" };
    expect(tradeShapeKey(closed)).not.toBe(tradeShapeKey({ ...closed, r: -1 }));
  });
});
