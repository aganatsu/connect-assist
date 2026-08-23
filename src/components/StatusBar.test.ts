import { describe, expect, it } from "vitest";
import { getExecutionMode } from "./StatusBar";

describe("StatusBar execution mode", () => {
  it("uses the top-level executionMode returned by paperApi.status", () => {
    expect(getExecutionMode({ executionMode: "live" })).toBe("live");
  });

  it("supports the legacy nested account response", () => {
    expect(getExecutionMode({ account: { execution_mode: "live" } })).toBe("live");
  });

  it("reports an unknown mode while status is unavailable", () => {
    expect(getExecutionMode(undefined)).toBe("unknown");
  });

  it("does not trust a cached or fallback execution mode", () => {
    expect(getExecutionMode({ executionMode: "live", fallback: true })).toBe("unknown");
    expect(getExecutionMode({ executionMode: "paper", ok: false })).toBe("unknown");
    expect(getExecutionMode({ executionMode: "live", state: "unknown" })).toBe("unknown");
  });
});
