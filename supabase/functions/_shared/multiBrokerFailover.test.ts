import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createInitialHealth,
  updateHealth,
  isConnectionAvailable,
  selectBrokers,
  executeWithFailover,
  reconcilePositions,
  DEFAULT_FAILOVER_CONFIG,
  type BrokerConnection,
  type BrokerHealth,
  type ExecutionResult,
  type ExpectedPosition,
  type BrokerPosition,
} from "./multiBrokerFailover.ts";

// ─── Test Fixtures ───────────────────────────────────────────────────

const conn1: BrokerConnection = {
  id: "conn-1", brokerType: "metaapi", displayName: "MT5 Primary",
  accountId: "acc-1", isLive: true, isActive: true, priority: 1,
};
const conn2: BrokerConnection = {
  id: "conn-2", brokerType: "oanda", displayName: "OANDA Backup",
  accountId: "acc-2", isLive: true, isActive: true, priority: 2,
};
const conn3: BrokerConnection = {
  id: "conn-3", brokerType: "metaapi", displayName: "MT5 Secondary",
  accountId: "acc-3", isLive: true, isActive: true, priority: 3,
};
const connInactive: BrokerConnection = {
  id: "conn-4", brokerType: "oanda", displayName: "OANDA Disabled",
  accountId: "acc-4", isLive: true, isActive: false, priority: 4,
};

// ─── createInitialHealth Tests ───────────────────────────────────────

Deno.test("createInitialHealth returns clean state", () => {
  const health = createInitialHealth("conn-1");
  assertEquals(health.connectionId, "conn-1");
  assertEquals(health.failCount, 0);
  assertEquals(health.circuitOpen, false);
  assertEquals(health.avgLatencyMs, 0);
  assertEquals(health.successCount, 0);
});

// ─── updateHealth Tests ──────────────────────────────────────────────

Deno.test("updateHealth resets fail count on success", () => {
  const health: BrokerHealth = {
    ...createInitialHealth("conn-1"),
    failCount: 2,
    lastFailure: "2025-03-01T10:00:00Z",
  };

  const result: ExecutionResult = {
    connectionId: "conn-1", success: true, latencyMs: 150, isTransient: false,
  };

  const updated = updateHealth(health, result);
  assertEquals(updated.failCount, 0);
  assertEquals(updated.circuitOpen, false);
  assertEquals(updated.successCount, 1);
  assertEquals(updated.avgLatencyMs, 150);
});

Deno.test("updateHealth increments fail count on failure", () => {
  const health = createInitialHealth("conn-1");
  const result: ExecutionResult = {
    connectionId: "conn-1", success: false, latencyMs: 5000,
    error: "Connection timeout", isTransient: true,
  };

  const updated = updateHealth(health, result);
  assertEquals(updated.failCount, 1);
  assertEquals(updated.circuitOpen, false); // Not yet at threshold (3)
});

Deno.test("updateHealth opens circuit breaker after max failures", () => {
  const health: BrokerHealth = {
    ...createInitialHealth("conn-1"),
    failCount: 2, // One more failure will trigger
  };

  const result: ExecutionResult = {
    connectionId: "conn-1", success: false, latencyMs: 5000,
    error: "Connection timeout", isTransient: true,
  };

  const updated = updateHealth(health, result);
  assertEquals(updated.failCount, 3);
  assertEquals(updated.circuitOpen, true);
  assertEquals(updated.cooldownUntil !== null, true);
});

Deno.test("updateHealth does NOT open circuit for non-transient errors", () => {
  const health: BrokerHealth = {
    ...createInitialHealth("conn-1"),
    failCount: 2,
  };

  const result: ExecutionResult = {
    connectionId: "conn-1", success: false, latencyMs: 100,
    error: "Invalid API key", isTransient: false, // Permanent error
  };

  const updated = updateHealth(health, result);
  assertEquals(updated.failCount, 3);
  assertEquals(updated.circuitOpen, false); // Don't circuit-break on auth errors
});

// ─── isConnectionAvailable Tests ─────────────────────────────────────

Deno.test("isConnectionAvailable returns true for healthy connection", () => {
  const health = createInitialHealth("conn-1");
  assertEquals(isConnectionAvailable(health), true);
});

Deno.test("isConnectionAvailable returns false during cooldown", () => {
  const health: BrokerHealth = {
    ...createInitialHealth("conn-1"),
    circuitOpen: true,
    cooldownUntil: new Date(Date.now() + 60_000).toISOString(), // 1 min from now
  };
  assertEquals(isConnectionAvailable(health), false);
});

Deno.test("isConnectionAvailable returns true after cooldown expires", () => {
  const health: BrokerHealth = {
    ...createInitialHealth("conn-1"),
    circuitOpen: true,
    cooldownUntil: new Date(Date.now() - 1000).toISOString(), // 1 sec ago
  };
  assertEquals(isConnectionAvailable(health), true);
});

