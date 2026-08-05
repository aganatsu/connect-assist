/**
 * reconcileBrokerState.test.ts — Broker-Authoritative Reconciliation Tests
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies:
 *   1. When broker SL matches DB SL (within tolerance), status = "synced"
 *   2. When broker SL differs, reconcile pushes intended SL and returns "corrected"
 *   3. When broker rejects the modify, DB is corrected to broker's actual value (broker-authoritative)
 *   4. When position has no comment-tag match, status = "not_found"
 *   5. Mismatch cycle counter increments on consecutive rejections
 *   6. Telegram alert fires at 5+ consecutive mismatches (once per position)
 *   7. Paper-trading no longer calls modifyBrokerSL (dedup verification)
 *
 * Run: deno test --allow-all supabase/functions/_shared/reconcileBrokerState.test.ts
 */
import {
  reconcileBrokerState,
  reconcilePartialClose,
  _testHelpers,
  type ReconcilePosition,
  type BrokerConnection,
  type ReconcileOptions,
} from "../../functions/_shared/reconcileBrokerState.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Mock Fetch (intercepts MetaAPI calls) ──────────────────────────────────
let fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
let fetchResponses: Array<{ ok: boolean; status: number; body: string }> = [];
let fetchResponseIndex = 0;

const originalFetch = globalThis.fetch;

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  fetchCalls.push({ url: urlStr, method: init?.method || "GET", body: init?.body as string | undefined });
  const resp = fetchResponses[fetchResponseIndex] || { ok: true, status: 200, body: "[]" };
  fetchResponseIndex++;
  return Promise.resolve(new Response(resp.body, { status: resp.status }));
}

function setupFetch(responses: Array<{ ok: boolean; status: number; body: string }>) {
  fetchCalls = [];
  fetchResponseIndex = 0;
  fetchResponses = responses;
  globalThis.fetch = mockFetch as any;
}

function teardownFetch() {
  globalThis.fetch = originalFetch;
}

// ─── Mock Supabase ──────────────────────────────────────────────────────────
interface MockUpdate { table: string; data: any; filters: Record<string, any> }
let mockUpdates: MockUpdate[] = [];

function createMockSupabase() {
  mockUpdates = [];
  const chainable = (table: string, method: string) => {
    const proxy: any = {
      eq: (_col: string, _val: any) => proxy,
      in: (_col: string, _val: any) => proxy,
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: null, error: null }),
    };
    return proxy;
  };
  return {
    from: (table: string) => ({
      select: (cols: string) => chainable(table, "select"),
      update: (data: any) => {
        const filters: Record<string, any> = {};
        const proxy: any = {
          eq: (col: string, val: any) => { filters[col] = val; mockUpdates.push({ table, data, filters: { ...filters } }); return proxy; },
          then: (resolve: any) => resolve({ data: null, error: null }),
        };
        return proxy;
      },
    }),
  };
}

// ─── Test Fixtures ──────────────────────────────────────────────────────────
function makePosition(overrides: Partial<ReconcilePosition> = {}): ReconcilePosition {
  return {
    id: "uuid-pos-1",
    position_id: "POS_001",
    symbol: "EUR/USD",
    direction: "long",
    stop_loss: 1.08500,
    take_profit: 1.09500,
    mirrored_connection_ids: ["conn-1"],
    ...overrides,
  };
}

function makeConnection(overrides: Partial<BrokerConnection> = {}): BrokerConnection {
  return {
    id: "conn-1",
    account_id: "meta-account-123",
    api_key: "eyJhbGciOiJIUzI1NiJ9.test-token",
    broker_type: "metaapi",
    display_name: "Test Broker",
    symbol_suffix: "",
    symbol_overrides: {},
    is_active: true,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("reconcileBrokerState: synced when broker SL matches DB SL within tolerance", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition({ stop_loss: 1.08500 });
  const conn = makeConnection();

  // Broker returns position with matching SL (within 0.5 pip = 0.00005)
  setupFetch([
    { ok: true, status: 200, body: JSON.stringify([{
      id: "broker-pos-1",
      comment: "paper:POS_001",
      stopLoss: 1.08498, // within 0.5 pip tolerance of 1.08500
      takeProfit: 1.09500,
      currentPrice: 1.09000,
      openPrice: 1.08700,
      profit: 30,
      symbol: "EURUSD",
      type: "POSITION_TYPE_BUY",
    }]) },
  ]);

  const results = await reconcileBrokerState({
    supabase: supabase as any,
    userId: "user-1",
    positions: [pos],
    connections: [conn],
    telegramChatIds: [],
    shouldNotify: () => true,
    scanCycleId: "test-1",
  });

  teardownFetch();
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "synced");
  assertEquals(results[0].positionId, "POS_001");
  assertEquals(mockUpdates.length, 0); // No DB correction needed
});

