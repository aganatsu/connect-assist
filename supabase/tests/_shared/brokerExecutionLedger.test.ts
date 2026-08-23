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

Deno.test("MetaAPI opens require the exact broker position id", () => {
  const orderTicketOnly = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "order-1",
    },
    confirmationMode: "metaapi_position_open",
  });
  assertEquals(orderTicketOnly, {
    status: "uncertain",
    error: "MetaAPI confirmed the order but did not return the opened position ID",
  });

  const opened = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {
      stringCode: "TRADE_RETCODE_DONE",
      orderId: "order-1",
      positionId: "position-1",
    },
    confirmationMode: "metaapi_position_open",
  });
  assertEquals(opened, {
    status: "succeeded",
    brokerOrderId: "position-1",
  });
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

Deno.test("OANDA opens require a newly opened trade id", () => {
  const reducedOnly = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 201,
    parsedBody: {
      orderFillTransaction: {
        id: "102",
        tradeReduced: { tradeID: "old-trade-1", units: "100" },
      },
    },
    confirmationMode: "oanda_trade_open",
  });
  assertEquals(reducedOnly, {
    status: "uncertain",
    error:
      "OANDA filled the open request but also changed existing exposure; reconcile broker state",
  });

  const mixedFill = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 201,
    parsedBody: {
      orderFillTransaction: {
        id: "103",
        tradeOpened: { tradeID: "trade-2" },
        tradesClosed: [{ tradeID: "old-trade-2", units: "50" }],
      },
    },
    confirmationMode: "oanda_trade_open",
  });
  assertEquals(mixedFill, {
    status: "uncertain",
    error:
      "OANDA filled the open request but also changed existing exposure; reconcile broker state",
  });

  const opened = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 201,
    parsedBody: {
      orderFillTransaction: {
        id: "102",
        tradeOpened: { tradeID: "trade-1" },
      },
    },
    confirmationMode: "oanda_trade_open",
  });
  assertEquals(opened, {
    status: "succeeded",
    brokerOrderId: "trade-1",
  });
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

Deno.test("execution wrapper downgrades success when ledger completion fails", async () => {
  const supabase = {
    rpc: async (name: string) => {
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
      return { data: { completed: false }, error: null };
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
    async () => ({
      ok: true,
      httpStatus: 200,
      parsedBody: {
        stringCode: "TRADE_RETCODE_DONE",
        positionId: "broker-position-1",
      },
      confirmationMode: "metaapi_position_open",
    }),
  );
  assertEquals(result, {
    sent: true,
    status: "uncertain",
    brokerOrderId: "broker-position-1",
    error:
      "Broker mutation response was received but ledger completion was not persisted; reconcile broker state",
    parsedBody: {
      stringCode: "TRADE_RETCODE_DONE",
      positionId: "broker-position-1",
    },
    rawBody: undefined,
  });
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

Deno.test("broker response requires positive normalized success evidence", () => {
  assertEquals(
    classifyBrokerExecutionResponse({
      ok: true,
      httpStatus: 200,
      parsedBody: {},
      rawBody: "{}",
    }),
    {
      status: "uncertain",
      error:
        "Broker returned HTTP success without a recognized mutation confirmation",
    },
  );
  assertEquals(
    classifyBrokerExecutionResponse({
      ok: true,
      httpStatus: 200,
      parsedBody: { ok: true, brokerExecutionStatus: "succeeded" },
    }),
    { status: "succeeded", brokerOrderId: undefined },
  );
});

Deno.test("MetaAPI trade mutations require an explicit broker success code", () => {
  const invalid = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {
      stringCode: "TRADE_RETCODE_INVALID_STOPS",
      message: "Invalid stops",
    },
    confirmationMode: "metaapi_trade",
  });
  assertEquals(invalid, { status: "rejected", error: "Invalid stops" });

  const empty = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: null,
    rawBody: "",
    confirmationMode: "metaapi_trade",
  });
  assertEquals(empty, {
    status: "uncertain",
    error: "Broker returned an empty success response",
  });

  const malformed = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    rawBody: "not-json",
    confirmationMode: "metaapi_trade",
  });
  assertEquals(malformed, {
    status: "uncertain",
    error: "Broker returned an unparseable success response: not-json",
  });

  const missingConfirmation = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {},
    rawBody: "{}",
    confirmationMode: "metaapi_trade",
  });
  assertEquals(missingConfirmation, {
    status: "uncertain",
    error:
      "MetaAPI returned HTTP success without a recognized trade confirmation code",
  });

  const confirmed = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {
      stringCode: "TRADE_RETCODE_DONE",
      positionId: "position-1",
    },
    confirmationMode: "metaapi_trade",
  });
  assertEquals(confirmed, {
    status: "succeeded",
    brokerOrderId: "position-1",
  });
});