// ─── selectBrokers Tests ─────────────────────────────────────────────

Deno.test("selectBrokers orders by priority when all healthy", () => {
  const healthMap = new Map<string, BrokerHealth>();
  const selection = selectBrokers([conn2, conn1, conn3], healthMap, "EUR/USD");

  assertEquals(selection.connections.length, 3);
  assertEquals(selection.connections[0].id, "conn-1"); // Priority 1
  assertEquals(selection.connections[1].id, "conn-2"); // Priority 2
  assertEquals(selection.connections[2].id, "conn-3"); // Priority 3
  assertEquals(selection.hasDegradedConnections, false);
});

Deno.test("selectBrokers excludes inactive connections", () => {
  const healthMap = new Map<string, BrokerHealth>();
  const selection = selectBrokers([conn1, connInactive], healthMap, "EUR/USD");

  assertEquals(selection.connections.length, 1);
  assertEquals(selection.connections[0].id, "conn-1");
});

Deno.test("selectBrokers skips connections in circuit-breaker cooldown", () => {
  const healthMap = new Map<string, BrokerHealth>();
  healthMap.set("conn-1", {
    ...createInitialHealth("conn-1"),
    circuitOpen: true,
    cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    failCount: 3,
  });

  const selection = selectBrokers([conn1, conn2, conn3], healthMap, "EUR/USD");

  assertEquals(selection.connections[0].id, "conn-2"); // conn-1 skipped
  assertEquals(selection.hasDegradedConnections, true);
});

Deno.test("selectBrokers prefers lower-latency broker when latencyAware", () => {
  const healthMap = new Map<string, BrokerHealth>();
  // conn-1 has high latency, conn-2 has low latency (both same priority for this test)
  const c1 = { ...conn1, priority: 5 };
  const c2 = { ...conn2, priority: 5 };
  healthMap.set("conn-1", { ...createInitialHealth("conn-1"), avgLatencyMs: 4000, successCount: 10 });
  healthMap.set("conn-2", { ...createInitialHealth("conn-2"), avgLatencyMs: 200, successCount: 10 });

  const selection = selectBrokers([c1, c2], healthMap, "EUR/USD");
  assertEquals(selection.connections[0].id, "conn-2"); // Lower latency wins
});

Deno.test("selectBrokers returns empty for no active connections", () => {
  const healthMap = new Map<string, BrokerHealth>();
  const selection = selectBrokers([connInactive], healthMap, "EUR/USD");
  assertEquals(selection.connections.length, 0);
});

// ─── executeWithFailover Tests ───────────────────────────────────────

Deno.test("executeWithFailover succeeds on first try", async () => {
  const healthMap = new Map<string, BrokerHealth>();
  const selection = { connections: [conn1, conn2], reasoning: [], hasDegradedConnections: false };

  const executeFn = async (conn: BrokerConnection): Promise<ExecutionResult> => ({
    connectionId: conn.id, success: true, latencyMs: 100, isTransient: false,
  });

  const { result, attemptCount, failedConnections } = await executeWithFailover(
    selection, executeFn, healthMap,
  );

  assertEquals(result.success, true);
  assertEquals(result.connectionId, "conn-1");
  assertEquals(attemptCount, 1);
  assertEquals(failedConnections.length, 0);
});

Deno.test("executeWithFailover fails over to second broker on transient error", async () => {
  const healthMap = new Map<string, BrokerHealth>();
  const selection = { connections: [conn1, conn2], reasoning: [], hasDegradedConnections: false };

  let callCount = 0;
  const executeFn = async (conn: BrokerConnection): Promise<ExecutionResult> => {
    callCount++;
    if (conn.id === "conn-1") {
      return { connectionId: conn.id, success: false, latencyMs: 5000, error: "Timeout", isTransient: true };
    }
    return { connectionId: conn.id, success: true, latencyMs: 200, isTransient: false };
  };

  const { result, attemptCount, failedConnections } = await executeWithFailover(
    selection, executeFn, healthMap,
  );

  assertEquals(result.success, true);
  assertEquals(result.connectionId, "conn-2");
  assertEquals(attemptCount, 2);
  assertEquals(failedConnections, ["conn-1"]);
  assertEquals(callCount, 2);
});