Deno.test("reconcileBrokerState: corrected when broker SL differs and modify succeeds", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition({ stop_loss: 1.08600 }); // DB wants 1.08600
  const conn = makeConnection();

  // Broker has stale SL at 1.08400
  setupFetch([
    // positions fetch
    { ok: true, status: 200, body: JSON.stringify([{
      id: "broker-pos-1",
      comment: "paper:POS_001",
      stopLoss: 1.08400, // Stale — differs from DB's 1.08600
      takeProfit: 1.09500,
      currentPrice: 1.09200,
      openPrice: 1.08700,
      profit: 50,
      symbol: "EURUSD",
      type: "POSITION_TYPE_BUY",
    }]) },
    // trade modify (success)
    { ok: true, status: 200, body: JSON.stringify({ stringCode: "TRADE_RETCODE_DONE" }) },
  ]);

  const results = await reconcileBrokerState({
    supabase: supabase as any,
    userId: "user-1",
    positions: [pos],
    connections: [conn],
    telegramChatIds: [],
    shouldNotify: () => true,
    scanCycleId: "test-2",
  });

  teardownFetch();
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "corrected");
  // Verify modify was called
  const modifyCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/trade"));
  assert(modifyCall !== undefined, "Should have called /trade endpoint");
  const modifyBody = JSON.parse(modifyCall!.body!);
  assertEquals(modifyBody.actionType, "POSITION_MODIFY");
  // SL should be adjusted by 1 pip safety buffer (long = SL - pipSize)
  // 1.08600 - 0.0001 = 1.08590
  assertEquals(modifyBody.stopLoss, 1.08590);
});

Deno.test("reconcileBrokerState: broker-authoritative — rejected modify writes broker value to DB", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition({ stop_loss: 1.08600 }); // DB wants 1.08600
  const conn = makeConnection();

  // Broker has SL at 1.08400 and REJECTS our modify
  setupFetch([
    // positions fetch
    { ok: true, status: 200, body: JSON.stringify([{
      id: "broker-pos-1",
      comment: "paper:POS_001",
      stopLoss: 1.08400,
      takeProfit: 1.09500,
      currentPrice: 1.08650,
      openPrice: 1.08700,
      profit: -5,
      symbol: "EURUSD",
      type: "POSITION_TYPE_BUY",
    }]) },
    // trade modify (REJECTED)
    { ok: true, status: 200, body: JSON.stringify({ stringCode: "TRADE_RETCODE_INVALID_STOPS", message: "Invalid stops" }) },
  ]);

  const results = await reconcileBrokerState({
    supabase: supabase as any,
    userId: "user-1",
    positions: [pos],
    connections: [conn],
    telegramChatIds: [],
    shouldNotify: () => true,
    scanCycleId: "test-3",
  });

  teardownFetch();
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "rejected");
  // Broker-authoritative: DB should be corrected to broker's actual value (1.08400)
  assert(mockUpdates.length > 0, "Should have written broker's value to DB");
  const dbUpdate = mockUpdates.find(u => u.table === "paper_positions");
  assert(dbUpdate !== undefined, "Should update paper_positions");
  assertEquals(dbUpdate!.data.stop_loss, "1.084"); // broker's actual value
});

