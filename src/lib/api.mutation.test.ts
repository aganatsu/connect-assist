import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokerExecApi, invokeFunction, paperApi } from "./api";

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

function edgeResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 500 ? "Service Unavailable" : "OK",
    headers: { "Content-Type": "application/json" },
  });
}

describe("edge function retry safety", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["place_order", () => brokerExecApi.placeOrder("connection-1", {
      symbol: "EUR/USD",
      direction: "long",
      size: 0.1,
    })],
    ["close_trade", () => brokerExecApi.closeTrade("connection-1", "trade-1")],
    ["modify_trade", () => brokerExecApi.modifyTrade(
      "connection-1",
      "trade-1",
      { stopLoss: 1.2 },
    )],
  ])("does not retry an uncertain broker %s mutation", async (_action, invoke) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, {
        ok: true,
        brokerExecutionStatus: "succeeded",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(invoke()).rejects.toThrow(
      "Broker execution outcome is unknown. Check broker state before retrying.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an uncertain paper account mutation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(paperApi.startEngine()).rejects.toThrow(
      "Request outcome is unknown. Check account state before retrying.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unclassified control mutation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeFunction("scheduled-tasks", {
      action: "update",
      taskId: "task-1",
    })).rejects.toThrow(
      "Request outcome is unknown. Check current state before retrying.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a broker transport failure as an uncertain one-shot mutation", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerExecApi.closeTrade("connection-1", "trade-1"))
      .rejects.toThrow(
        "Broker execution outcome is unknown. Check broker state before retrying.",
      );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues retrying a proven read after a transient failure", async () => {
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

  it("does not replay a mutation after a dispatched authentication rejection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(401, { error: "Invalid JWT" }))
      .mockResolvedValueOnce(edgeResponse(200, {
        ok: true,
        brokerExecutionStatus: "succeeded",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerExecApi.placeOrder("connection-1", {
      symbol: "EUR/USD",
      direction: "long",
      size: 0.1,
    })).rejects.toThrow(
      "Request was not authorized. Your session is valid; retry the action manually.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a read cooldown suppress a later broker mutation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(503, { error: "worker terminated" }))
      .mockResolvedValueOnce(edgeResponse(200, {
        ok: true,
        brokerExecutionStatus: "succeeded",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const readRequest = brokerExecApi.openTrades("cooldown-connection");
    await vi.runAllTimersAsync();
    await expect(readRequest).resolves.toEqual([]);

    await expect(brokerExecApi.placeOrder("cooldown-connection", {
      symbol: "EUR/USD",
      direction: "long",
      size: 0.1,
    })).resolves.toMatchObject({ brokerExecutionStatus: "succeeded" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
