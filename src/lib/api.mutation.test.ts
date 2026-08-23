import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  botConfigApi,
  brokerApi,
  brokerExecApi,
  invokeFunction,
  paperApi,
} from "./api";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: `header.${
              btoa(JSON.stringify({
                sub: "user-1",
                exp: Math.floor(Date.now() / 1000) + 3600,
              }))
            }.signature`,
          },
        },
      })),
      refreshSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: `header.${
              btoa(JSON.stringify({
                sub: "user-1",
                exp: Math.floor(Date.now() / 1000) + 3600,
              }))
            }.signature`,
          },
        },
        error: null,
      })),
      signOut: vi.fn(),
    },
  },
}));

function edgeResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 500 ? "Service Unavailable" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

const paperStatus = (mode: "paper" | "live" = "paper") => ({
  ok: true,
  state: "available",
  executionMode: mode,
  balance: 10_000,
  positions: [],
  tradeHistory: [],
});

function requestBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit)?.body || "{}"));
}

function functionName(call: unknown[]): string {
  return String(call[0]).split("/").pop() || "";
}

describe("edge function retry safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["place_order", "close_trade", "modify_trade"])(
    "does not retry an uncertain broker %s mutation",
    async (action) => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
        .mockResolvedValueOnce(edgeResponse(200, {
          ok: true,
          brokerExecutionStatus: "succeeded",
        }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(invokeFunction("broker-execute", {
        action,
        connectionId: "connection-1",
      })).rejects.toThrow(
        "Broker execution outcome is unknown. Check broker state before retrying.",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry an uncertain paper account mutation after preflight", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(200, paperStatus()))
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(paperApi.startEngine()).rejects.toThrow(
      "Request outcome is unknown. Check account state before retrying.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["scheduled-task list", "scheduled-tasks", { action: "list" }],
    ["backtest status maintenance", "backtest-engine", { action: "status", runId: "run-1" }],
  ])(
    "does not retry the stateful %s action",
    async (_label, edgeFunction, body) => {
      const fetchMock = vi.fn(async () =>
        edgeResponse(503, { error: "worker terminated" })
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(invokeFunction(edgeFunction, body)).rejects.toThrow(
        "Request outcome is unknown. Check current state before retrying.",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not replay status processing that can close positions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, paperStatus()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeFunction("paper-trading", {
      action: "status",
      processEngine: true,
    })).rejects.toThrow(
      "Request outcome is unknown. Check account state before retrying.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a plain paper status read after a transient 503", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, paperStatus()));
    vi.stubGlobal("fetch", fetchMock);

    const request = paperApi.status();
    await vi.runAllTimersAsync();

    await expect(request).resolves.toMatchObject({ executionMode: "paper" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replays a plain paper status read after refreshing app authentication", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(401, { error: "Invalid JWT" }))
      .mockResolvedValueOnce(edgeResponse(200, paperStatus()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(paperApi.status()).resolves.toMatchObject({ executionMode: "paper" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("does not treat an OANDA upstream 401 as app authentication failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(edgeResponse(401, {
      ok: false,
      state: "unknown",
      errorOrigin: "broker",
      broker: "oanda",
      brokerStatus: 401,
      error: "OANDA error: 401",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerExecApi.accountSummary("connection-1"))
      .rejects.toThrow("OANDA error: 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("does not treat a MetaAPI upstream 401 as app authentication failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(edgeResponse(424, {
      ok: false,
      state: "unknown",
      errorOrigin: "broker",
      broker: "metaapi",
      brokerStatus: 401,
      error: "MetaAPI error: 401",
      details: "Unauthorized",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerExecApi.accountSummary("connection-1"))
      .rejects.toThrow("MetaAPI error: 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    ["list_symbols", () => brokerApi.listSymbols("connection-1")],
    ["test", () => brokerApi.test("connection-1")],
    ["probe_symbols", () => brokerApi.probeSymbols("connection-1", ["EURUSD"])],
    ["auto_map_symbols", () => brokerApi.autoMapSymbols("connection-1")],
  ])(
    "keeps valid app auth intact when broker-connections %s receives a broker 401",
    async (action, request) => {
      const fetchMock = vi.fn(async (...args: unknown[]) => {
        const body = requestBody(args);
        if (
          functionName(args) === "paper-trading" &&
          body.action === "status"
        ) {
          return edgeResponse(200, paperStatus("paper"));
        }
        return edgeResponse(401, {
          success: false,
          errorOrigin: "broker",
          broker: "metaapi",
          brokerStatus: 401,
          error: "MetaAPI error: 401 Unauthorized",
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(request()).rejects.toThrow("MetaAPI error: 401 Unauthorized");
      expect(
        fetchMock.mock.calls
          .map((call) => requestBody(call).action)
          .filter((requestedAction) => requestedAction === action),
      ).toHaveLength(1);
      expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
      expect(supabase.auth.signOut).not.toHaveBeenCalled();
    },
  );

  it("re-reads live broker truth before a nested position update", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading" && body.action === "status") {
        return edgeResponse(200, paperStatus("live"));
      }
      if (edgeFunction === "broker-connections") {
        return edgeResponse(200, [{ id: "broker-1", is_active: true }]);
      }
      if (body.action === "connection_status") return edgeResponse(200, { ready: true });
      if (body.action === "account_summary") return edgeResponse(200, { balance: 10_000 });
      if (body.action === "open_trades") return edgeResponse(200, []);
      if (edgeFunction === "paper-trading" && body.action === "update_position") {
        return edgeResponse(200, { success: true });
      }
      throw new Error(`Unexpected request: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(paperApi.updatePosition("position-1", { stopLoss: 1.2 }))
      .resolves.toMatchObject({ success: true });
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action)).toEqual([
      "status",
      "list",
      "connection_status",
      "account_summary",
      "open_trades",
      "update_position",
    ]);
  });

  it("blocks a live config mutation before dispatch when fresh broker truth fails", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading") return edgeResponse(200, paperStatus("live"));
      if (edgeFunction === "broker-connections") {
        return edgeResponse(200, [{ id: "broker-1", is_active: true, display_name: "Primary" }]);
      }
      if (body.action === "connection_status") return edgeResponse(200, { ready: true });
      if (body.action === "account_summary") {
        return edgeResponse(424, {
          errorOrigin: "broker",
          brokerStatus: 401,
          error: "OANDA error: 401",
        });
      }
      if (body.action === "open_trades") return edgeResponse(200, []);
      throw new Error(`Mutation was dispatched: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(botConfigApi.update({ riskPerTrade: 1 }))
      .rejects.toThrow("OANDA error: 401");
    expect(fetchMock.mock.calls.some((call) =>
      functionName(call) === "bot-config" && requestBody(call).action === "update"
    )).toBe(false);
  });

  it.each([
    ["pause_engine", () => paperApi.pauseEngine()],
    ["stop_engine", () => paperApi.stopEngine()],
    ["kill_switch", () => paperApi.killSwitch(true)],
  ])("keeps emergency %s available without a truth preflight", async (action, mutate) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(edgeResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mutate()).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock.mock.calls[0]).action).toBe(action);
  });

  it("requires fresh truth before deactivating the kill switch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(200, paperStatus("paper")))
      .mockResolvedValueOnce(edgeResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await paperApi.killSwitch(false);
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action)).toEqual([
      "status",
      "kill_switch",
    ]);
  });

  it("closes a known paper position without an aggregate truth preflight", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(edgeResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(paperApi.closePosition("position-1"))
      .resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock.mock.calls[0]).action).toBe("close_position");
  });

  it("closes a known broker trade without an aggregate truth preflight", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(edgeResponse(200, {
      ok: true,
      brokerExecutionStatus: "succeeded",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerExecApi.closeTrade("broker-1", "trade-1"))
      .resolves.toMatchObject({ brokerExecutionStatus: "succeeded" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock.mock.calls[0]).action).toBe("close_trade");
  });

  it.each([
    ["place_order", () => brokerExecApi.placeOrder("broker-1", {
      symbol: "EUR/USD",
      direction: "long",
      size: 0.1,
    })],
    ["modify_trade", () => brokerExecApi.modifyTrade(
      "broker-1",
      "trade-1",
      { stopLoss: 1.2 },
    )],
  ])("checks the targeted broker before a paper-mode %s", async (action, mutate) => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading" && body.action === "status") {
        return edgeResponse(200, paperStatus("paper"));
      }
      if (edgeFunction === "broker-connections") {
        return edgeResponse(200, [{ id: "broker-1", is_active: true }]);
      }
      if (body.action === "connection_status") return edgeResponse(200, { ready: true });
      if (body.action === "account_summary") return edgeResponse(200, { balance: 10_000 });
      if (body.action === "open_trades") return edgeResponse(200, []);
      if (body.action === action) {
        return edgeResponse(200, { ok: true, brokerExecutionStatus: "succeeded" });
      }
      throw new Error(`Unexpected request: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(mutate()).resolves.toMatchObject({ brokerExecutionStatus: "succeeded" });
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action)).toEqual([
      "status",
      "list",
      "connection_status",
      "account_summary",
      "open_trades",
      action,
    ]);
  });

  it("rejects a broker order when its target connection is not active", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading" && body.action === "status") {
        return edgeResponse(200, paperStatus("paper"));
      }
      if (edgeFunction === "broker-connections") {
        return edgeResponse(200, [{ id: "broker-1", is_active: true }]);
      }
      throw new Error(`Mutation was dispatched: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerExecApi.placeOrder("broker-missing", {
      symbol: "EUR/USD",
      direction: "long",
      size: 0.1,
    })).rejects.toThrow("requested broker connection is not active");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps broker symbol probes available without an aggregate truth preflight", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(edgeResponse(200, {
      success: true,
      results: { EURUSD: { hasLivePrice: true } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerApi.probeSymbols("broker-1", ["EURUSD"]))
      .resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock.mock.calls[0]).action).toBe("probe_symbols");
  });

  it("requires fresh truth before auto-mapping broker symbols", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading" && body.action === "status") {
        return edgeResponse(200, paperStatus("paper"));
      }
      if (edgeFunction === "broker-connections" && body.action === "auto_map_symbols") {
        return edgeResponse(200, { success: true, mapped: 1 });
      }
      throw new Error(`Unexpected request: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerApi.autoMapSymbols("broker-1"))
      .resolves.toMatchObject({ success: true });
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action)).toEqual([
      "status",
      "auto_map_symbols",
    ]);
  });

  it("switches live to paper using exact exposure reads without readiness reads", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading" && body.action === "status") {
        return edgeResponse(200, {
          ok: true,
          state: "available",
          executionMode: "live",
        });
      }
      if (edgeFunction === "broker-connections" && body.action === "list") {
        return edgeResponse(200, [{ id: "broker-1", is_active: true }]);
      }
      if (edgeFunction === "broker-execute" && body.action === "open_trades") {
        return edgeResponse(200, []);
      }
      if (edgeFunction === "paper-trading" && body.action === "set_execution_mode") {
        return edgeResponse(200, { success: true, executionMode: "paper" });
      }
      throw new Error(`Unexpected request: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(paperApi.setExecutionMode("paper"))
      .resolves.toMatchObject({ success: true, executionMode: "paper" });
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action)).toEqual([
      "status",
      "list",
      "open_trades",
      "set_execution_mode",
    ]);
  });

  it("blocks auto-map when current live broker truth is unavailable", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading" && body.action === "status") {
        return edgeResponse(200, paperStatus("live"));
      }
      if (edgeFunction === "broker-connections" && body.action === "list") {
        return edgeResponse(200, [{ id: "broker-1", is_active: true }]);
      }
      if (edgeFunction === "broker-execute" && body.action === "connection_status") {
        return edgeResponse(424, {
          ok: false,
          state: "unknown",
          errorOrigin: "broker",
          brokerStatus: 401,
          error: "Broker connection status is unavailable",
        });
      }
      if (edgeFunction === "broker-execute" && body.action === "account_summary") {
        return edgeResponse(200, { balance: 10_000 });
      }
      if (edgeFunction === "broker-execute" && body.action === "open_trades") {
        return edgeResponse(200, []);
      }
      if (body.action === "auto_map_symbols") {
        throw new Error("Auto-map mutation was dispatched");
      }
      throw new Error(`Unexpected request: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerApi.autoMapSymbols("broker-1"))
      .rejects.toThrow("Broker connection status is unavailable");
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action))
      .not.toContain("auto_map_symbols");
  });

  it("checks brokers before enabling live while currently in paper mode", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      const edgeFunction = functionName(args);
      if (edgeFunction === "paper-trading" && body.action === "status") {
        return edgeResponse(200, paperStatus("paper"));
      }
      if (edgeFunction === "broker-connections") {
        return edgeResponse(200, [{ id: "broker-1", is_active: true }]);
      }
      if (body.action === "connection_status") return edgeResponse(200, { ready: true });
      if (body.action === "account_summary") return edgeResponse(200, { balance: 10_000 });
      if (body.action === "open_trades") return edgeResponse(200, []);
      if (body.action === "set_execution_mode") {
        return edgeResponse(200, { success: true, executionMode: "live" });
      }
      throw new Error(`Unexpected request: ${edgeFunction}/${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(paperApi.setExecutionMode("live"))
      .resolves.toMatchObject({ executionMode: "live" });
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action)).toEqual([
      "status",
      "list",
      "connection_status",
      "account_summary",
      "open_trades",
      "set_execution_mode",
    ]);
  });

  it("does not replay a mutation after a dispatched app authentication rejection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(401, { error: "Invalid JWT" }))
      .mockResolvedValueOnce(edgeResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeFunction("broker-execute", {
      action: "place_order",
      connectionId: "connection-1",
    })).rejects.toThrow(
      "Request was not authorized. Your session is valid; retry the action manually.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues retrying a proven broker read after a transient failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, [{ id: "trade-1" }]));
    vi.stubGlobal("fetch", fetchMock);

    const request = brokerExecApi.openTrades("connection-1");
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual([{ id: "trade-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an unavailable fallback after plain status retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      edgeResponse(503, { error: "worker terminated" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = invokeFunction("paper-trading", { action: "status" });
    await vi.runAllTimersAsync();

    await expect(request).resolves.toMatchObject({
      state: "unknown",
      executionMode: "unknown",
      fallback: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("retries a MetaAPI 5xx read and then fails closed as unknown", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => edgeResponse(503, {
      ok: false,
      state: "unknown",
      errorOrigin: "broker",
      broker: "metaapi",
      brokerStatus: 503,
      error: "MetaAPI error: 503",
      details: "Service unavailable",
      fallback: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = brokerExecApi.accountSummary("connection-1");
    const assertion = expect(request).rejects.toThrow(
      "Broker service is temporarily unavailable",
    );
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("does not let one broker-origin read failure suppress a different broker read", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const body = requestBody(args);
      if (body.action === "connection_status") {
        return edgeResponse(503, {
          ok: false,
          state: "unknown",
          errorOrigin: "broker",
          broker: "metaapi",
          brokerStatus: 503,
          error: "MetaAPI error: 503",
          details: "Service unavailable",
          fallback: true,
        });
      }
      if (body.action === "open_trades") {
        return edgeResponse(200, []);
      }
      throw new Error(`Unexpected broker action: ${String(body.action)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const statusRequest = brokerExecApi.connectionStatus("connection-1");
    const statusAssertion = expect(statusRequest).rejects.toThrow(
      "Broker service is temporarily unavailable",
    );
    await vi.runAllTimersAsync();
    await statusAssertion;

    await expect(brokerExecApi.openTrades("connection-1")).resolves.toEqual([]);
    expect(fetchMock.mock.calls.map((call) => requestBody(call).action)).toEqual([
      "connection_status",
      "connection_status",
      "connection_status",
      "connection_status",
      "connection_status",
      "open_trades",
    ]);
  });
});