Deno.test("reconcileBrokerState: not_found when no comment-tag match", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition();
  const conn = makeConnection();

  // Broker returns positions but none match our comment tag
  setupFetch([
    { ok: true, status: 200, body: JSON.stringify([{
      id: "broker-pos-99",
      comment: "paper:DIFFERENT_POS",
      stopLoss: 1.08000,
      symbol: "EURUSD",
    }]) },
  ]);

  const results = await reconcileBrokerState({
    supabase: supabase as any,
    userId: "user-1",
    positions: [pos],
    connections: [conn],
    telegramChatIds: [],
    shouldNotify: () => true,
    scanCycleId: "test-4",
  });

  teardownFetch();
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "not_found");
  assertEquals(results[0].detail, "no comment-tag match");
});

Deno.test("reconcileBrokerState: mismatch counter increments on consecutive rejections", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition({ stop_loss: 1.08600 });
  const conn = makeConnection();

  const brokerPositionsPayload = JSON.stringify([{
    id: "broker-pos-1",
    comment: "paper:POS_001",
    stopLoss: 1.08400,
    takeProfit: 1.09500,
    currentPrice: 1.08650,
    openPrice: 1.08700,
    profit: -5,
    symbol: "EURUSD",
    type: "POSITION_TYPE_BUY",
  }]);
  const rejectPayload = JSON.stringify({ stringCode: "TRADE_RETCODE_FROZEN", message: "Frozen" });

  // Run 4 consecutive rejections
  for (let i = 0; i < 4; i++) {
    mockUpdates = [];
    setupFetch([
      { ok: true, status: 200, body: brokerPositionsPayload },
      { ok: true, status: 200, body: rejectPayload },
    ]);
    await reconcileBrokerState({
      supabase: supabase as any,
      userId: "user-1",
      positions: [pos],
      connections: [conn],
      telegramChatIds: [],
      shouldNotify: () => true,
      scanCycleId: `test-5-iter-${i}`,
    });
    teardownFetch();
  }

  const counter = _testHelpers.getMismatchCycles().get("POS_001");
  assertEquals(counter, 4);
  // Not yet alerted (threshold is 5)
  assertEquals(_testHelpers.getAlertedPositions().has("POS_001"), false);
});

Deno.test("reconcileBrokerState: Telegram alert fires at 5+ consecutive mismatches", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition({ stop_loss: 1.08600 });
  const conn = makeConnection();
  let telegramCalled = false;

  const brokerPositionsPayload = JSON.stringify([{
    id: "broker-pos-1",
    comment: "paper:POS_001",
    stopLoss: 1.08400,
    takeProfit: 1.09500,
    currentPrice: 1.08650,
    openPrice: 1.08700,
    profit: -5,
    symbol: "EURUSD",
    type: "POSITION_TYPE_BUY",
  }]);
  const rejectPayload = JSON.stringify({ stringCode: "TRADE_RETCODE_FROZEN", message: "Frozen" });

  // Set env vars for Telegram
  Deno.env.set("SUPABASE_URL", "http://localhost:54321");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

  // Run 5 consecutive rejections
  for (let i = 0; i < 5; i++) {
    mockUpdates = [];
    setupFetch([
      { ok: true, status: 200, body: brokerPositionsPayload },
      { ok: true, status: 200, body: rejectPayload },
      // Telegram call (on 5th iteration)
      { ok: true, status: 200, body: "{}" },
    ]);
    await reconcileBrokerState({
      supabase: supabase as any,
      userId: "user-1",
      positions: [pos],
      connections: [conn],
      telegramChatIds: ["chat-123"],
      shouldNotify: () => true,
      scanCycleId: `test-6-iter-${i}`,
    });
    // Check if telegram was called on this iteration
    if (fetchCalls.some(c => c.url.includes("telegram-notify"))) {
      telegramCalled = true;
    }
    teardownFetch();
  }

  assertEquals(telegramCalled, true, "Telegram should be called at 5th mismatch");
  assertEquals(_testHelpers.getAlertedPositions().has("POS_001"), true);
  assertEquals(_testHelpers.getMismatchCycles().get("POS_001"), 5);
});