Deno.test("executeWithFailover stops on non-transient error (no retry)", async () => {
  const healthMap = new Map<string, BrokerHealth>();
  const selection = { connections: [conn1, conn2, conn3], reasoning: [], hasDegradedConnections: false };

  let callCount = 0;
  const executeFn = async (conn: BrokerConnection): Promise<ExecutionResult> => {
    callCount++;
    return { connectionId: conn.id, success: false, latencyMs: 50, error: "Invalid API key", isTransient: false };
  };

  const { result, failedConnections } = await executeWithFailover(
    selection, executeFn, healthMap,
  );

  assertEquals(result.success, false);
  assertEquals(callCount, 1); // Stopped after first non-transient error
  assertEquals(failedConnections, ["conn-1"]);
});

Deno.test("executeWithFailover updates health map correctly", async () => {
  const healthMap = new Map<string, BrokerHealth>();
  healthMap.set("conn-1", createInitialHealth("conn-1"));
  healthMap.set("conn-2", createInitialHealth("conn-2"));

  const selection = { connections: [conn1, conn2], reasoning: [], hasDegradedConnections: false };

  const executeFn = async (conn: BrokerConnection): Promise<ExecutionResult> => {
    if (conn.id === "conn-1") {
      return { connectionId: conn.id, success: false, latencyMs: 5000, error: "Timeout", isTransient: true };
    }
    return { connectionId: conn.id, success: true, latencyMs: 150, isTransient: false };
  };

  await executeWithFailover(selection, executeFn, healthMap);

  const h1 = healthMap.get("conn-1")!;
  const h2 = healthMap.get("conn-2")!;
  assertEquals(h1.failCount, 1);
  assertEquals(h2.failCount, 0);
  assertEquals(h2.successCount, 1);
  assertEquals(h2.avgLatencyMs, 150);
});

// ─── reconcilePositions Tests ────────────────────────────────────────

Deno.test("reconcilePositions detects in-sync positions", () => {
  const expected: ExpectedPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 0.5, connectionIds: ["conn-1", "conn-2"] },
  ];
  const actual: BrokerPosition[] = [
    { connectionId: "conn-1", brokerName: "MT5", symbol: "EURUSD", direction: "long", size: 0.5 },
    { connectionId: "conn-2", brokerName: "OANDA", symbol: "EUR_USD", direction: "long", size: 0.5 },
  ];

  const result = reconcilePositions(expected, actual);
  assertEquals(result.inSync, true);
  assertEquals(result.mismatches.length, 0);
});

Deno.test("reconcilePositions detects missing position", () => {
  const expected: ExpectedPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 0.5, connectionIds: ["conn-1", "conn-2"] },
  ];
  const actual: BrokerPosition[] = [
    { connectionId: "conn-1", brokerName: "MT5", symbol: "EURUSD", direction: "long", size: 0.5 },
    // conn-2 is missing
  ];

  const result = reconcilePositions(expected, actual);
  assertEquals(result.inSync, false);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].mismatchType, "missing");
  assertEquals(result.mismatches[0].connectionId, "conn-2");
});

Deno.test("reconcilePositions detects wrong size", () => {
  const expected: ExpectedPosition[] = [
    { symbol: "GBP/USD", direction: "short", size: 1.0, connectionIds: ["conn-1"] },
  ];
  const actual: BrokerPosition[] = [
    { connectionId: "conn-1", brokerName: "MT5", symbol: "GBPUSD", direction: "short", size: 0.5 },
  ];

  const result = reconcilePositions(expected, actual);
  assertEquals(result.inSync, false);
  assertEquals(result.mismatches[0].mismatchType, "wrong_size");
  assertEquals(result.mismatches[0].actualSize, 0.5);
  assertEquals(result.mismatches[0].expectedSize, 1.0);
});

Deno.test("reconcilePositions detects extra positions on broker", () => {
  const expected: ExpectedPosition[] = [];
  const actual: BrokerPosition[] = [
    { connectionId: "conn-1", brokerName: "MT5", symbol: "USDJPY", direction: "long", size: 0.3 },
  ];

  const result = reconcilePositions(expected, actual);
  assertEquals(result.inSync, false);
  assertEquals(result.mismatches[0].mismatchType, "extra");
  assertEquals(result.mismatches[0].symbol, "USDJPY");
});

Deno.test("reconcilePositions handles multiple mismatches", () => {
  const expected: ExpectedPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 0.5, connectionIds: ["conn-1"] },
    { symbol: "GBP/USD", direction: "short", size: 1.0, connectionIds: ["conn-1"] },
  ];
  const actual: BrokerPosition[] = [
    { connectionId: "conn-1", brokerName: "MT5", symbol: "EURUSD", direction: "long", size: 0.5 },
    // GBP/USD missing
    { connectionId: "conn-1", brokerName: "MT5", symbol: "AUDUSD", direction: "long", size: 0.2 }, // Extra
  ];

  const result = reconcilePositions(expected, actual);
  assertEquals(result.inSync, false);
  assertEquals(result.mismatches.length, 2); // missing GBP/USD + extra AUD/USD
});
