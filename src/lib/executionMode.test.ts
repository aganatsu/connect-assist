import { describe, expect, it } from "vitest";
import {
  type ExecutionMode,
  requirePersistedExecutionMode,
} from "./executionMode";

describe("requirePersistedExecutionMode", () => {
  it.each<ExecutionMode>(["paper", "live"])(
    "accepts a persisted %s response",
    (mode) => {
      expect(
        requirePersistedExecutionMode(
          { success: true, executionMode: mode },
          mode,
        ),
      ).toBe(mode);
    },
  );

  it("rejects transient fallback responses", () => {
    expect(() =>
      requirePersistedExecutionMode(
        {
          success: false,
          fallback: true,
          error: "Temporarily unavailable",
        },
        "live",
      )
    ).toThrow("Temporarily unavailable");
  });

  it("rejects ambiguous success responses", () => {
    expect(() => requirePersistedExecutionMode({ success: true }, "live"))
      .toThrow("database returned no value");
  });

  it("rejects a database value that differs from the request", () => {
    expect(() =>
      requirePersistedExecutionMode(
        { success: true, executionMode: "paper" },
        "live",
      )
    ).toThrow("requested live");
  });
});
