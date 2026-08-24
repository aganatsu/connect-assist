import { describe, expect, it } from "vitest";
import {
  pendingOrderDisplayStage,
  pendingOrderDistancePrice,
} from "./pendingOrderDisplay";

describe("pendingOrderDisplayStage", () => {
  it("keeps a frozen retracement visible even if the outer status was reset", () => {
    expect(pendingOrderDisplayStage({
      status: "pending",
      post_confirmation_entry: { state: "awaiting_retracement" },
    })).toBe("retracement");
  });

  it("keeps a retracement-ready row active until final authorization resolves it", () => {
    expect(pendingOrderDisplayStage({
      status: "awaiting_confirmation",
      post_confirmation_entry: { state: "ready" },
    })).toBe("retracement");
  });

  it("preserves ordinary waiting, confirmation, and terminal projections", () => {
    expect(pendingOrderDisplayStage({ status: "pending" })).toBe("watching");
    expect(pendingOrderDisplayStage({ status: "awaiting_confirmation" })).toBe("confirmation");
    expect(pendingOrderDisplayStage({ status: "expired" })).toBe("history");
  });

  it("keeps terminal rows in history when they retain a post-confirmation payload", () => {
    expect(pendingOrderDisplayStage({
      status: "expired",
      post_confirmation_entry: { state: "awaiting_retracement" },
    })).toBe("history");
  });
});


describe("pendingOrderDistancePrice", () => {
  const order = {
    current_price: 1.08,
    entry_price: 1.15,
    entry_zone_low: 1.1,
    entry_zone_high: 1.2,
  };

  it("preserves current-to-entry distance for legacy routes", () => {
    expect(pendingOrderDistancePrice(order, "entry")).toBeCloseTo(0.07);
  });

  it("measures exact distance to the outer zone and returns zero inside", () => {
    expect(pendingOrderDistancePrice(order, "outer_zone")).toBeCloseTo(0.02);
    expect(pendingOrderDistancePrice({ ...order, current_price: 1.15 }, "outer_zone")).toBe(0);
    expect(pendingOrderDistancePrice({ ...order, current_price: 1.23 }, "outer_zone")).toBeCloseTo(0.03);
  });
});
