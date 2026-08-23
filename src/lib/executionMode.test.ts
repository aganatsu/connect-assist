import { describe, expect, it } from "vitest";
import {
  canUseTradingControls,
  type ExecutionMode,
  requireFreshTradingTruth,
  requirePersistedExecutionMode,
  verifyExecutionModeChange,
} from "./executionMode";

describe("canUseTradingControls", () => {
  it("fails closed when the account mode or any active broker state is unknown", () => {
    expect(canUseTradingControls("unknown", [true])).toBe(false);
    expect(canUseTradingControls("live", [])).toBe(false);
    expect(canUseTradingControls("live", [true, false])).toBe(false);
  });

  it("allows a known paper account or fully known live accounts", () => {
    expect(canUseTradingControls("paper", [])).toBe(true);
    expect(canUseTradingControls("live", [true, true])).toBe(true);
  });
});

describe("requireFreshTradingTruth", () => {
  function readers(overrides: Partial<Parameters<typeof requireFreshTradingTruth>[0]> = {}) {
    return {
      readPaperStatus: async () => ({ ok: true, state: "available", executionMode: "live" }),
      listBrokerConnections: async () => [
        { id: "broker-1", is_active: true, display_name: "Primary" },
        { id: "broker-2", is_active: true, display_name: "Secondary" },
      ],
      readBrokerConnectionStatus: async () => ({ ready: true }),
      readBrokerAccount: async () => ({ balance: 10_000 }),
      readBrokerOpenTrades: async () => [],
      ...overrides,
    };
  }

  it("re-reads every active broker before a live mutation", async () => {
    const connectionReads: string[] = [];
    const accountReads: string[] = [];
    const positionReads: string[] = [];
    const result = await requireFreshTradingTruth(readers({
      readBrokerConnectionStatus: async (id) => {
        connectionReads.push(id);
        return { ready: true };
      },
      readBrokerAccount: async (id) => {
        accountReads.push(id);
        return { balance: 10_000 };
      },
      readBrokerOpenTrades: async (id) => {
        positionReads.push(id);
        return [];
      },
    }));
    expect(result.mode).toBe("live");
    expect(connectionReads).toEqual(["broker-1", "broker-2"]);
    expect(accountReads).toEqual(["broker-1", "broker-2"]);
    expect(positionReads).toEqual(["broker-1", "broker-2"]);
  });

  it("fails closed when any active broker is not ready", async () => {
    await expect(requireFreshTradingTruth(readers({
      readBrokerConnectionStatus: async (id) => ({ ready: id !== "broker-2" }),
    }))).rejects.toThrow("Secondary is not ready");
  });

  it("does not make paper-only mutations depend on broker reads", async () => {
    let brokerListReads = 0;
    const result = await requireFreshTradingTruth(readers({
      readPaperStatus: async () => ({ ok: true, state: "available", executionMode: "paper" }),
      listBrokerConnections: async () => {
        brokerListReads += 1;
        throw new Error("broker offline");
      },
    }));
    expect(result.mode).toBe("paper");
    expect(brokerListReads).toBe(0);
  });

  it("blocks a live-to-paper switch while a broker still has positions", async () => {
    await expect(requireFreshTradingTruth(readers({
      readBrokerOpenTrades: async () => [{ id: "open-1" }],
    }), { targetMode: "paper" })).rejects.toThrow(
      "Close all live broker positions",
    );
  });

  it("checks brokers before enabling live from paper mode", async () => {
    let brokerListReads = 0;
    await requireFreshTradingTruth(readers({
      readPaperStatus: async () => ({ ok: true, state: "available", executionMode: "paper" }),
      listBrokerConnections: async () => {
        brokerListReads += 1;
        return [{ id: "broker-1", is_active: true }];
      },
    }), { targetMode: "live" });
    expect(brokerListReads).toBe(1);
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
