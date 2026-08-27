import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BrokerConnection,
  type FullClosePosition,
  reconcileFullBrokerClose,
} from "../../functions/_shared/reconcileBrokerState.ts";
import { regionCache } from "../../functions/_shared/metaApiClient.ts";

const position: FullClosePosition = {
  id: "position-row-1",
  position_id: "paper-position-1",
  symbol: "EUR/USD",
  direction: "long",
  stop_loss: 1.09,
  take_profit: 1.11,
  mirrored_connection_ids: ["connection-1"],
  position_status: "open",
  broker_execution_state: "confirmed",
};

const oandaConnection: BrokerConnection = {
  id: "connection-1",
  account_id: "oanda-account",
  api_key: "oanda-token",
  broker_type: "oanda",
  display_name: "OANDA Test",
  is_active: true,
};

const metaConnection: BrokerConnection = {
  id: "connection-1",
  account_id: "meta-account",
  api_key: "meta-token",
  broker_type: "metaapi",
  display_name: "MetaAPI Test",
  is_active: true,
};

function closeContext(overrides: Record<string, unknown> = {}) {
  return {
    position_found: true,
    position_status: "open",
    broker_execution_state: "confirmed",
    execution_mode: "live",
    required_connection_ids: ["connection-1"],
    missing_close_connection_ids: ["connection-1"],
    unknown_identity_connection_ids: [],
    broker_position_ids: { "connection-1": "trade-1" },
    ...overrides,
  };
}

