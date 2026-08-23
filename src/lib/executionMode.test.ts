import { describe, expect, it } from "vitest";
import {
  canUseTradingControls,
  type ExecutionMode,
  requirePersistedExecutionMode,
  verifyExecutionModeChange,
} from "./executionMode";

describe("canUseTradingControls", () => {
  it("fails closed when the account mode or live broker state is unknown", () => {
    expect(canUseTradingControls("unknown", true)).toBe(false);
    expect(canUseTradingControls("live", false)).toBe(false);
  });

  it("allows a known paper account or fully known live account", () => {
    expect(canUseTradingControls("paper", false)).toBe(true);
    expect(canUseTradingControls("live", true)).toBe(true);
  });
});

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

describe("verifyExecutionModeChange", () => {
  it("uses the function's verified response without a status fallback", async () => {
    let statusReads = 0;

    await expect(
      verifyExecutionModeChange(
        { success: true, executionMode: "live" },
        "live",
        async () => {
          statusReads += 1;
          return "paper";
        },
      ),
    ).resolves.toBe("live");
    expect(statusReads).toBe(0);
  });

  it("accepts an ambiguous response only after status confirms persistence", async () => {
    await expect(
      verifyExecutionModeChange(
        { success: true },
        "live",
        async () => "live",
      ),
    ).resolves.toBe("live");
  });

  it("rejects an ambiguous response when status shows the old mode", async () => {
    await expect(
      verifyExecutionModeChange(
        { success: true },
        "live",
        async () => "paper",
      ),
    ).rejects.toThrow("database returned paper");
  });

  it("preserves the original error when status cannot be read", async () => {
    await expect(
      verifyExecutionModeChange(
        { success: true },
        "live",
        async () => {
          throw new Error("status unavailable");
        },
      ),
    ).rejects.toThrow("database returned no value");
  });
});
