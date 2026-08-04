import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  claimBrokerExecution,
  classifyBrokerExecutionResponse,
  completeBrokerExecution,
  executeBrokerOrderWithLedger,
} from "../../functions/_shared/brokerExecutionLedger.ts";

Deno.test("broker execution claim maps RPC response", async () => {
  const calls: any[] = [];
  const supabase = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        data: {
          claimed: true,
          code: "claimed",
          ledger_id: "ledger-1",
          claim_token: "token-1",
          status: "attempting",
        },
        error: null,
      };
    },
  };

  const claim = await claimBrokerExecution(supabase, {
    userId: "user-1",
    botId: "smc",
    positionId: "position-1",
    brokerConnectionId: "connection-1",
    route: "normal_pending",
    requestPayload: { symbol: "EUR/USD" },
  });

  assertEquals(claim.claimed, true);
  assertEquals(claim.ledgerId, "ledger-1");
  assertEquals(calls[0].name, "claim_broker_execution");
  assertEquals(calls[0].args.p_action, "open");
});

Deno.test("broker execution completion requires an active claim", async () => {
  let called = false;
  const supabase = {
    rpc: async () => {
      called = true;
      return { data: { completed: true }, error: null };
    },
  };
  const completed = await completeBrokerExecution(
    supabase,
    { claimed: false, code: "already_claimed" },
    { userId: "user-1", status: "uncertain" },
  );
  assertEquals(completed, false);
  assertEquals(called, false);
});

Deno.test("broker response classifies MetaAPI success and extracts order id", () => {
  assertEquals(
    classifyBrokerExecutionResponse({
      ok: true,
      httpStatus: 200,
      parsedBody: {
        stringCode: "TRADE_RETCODE_DONE",
        positionId: "broker-position-1",
      },
    }),
    { status: "succeeded", brokerOrderId: "broker-position-1" },
  );
});

Deno.test("broker response classifies a broker rejection as terminal", () => {
  assertEquals(
    classifyBrokerExecutionResponse({
      ok: true,
      httpStatus: 200,
      parsedBody: {
        stringCode: "TRADE_RETCODE_INVALID_VOLUME",
        message: "Invalid volume",
      },
    }),
    { status: "rejected", error: "Invalid volume" },
  );
});

Deno.test("broker response classifies timeouts and 5xx as uncertain", () => {
  assertEquals(
    classifyBrokerExecutionResponse({
      ok: false,
      httpStatus: 503,
      rawBody: "upstream unavailable",
    }),
    { status: "uncertain", error: "upstream unavailable" },
  );
  assertEquals(
    classifyBrokerExecutionResponse({
      ok: false,
      httpStatus: 0,
      rawBody: "network timeout",
    }),
    { status: "uncertain", error: "network timeout" },
  );
});

Deno.test("broker response never treats an unparseable 2xx as confirmed", () => {
  assertEquals(
    classifyBrokerExecutionResponse({
      ok: true,
      httpStatus: 200,
      rawBody: "upstream proxy response",
    }),
    {
      status: "uncertain",
      error:
        "Broker returned an unparseable success response: upstream proxy response",
    },
  );
});

Deno.test("execution wrapper never sends when a durable claim already exists", async () => {
  let sent = false;
  const supabase = {
    rpc: async () => ({
      data: {
        claimed: false,
        code: "already_claimed",
        status: "uncertain",
        reason: "reconciliation required",
      },
      error: null,
    }),
  };
  const result = await executeBrokerOrderWithLedger(
    supabase,
    {
      userId: "user-1",
      botId: "smc",
      positionId: "position-1",
      brokerConnectionId: "connection-1",
      route: "fast_confirmation",
      requestPayload: { symbol: "EUR/USD" },
    },
    async () => {
      sent = true;
      return { ok: true, httpStatus: 200, parsedBody: {} };
    },
  );
  assertEquals(sent, false);
  assertEquals(result.status, "already_claimed");
});

Deno.test("execution wrapper records a thrown request as uncertain", async () => {
  const calls: string[] = [];
  const supabase = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "claim_broker_execution") {
        return {
          data: {
            claimed: true,
            code: "claimed",
            ledger_id: "ledger-1",
            claim_token: "token-1",
          },
          error: null,
        };
      }
      return { data: { completed: true }, error: null };
    },
  };
  const result = await executeBrokerOrderWithLedger(
    supabase,
    {
      userId: "user-1",
      botId: "smc",
      positionId: "position-1",
      brokerConnectionId: "connection-1",
      route: "direct_market",
      requestPayload: { symbol: "EUR/USD" },
    },
    async () => {
      throw new Error("network timeout");
    },
  );
  assertEquals(result.status, "uncertain");
  assertEquals(calls, [
    "claim_broker_execution",
    "complete_broker_execution",
  ]);
});
