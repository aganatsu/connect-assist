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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        brokerResponse({
          ok: false,
          brokerExecutionStatus: "uncertain",
          fallback: true,
        })
      ),
    );

    await expect(brokerExecApi.placeOrder("connection-1", {
      symbol: "EUR/USD",
      direction: "long",
      size: 0.1,
    })).rejects.toThrow(
      "Broker execution outcome is unknown. Check broker state before retrying.",
    );
  });

  it("routes a rejected close response to the mutation error path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        brokerResponse({
          ok: false,
          brokerExecutionStatus: "rejected",
          error: "TRADE_RETCODE_INVALID_STOPS: Invalid stops",
        })
      ),
    );

    await expect(brokerExecApi.closeTrade("connection-1", "trade-1"))
      .rejects.toThrow("TRADE_RETCODE_INVALID_STOPS: Invalid stops");
  });

  it("routes an uncertain modify response to the mutation error path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        brokerResponse({
          ok: false,
          brokerExecutionStatus: "uncertain",
          error: "MetaAPI returned an empty response",
          fallback: true,
        })
      ),
    );

    await expect(
      brokerExecApi.modifyTrade("connection-1", "trade-1", { stopLoss: 1.2 }),
    ).rejects.toThrow("MetaAPI returned an empty response");
  });

  it("resolves a semantically confirmed close response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        brokerResponse({
          ok: true,
          brokerExecutionStatus: "succeeded",
          stringCode: "TRADE_RETCODE_DONE",
        })
      ),
    );

    await expect(brokerExecApi.closeTrade("connection-1", "trade-1"))
      .resolves.toMatchObject({
        ok: true,
        brokerExecutionStatus: "succeeded",
      });
  });
});