function createCloseSupabase(input: {
  contexts: Array<Record<string, unknown>>;
  connections?: BrokerConnection[];
  positionUpdateError?: Error;
  connectionReadError?: Error;
  claimError?: Error;
}) {
  let contextIndex = 0;
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const updates: any[] = [];
  const supabase = {
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name === "load_paper_position_close_context") {
        const data = input.contexts[
          Math.min(contextIndex, input.contexts.length - 1)
        ];
        contextIndex++;
        return { data, error: null };
      }
      if (name === "claim_broker_execution") {
        if (input.claimError) throw input.claimError;
        return {
          data: {
            claimed: true,
            code: "claimed",
            ledger_id: "ledger-1",
            claim_token: "claim-1",
            status: "attempting",
          },
          error: null,
        };
      }
      if (name === "complete_broker_execution") {
        return {
          data: {
            completed: true,
            code: "completed",
            status: args.p_status,
            broker_order_id: args.p_broker_order_id,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from: (table: string) => {
      if (table === "paper_positions") {
        return {
          update: (data: any) => {
            updates.push(data);
            const query: any = {
              eq: () => query,
              then: (resolve: (value: any) => void) =>
                resolve({
                  data: null,
                  error: input.positionUpdateError || null,
                }),
            };
            return query;
          },
        };
      }
      if (table === "broker_connections") {
        return {
          select: () => {
            const query: any = {
              eq: () => query,
              in: () => {
                if (input.connectionReadError) {
                  return Promise.reject(input.connectionReadError);
                }
                return Promise.resolve({
                  data: input.connections || [],
                  error: null,
                });
              },
            };
            return query;
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  return { supabase, rpcCalls, updates };
}

async function withFetchQueue(
  steps: Array<Response | Error>,
  run: (calls: Array<{ url: string; method: string }>) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  // Region discovery has its own dedicated contract tests. These close tests
  // exercise exact-position and close-history behavior, so pin the known
  // account region and keep the response queue scoped to those broker calls.
  regionCache.set(metaConnection.account_id, "london");
  const calls: Array<{ url: string; method: string }> = [];
  let index = 0;
  globalThis.fetch =
    (async (request: string | URL | Request, init?: RequestInit) => {
      const url = typeof request === "string"
        ? request
        : request instanceof URL
        ? request.toString()
        : request.url;
      calls.push({ url, method: init?.method || "GET" });
      const step = steps[index++];
      if (step instanceof Error) throw step;
      if (!step) throw new Error(`Missing fetch response for ${url}`);
      return step;
    }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.delete(metaConnection.account_id);
  }
}

Deno.test("full close: paper-only positions finalize without broker work", async () => {
  const { supabase, rpcCalls, updates } = createCloseSupabase({
    contexts: [closeContext({
      broker_execution_state: "paper",
      execution_mode: "paper",
      required_connection_ids: [],
      missing_close_connection_ids: [],
      broker_position_ids: {},
    })],
  });

  const result = await reconcileFullBrokerClose({
    supabase,
    userId: "user-1",
    botId: "smc",
    position: { ...position, broker_execution_state: "paper" },
    route: "paper_auto_exit",
    closeReason: "tp_hit",
  });

  assertEquals(result.readyToFinalize, true);
  assertEquals(result.state, "paper");
  assertEquals(rpcCalls.map((call) => call.name), [
    "load_paper_position_close_context",
  ]);
  assertEquals(updates, []);
});

Deno.test("full close: OANDA mutation is exact, ledgered, and proved before finalization", async () => {
  const { supabase, rpcCalls, updates } = createCloseSupabase({
    contexts: [
      closeContext(),
      closeContext({ missing_close_connection_ids: [] }),
    ],
    connections: [oandaConnection],
  });

  await withFetchQueue([
    new Response(JSON.stringify({ trade: { id: "trade-1", state: "OPEN" } }), {
      status: 200,
    }),
    new Response(JSON.stringify({ orderFillTransaction: { id: "fill-1" } }), {
      status: 200,
    }),
    new Response(
      JSON.stringify({ trade: { id: "trade-1", state: "CLOSED" } }),
      { status: 200 },
    ),
  ], async (fetchCalls) => {
    const result = await reconcileFullBrokerClose({
      supabase,
      userId: "user-1",
      botId: "smc",
      position,
      route: "paper_auto_exit",
      closeReason: "tp_hit",
    });

    assertEquals(result.readyToFinalize, true);
    assertEquals(result.state, "confirmed");
    assertEquals(fetchCalls.filter((call) => call.method === "PUT").length, 1);
    assertStringIncludes(fetchCalls[1].url, "/trades/trade-1/close");
  });

  const claim = rpcCalls.find((call) => call.name === "claim_broker_execution");
  const completion = rpcCalls.find((call) =>
    call.name === "complete_broker_execution"
  );
  assertEquals(claim?.args.p_request_payload.brokerPositionId, "trade-1");
  assertEquals(completion?.args.p_status, "succeeded");
  assertEquals(completion?.args.p_response_payload.close_confirmed, true);
  assertEquals(
    completion?.args.p_response_payload.broker_position_id,
    "trade-1",
  );
  assertEquals(updates.map((update) => update.broker_close_state), [
    "pending",
    "confirmed",
  ]);
});

Deno.test("full close: missing exact broker identity remains open without a send", async () => {
  const { supabase, updates } = createCloseSupabase({
    contexts: [
      closeContext({
        unknown_identity_connection_ids: ["connection-1"],
        broker_position_ids: {},
      }),
      closeContext({
        unknown_identity_connection_ids: ["connection-1"],
        broker_position_ids: {},
      }),
    ],
    connections: [oandaConnection],
  });

  await withFetchQueue([], async (fetchCalls) => {
    const result = await reconcileFullBrokerClose({
      supabase,
      userId: "user-1",
      botId: "smc",
      position,
      route: "manual_close",
      closeReason: "manual",
    });
    assertEquals(result.readyToFinalize, false);
    assertEquals(result.state, "reconciliation_required");
    assertEquals(fetchCalls, []);
  });
  assertEquals(updates.map((update) => update.broker_close_state), [
    "pending",
    "reconciliation_required",
  ]);
});

Deno.test("full close: one unresolved broker keeps the internal position open", async () => {
  const secondConnection: BrokerConnection = {
    ...oandaConnection,
    id: "connection-2",
    account_id: "oanda-account-2",
    display_name: "OANDA Test 2",
  };
  const multiContext = {
    required_connection_ids: ["connection-1", "connection-2"],
    missing_close_connection_ids: ["connection-1", "connection-2"],
    broker_position_ids: {
      "connection-1": "trade-1",
      "connection-2": "trade-2",
    },
  };
  const { supabase } = createCloseSupabase({
    contexts: [
      closeContext(multiContext),
      closeContext({
        ...multiContext,
        missing_close_connection_ids: ["connection-2"],
      }),
    ],
    connections: [oandaConnection, secondConnection],
  });

  await withFetchQueue([
    new Response(JSON.stringify({ trade: { id: "trade-1", state: "OPEN" } }), {
      status: 200,
    }),
    new Response(JSON.stringify({ orderFillTransaction: { id: "fill-1" } }), {
      status: 200,
    }),
    new Response(
      JSON.stringify({ trade: { id: "trade-1", state: "CLOSED" } }),
      { status: 200 },
    ),
    new Response("broker unavailable", { status: 503 }),
  ], async (fetchCalls) => {
    const result = await reconcileFullBrokerClose({
      supabase,
      userId: "user-1",
      botId: "smc",
      position,
      route: "kill_switch",
      closeReason: "kill_switch",
    });
    assertEquals(result.readyToFinalize, false);
    assertEquals(result.state, "reconciliation_required");
    assertEquals(result.connections[0]?.status, "succeeded");
    assertEquals(result.connections[1]?.status, "uncertain");
    assertEquals(
      fetchCalls.filter((call) => call.method === "PUT").length,
      1,
    );
  });
});

Deno.test("full close: MetaAPI requires exact closed-volume history", async () => {
  for (const fullExit of [true, false]) {
    const { supabase, rpcCalls } = createCloseSupabase({
      contexts: [
        closeContext(),
        closeContext({
          missing_close_connection_ids: fullExit ? [] : ["connection-1"],
        }),
      ],
      connections: [metaConnection],
    });
    await withFetchQueue([
      new Response(JSON.stringify([{ id: "trade-1" }]), { status: 200 }),
      new Response(JSON.stringify({ stringCode: "TRADE_RETCODE_DONE" }), {
        status: 200,
      }),
      new Response("[]", { status: 200 }),
      new Response(
        JSON.stringify([
          { entryType: "DEAL_ENTRY_IN", volume: 1 },
          ...(fullExit ? [{ entryType: "DEAL_ENTRY_OUT", volume: 1 }] : []),
        ]),
        { status: 200 },
      ),
    ], async (fetchCalls) => {
      const result = await reconcileFullBrokerClose({
        supabase,
        userId: "user-1",
        botId: "smc",
        position,
        route: "manual_close",
        closeReason: "manual",
      });
      assertEquals(result.readyToFinalize, fullExit);
      const mutation = fetchCalls.filter((call) => call.method === "POST");
      assertEquals(mutation.length, 1);
      assertStringIncludes(mutation[0].url, "/trade");
    });
    const completion = rpcCalls.find((call) =>
      call.name === "complete_broker_execution"
    );
    assertEquals(
      completion?.args.p_status,
      fullExit ? "succeeded" : "uncertain",
    );
  }
});

Deno.test("full close: OANDA 404 is proof only when exact closed history contains the trade", async () => {
  for (const exactHistory of [true, false]) {
    const { supabase, rpcCalls } = createCloseSupabase({
      contexts: [
        closeContext(),
        closeContext({
          missing_close_connection_ids: exactHistory ? [] : ["connection-1"],
        }),
      ],
      connections: [oandaConnection],
    });
    await withFetchQueue([
      new Response("not found", { status: 404 }),
      new Response(
        JSON.stringify({
          trades: exactHistory ? [{ id: "trade-1", state: "CLOSED" }] : [],
        }),
        { status: 200 },
      ),
    ], async (fetchCalls) => {
      const result = await reconcileFullBrokerClose({
        supabase,
        userId: "user-1",
        botId: "smc",
        position,
        route: "paper_auto_exit",
        closeReason: "sl_hit",
      });
      assertEquals(result.readyToFinalize, exactHistory);
      assertEquals(
        fetchCalls.some((call) => call.method === "PUT"),
        false,
        "A generic 404 must never trigger a speculative close or count as proof",
      );
    });
    const completion = rpcCalls.find((call) =>
      call.name === "complete_broker_execution"
    );
    assertEquals(
      completion?.args.p_status,
      exactHistory ? "succeeded" : "uncertain",
    );
  }
});

Deno.test("full close: repeated status reconciliation does not resend after a lost close response", async () => {
  const { supabase } = createCloseSupabase({
    contexts: [
      closeContext(),
      closeContext(),
      closeContext(),
      closeContext({ missing_close_connection_ids: [] }),
    ],
    connections: [oandaConnection],
  });

  await withFetchQueue([
    new Response(JSON.stringify({ trade: { id: "trade-1", state: "OPEN" } }), {
      status: 200,
    }),
    new Error("connection reset after broker accepted close"),
    new Response("upstream unavailable", { status: 503 }),
    new Response("not found", { status: 404 }),
    new Response(
      JSON.stringify({ trades: [{ id: "trade-1", state: "CLOSED" }] }),
      { status: 200 },
    ),
  ], async (fetchCalls) => {
    const first = await reconcileFullBrokerClose({
      supabase,
      userId: "user-1",
      botId: "smc",
      position,
      route: "paper_auto_exit",
      closeReason: "tp_hit",
    });
    assertEquals(first.readyToFinalize, false);

    const retry = await reconcileFullBrokerClose({
      supabase,
      userId: "user-1",
      botId: "smc",
      position,
      route: "paper_auto_exit",
      closeReason: "tp_hit",
    });
    assertEquals(retry.readyToFinalize, true);
    assertEquals(
      fetchCalls.filter((call) => call.method === "PUT").length,
      1,
      "Repeated status processing must reconcile the exact ID instead of resending the close",
    );
  });
});

Deno.test("full close: persistence and ledger failures stay local and fail closed", async () => {
  const persistenceFailure = createCloseSupabase({
    contexts: [closeContext()],
    connections: [oandaConnection],
    positionUpdateError: new Error("write unavailable"),
  });
  await withFetchQueue([], async (fetchCalls) => {
    const result = await reconcileFullBrokerClose({
      supabase: persistenceFailure.supabase,
      userId: "user-1",
      botId: "smc",
      position,
      route: "scanner_breach",
      closeReason: "sl_hit",
    });
    assertEquals(result.readyToFinalize, false);
    assertEquals(result.state, "reconciliation_required");
    assertStringIncludes(result.reason || "", "claim state");
    assertEquals(fetchCalls, []);
  });

  const ledgerFailure = createCloseSupabase({
    contexts: [closeContext(), closeContext()],
    connections: [oandaConnection],
    claimError: new Error("ledger unavailable"),
  });
  await withFetchQueue([], async (fetchCalls) => {
    const result = await reconcileFullBrokerClose({
      supabase: ledgerFailure.supabase,
      userId: "user-1",
      botId: "smc",
      position,
      route: "paper_auto_exit",
      closeReason: "tp_hit",
    });
    assertEquals(result.readyToFinalize, false);
    assertEquals(result.state, "reconciliation_required");
    assertEquals(result.connections[0]?.status, "uncertain");
    assertStringIncludes(
      result.connections[0]?.error || "",
      "ledger unavailable",
    );
    assertEquals(fetchCalls, []);
  });

  const connectionFailure = createCloseSupabase({
    contexts: [closeContext()],
    connectionReadError: new Error("connection lookup unavailable"),
  });
  const result = await reconcileFullBrokerClose({
    supabase: connectionFailure.supabase,
    userId: "user-1",
    botId: "smc",
    position,
    route: "manual_close",
    closeReason: "manual",
  });
  assertEquals(result.readyToFinalize, false);
  assertStringIncludes(result.reason || "", "connection lookup unavailable");
});