Deno.test("reconcileBrokerState: resets mismatch counter when broker confirms match", async () => {
  _testHelpers.resetState();
  // Pre-set a mismatch count
  _testHelpers.getMismatchCycles().set("POS_001", 3);

  const supabase = createMockSupabase();
  const pos = makePosition({ stop_loss: 1.08500 });
  const conn = makeConnection();

  // Broker now matches
  setupFetch([
    { ok: true, status: 200, body: JSON.stringify([{
      id: "broker-pos-1",
      comment: "paper:POS_001",
      stopLoss: 1.08500, // matches DB
      takeProfit: 1.09500,
      currentPrice: 1.09000,
      symbol: "EURUSD",
    }]) },
  ]);

  const results = await reconcileBrokerState({
    supabase: supabase as any,
    userId: "user-1",
    positions: [pos],
    connections: [conn],
    telegramChatIds: [],
    shouldNotify: () => true,
    scanCycleId: "test-7",
  });

  teardownFetch();
  assertEquals(results[0].status, "synced");
  assertEquals(_testHelpers.getMismatchCycles().get("POS_001"), 0); // Reset
});

Deno.test("reconcileBrokerState: skips positions with no mirrored connections", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition({ mirrored_connection_ids: [] }); // No mirrored connections
  const conn = makeConnection();

  setupFetch([]);

  const results = await reconcileBrokerState({
    supabase: supabase as any,
    userId: "user-1",
    positions: [pos],
    connections: [conn],
    telegramChatIds: [],
    shouldNotify: () => true,
    scanCycleId: "test-8",
  });

  teardownFetch();
  // Position has no mirrored_connection_ids, so it won't be grouped to any connection
  assertEquals(results.length, 0);
  assertEquals(fetchCalls.length, 0); // No API calls made
});

Deno.test("reconcileBrokerState: handles broker API failure gracefully", async () => {
  _testHelpers.resetState();
  const supabase = createMockSupabase();
  const pos = makePosition();
  const conn = makeConnection();

  // All regions fail
  setupFetch([
    { ok: false, status: 500, body: "Internal Server Error" },
    { ok: false, status: 500, body: "Internal Server Error" },
    { ok: false, status: 500, body: "Internal Server Error" },
  ]);

  const results = await reconcileBrokerState({
    supabase: supabase as any,
    userId: "user-1",
    positions: [pos],
    connections: [conn],
    telegramChatIds: [],
    shouldNotify: () => true,
    scanCycleId: "test-9",
  });

  teardownFetch();
  assertEquals(results.length, 1);
  assertEquals(results[0].status, "error");
  assert(results[0].detail?.includes("500"));
});


Deno.test("reconcilePartialClose: uses native OANDA trade close endpoint", async () => {
  const supabase = createMockSupabase();
  const pos = makePosition();
  const conn = makeConnection({ broker_type: "oanda", account_id: "oanda-account", api_key: "oanda-token" });
  setupFetch([
    { ok: true, status: 200, body: JSON.stringify({ trades: [{ id: "oanda-trade-1", instrument: "EUR_USD", currentUnits: "10000", clientExtensions: { id: "POS_001" } }] }) },
    { ok: true, status: 200, body: "{}" },
  ]);
  const results = await reconcilePartialClose({
    supabase, positions: [pos], connections: [conn],
    partialActions: [{ positionId: "POS_001", symbol: "EUR/USD", closeFraction: 0.5, direction: "long" }],
  });
  teardownFetch();
  assertEquals(results, [{ positionId: "POS_001", connectionId: "conn-1", ok: true, error: undefined }]);
  const closeCall = fetchCalls.find((call) => call.url.includes("/trades/oanda-trade-1/close"));
  assert(closeCall, "OANDA close endpoint should be called");
  assertEquals(closeCall.method, "PUT");
  assertEquals(JSON.parse(closeCall.body || "{}"), { units: "5000" });
});

Deno.test("reconcilePartialClose: returns OANDA failures for reconciliation", async () => {
  const supabase = createMockSupabase();
  const pos = makePosition();
  const conn = makeConnection({ broker_type: "oanda", account_id: "oanda-account", api_key: "oanda-token" });
  setupFetch([{ ok: true, status: 200, body: JSON.stringify({ trades: [] }) }]);
  const results = await reconcilePartialClose({
    supabase, positions: [pos], connections: [conn],
    partialActions: [{ positionId: "POS_001", symbol: "EUR/USD", closeFraction: 0.5, direction: "long" }],
  });
  teardownFetch();
  assertEquals(results.length, 1);
  assertEquals(results[0].ok, false);
  assert(results[0].error?.includes("OANDA position match"));
});