Deno.test("OANDA market mutations require a fill transaction", () => {
  const contradictory = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 201,
    parsedBody: {
      orderFillTransaction: { id: "99" },
      orderCancelTransaction: {
        id: "100",
        reason: "FOK_ORDER_PARTIALLY_FILLED",
      },
    },
    confirmationMode: "oanda_order_fill",
  });
  assertEquals(contradictory, {
    status: "uncertain",
    error:
      "OANDA returned both fill and cancellation transactions; reconcile broker state",
  });

  const cancelled = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 201,
    parsedBody: {
      orderCreateTransaction: { id: "100" },
      orderCancelTransaction: {
        id: "101",
        reason: "MARKET_HALTED",
      },
    },
    confirmationMode: "oanda_order_fill",
  });
  assertEquals(cancelled, {
    status: "rejected",
    error: "MARKET_HALTED",
  });

  const missingFill = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 201,
    parsedBody: { orderCreateTransaction: { id: "100" } },
    confirmationMode: "oanda_order_fill",
  });
  assertEquals(missingFill, {
    status: "uncertain",
    error: "OANDA returned HTTP success without an order fill confirmation",
  });

  const filled = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 201,
    parsedBody: {
      orderFillTransaction: {
        id: "102",
        tradeOpened: { tradeID: "trade-1" },
      },
    },
    confirmationMode: "oanda_order_fill",
  });
  assertEquals(filled, {
    status: "succeeded",
    brokerOrderId: "trade-1",
  });
});

Deno.test("OANDA dependent-order mutations confirm every requested order", () => {
  const partial = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {
      stopLossOrderTransaction: { id: "201" },
    },
    confirmationMode: "oanda_trade_orders",
    requiredOandaTransactions: [
      "stopLossOrderTransaction",
      "takeProfitOrderTransaction",
    ],
  });
  assertEquals(partial, {
    status: "uncertain",
    error:
      "OANDA returned HTTP success without all requested dependent-order confirmations",
  });

  const confirmed = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {
      stopLossOrderTransaction: { id: "201" },
      takeProfitOrderTransaction: { id: "202" },
    },
    confirmationMode: "oanda_trade_orders",
    requiredOandaTransactions: [
      "stopLossOrderTransaction",
      "takeProfitOrderTransaction",
    ],
  });
  assertEquals(confirmed, {
    status: "succeeded",
    brokerOrderId: "201",
  });
});

Deno.test("OANDA dependent-order mutation rejects mixed success and rejection", () => {
  const outcome = classifyBrokerExecutionResponse({
    ok: true,
    httpStatus: 200,
    parsedBody: {
      stopLossOrderTransaction: { id: "201" },
      takeProfitOrderRejectTransaction: {
        id: "202",
        rejectReason: "TAKE_PROFIT_ON_FILL_PRICE_INVALID",
      },
    },
    confirmationMode: "oanda_trade_orders",
    requiredOandaTransactions: [
      "stopLossOrderTransaction",
      "takeProfitOrderTransaction",
    ],
  });
  assertEquals(outcome, {
    status: "rejected",
    error: "TAKE_PROFIT_ON_FILL_PRICE_INVALID",
  });
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
