import { describe, expect, it } from "vitest";
import { pendingOrderDisplayStage } from "./pendingOrderDisplay";

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
