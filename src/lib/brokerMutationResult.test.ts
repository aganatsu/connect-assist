import { beforeEach, describe, expect, it, vi } from "vitest";
import { brokerExecApi } from "./api";
import { requireConfirmedBrokerMutation } from "./brokerMutationResult";

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
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

function brokerResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFreshLiveTruthThen(mutationResponse: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const functionName = String(input).split("/").pop();
    const body = JSON.parse(String(init?.body || "{}"));

    if (functionName === "paper-trading" && body.action === "status") {
      return brokerResponse({
        ok: true,
        state: "available",
        executionMode: "live",
        balance: 10_000,
        positions: [],
        tradeHistory: [],
      });
    }
    if (functionName === "broker-connections" && body.action === "list") {
      return brokerResponse([{ id: "connection-1", is_active: true }]);
    }
    if (body.action === "connection_status") {
      return brokerResponse({ ok: true, state: "available", ready: true });
    }
    if (body.action === "account_summary") {
      return brokerResponse({ balance: 10_000 });
    }
    if (body.action === "open_trades") {
      return brokerResponse([]);
    }
    return brokerResponse(mutationResponse);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("broker mutation result", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a semantically confirmed broker mutation", () => {
    const result = {
      ok: true,
      brokerExecutionStatus: "succeeded" as const,
    };
    expect(requireConfirmedBrokerMutation(result)).toBe(result);
  });

  it.each([
    {},
    { ok: false },
    { ok: true },
    { brokerExecutionStatus: "succeeded" as const },
  ])(
    "rejects a broker response without the complete success contract",
    (result) => {
      expect(() => requireConfirmedBrokerMutation(result)).toThrow(
        "Broker execution outcome is unknown. Check broker state before retrying.",
      );
    },
  );

  it.each([
    {
      brokerExecutionStatus: "rejected" as const,
      error: "TRADE_RETCODE_INVALID_STOPS: Invalid stops",
    },
    {
      brokerExecutionStatus: "uncertain" as const,
      error: "MetaAPI returned an empty response",
      fallback: true,
    },
    {
      error: "Broker execution could not be confirmed",
      fallback: true,
    },
  ])("rejects failed or uncertain results", (result) => {
    expect(() => requireConfirmedBrokerMutation(result)).toThrow(
      String(result.error),
    );
  });

  it("routes an uncertain place-order response to the mutation error path", async () => {
    stubFreshLiveTruthThen({
      ok: false,
      brokerExecutionStatus: "uncertain",
      fallback: true,
    });

    await expect(brokerExecApi.placeOrder("connection-1", {
      symbol: "EUR/USD",
      direction: "long",
      size: 0.1,
    })).rejects.toThrow(
      "Broker execution outcome is unknown. Check broker state before retrying.",
    );
  });

  it("routes a rejected close response to the mutation error path", async () => {
    stubFreshLiveTruthThen({
      ok: false,
      brokerExecutionStatus: "rejected",
      error: "TRADE_RETCODE_INVALID_STOPS: Invalid stops",
    });

    await expect(brokerExecApi.closeTrade("connection-1", "trade-1"))
      .rejects.toThrow("TRADE_RETCODE_INVALID_STOPS: Invalid stops");
  });

  it("routes an uncertain modify response to the mutation error path", async () => {
    stubFreshLiveTruthThen({
      ok: false,
      brokerExecutionStatus: "uncertain",
      error: "MetaAPI returned an empty response",
      fallback: true,
    });

    await expect(
      brokerExecApi.modifyTrade("connection-1", "trade-1", { stopLoss: 1.2 }),
    ).rejects.toThrow("MetaAPI returned an empty response");
  });

  it("resolves a semantically confirmed close response", async () => {
    stubFreshLiveTruthThen({
      ok: true,
      brokerExecutionStatus: "succeeded",
      stringCode: "TRADE_RETCODE_DONE",
    });

    await expect(brokerExecApi.closeTrade("connection-1", "trade-1"))
      .resolves.toMatchObject({
        ok: true,
        brokerExecutionStatus: "succeeded",
      });
  });
});
