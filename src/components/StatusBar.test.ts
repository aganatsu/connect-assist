import { describe, expect, it } from "vitest";
import { getExecutionMode } from "./StatusBar";

describe("StatusBar execution mode", () => {
  it("uses the top-level executionMode returned by paperApi.status", () => {
    expect(getExecutionMode({ executionMode: "live" })).toBe("live");
  });

  it("supports the legacy nested account response", () => {
    expect(getExecutionMode({ account: { execution_mode: "live" } })).toBe("live");
  });

  it("defaults to paper mode", () => {
    expect(getExecutionMode(undefined)).toBe("paper");
  });
});
