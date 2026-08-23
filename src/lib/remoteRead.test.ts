import { describe, expect, it } from "vitest";
import {
  requireAvailableCollection,
  requireAvailableObject,
} from "./remoteRead";

describe("remote read truthfulness", () => {
  it("accepts successful collection payloads", () => {
    expect(requireAvailableCollection([{ id: "trade-1" }], "Broker positions"))
      .toEqual([{ id: "trade-1" }]);
  });

  it("rejects unavailable collections instead of converting them to empty", () => {
    expect(() => requireAvailableCollection({
      ok: false,
      fallback: true,
      error: "Broker service is temporarily unavailable",
    }, "Broker positions")).toThrow("temporarily unavailable");
  });

  it("rejects unavailable account objects", () => {
    expect(() => requireAvailableObject({
      ok: false,
      fallback: true,
      error: "Trading account status is unavailable",
    }, "Trading account status")).toThrow("status is unavailable");
    expect(() => requireAvailableObject({ state: "unknown" }, "Broker account"))
      .toThrow("Broker account is unavailable");
  });
});
