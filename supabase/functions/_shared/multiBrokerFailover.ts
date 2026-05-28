/**
 * multiBrokerFailover.ts — Multi-Broker Failover & Routing Engine
 * ─────────────────────────────────────────────────────────────────────
 * Provides intelligent broker routing with automatic failover when a
 * primary broker is unavailable. Supports:
 *
 *   1. **Priority-based routing** — Brokers ranked by user preference
 *   2. **Health tracking** — Circuit breaker per connection (fail count, cooldown)
 *   3. **Automatic failover** — If primary fails, route to next healthy broker
 *   4. **Latency-aware selection** — Track response times, prefer faster brokers
 *   5. **Spread-aware routing** — Route to broker with best spread for the pair
 *   6. **Reconciliation** — Detect and report position mismatches across brokers
 *
 * Architecture:
 *   This module is STATELESS per invocation. Health state is passed in
 *   (from a DB table or in-memory cache in the calling function).
 *   The calling function (bot-scanner, zone-confirmation-scanner) uses
 *   this module to decide WHICH connection to route an order to.
 *
 * Integration:
 *   bot-scanner currently iterates connections sequentially. This module
 *   replaces that with: selectBroker() → execute → reportResult() → retry if needed.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface BrokerConnection {
  id: string;
  brokerType: "metaapi" | "oanda";
  displayName: string;
  accountId: string;
  isLive: boolean;
  isActive: boolean;
  priority: number; // Lower = higher priority (1 = primary)
}

export interface BrokerHealth {
  connectionId: string;
  /** Consecutive failure count */
  failCount: number;
  /** Timestamp of last failure (ISO) */
  lastFailure: string | null;
  /** Timestamp when circuit breaker resets (ISO) */
  cooldownUntil: string | null;
  /** Rolling average latency in ms (last 10 requests) */
  avgLatencyMs: number;
  /** Last known spread for each symbol (symbol → pips) */
  lastSpreads: Record<string, number>;
  /** Total successful executions */
  successCount: number;
  /** Whether this connection is currently in circuit-breaker open state */
  circuitOpen: boolean;
}

export interface FailoverConfig {
  /** Max consecutive failures before circuit breaker opens (default: 3) */
  maxFailures: number;
  /** Cooldown duration in seconds after circuit opens (default: 300 = 5 min) */
  cooldownSeconds: number;
  /** Max spread multiplier vs best available (default: 1.5) */
  maxSpreadMultiplier: number;
  /** Whether to prefer lower-latency brokers (default: true) */
  latencyAware: boolean;
  /** Max latency in ms before deprioritizing a broker (default: 5000) */
  maxLatencyMs: number;
  /** Whether to attempt parallel execution on multiple brokers (default: false) */
  parallelExecution: boolean;
}

export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  maxFailures: 3,
  cooldownSeconds: 300,
  maxSpreadMultiplier: 1.5,
  latencyAware: true,
  maxLatencyMs: 5000,
  parallelExecution: false,
};

export interface ExecutionResult {
  connectionId: string;
  success: boolean;
  latencyMs: number;
  error?: string;
  /** Whether the error is transient (network, timeout) vs permanent (auth, invalid) */
  isTransient: boolean;
  /** Spread at execution time (pips) */
  spreadPips?: number;
}

export interface BrokerSelection {
  /** Ordered list of connections to try (first = primary, rest = failover) */
  connections: BrokerConnection[];
  /** Reason for the selection order */
  reasoning: string[];
  /** Whether any connections are in cooldown */
  hasDegradedConnections: boolean;
}

export interface ReconciliationResult {
  /** Whether all brokers have matching positions */
  inSync: boolean;
  /** Mismatches found */
  mismatches: PositionMismatch[];
  /** Summary for logging */
  summary: string;
}

export interface PositionMismatch {
  symbol: string;
  expectedDirection: "long" | "short";
  expectedSize: number;
  connectionId: string;
  brokerName: string;
  actualDirection: "long" | "short" | "none";
  actualSize: number;
  mismatchType: "missing" | "wrong_direction" | "wrong_size" | "extra";
}

// ─── Health Management ───────────────────────────────────────────────

/**
 * Create initial health state for a connection.
 */
export function createInitialHealth(connectionId: string): BrokerHealth {
  return {
    connectionId,
    failCount: 0,
    lastFailure: null,
    cooldownUntil: null,
    avgLatencyMs: 0,
    lastSpreads: {},
    successCount: 0,
    circuitOpen: false,
  };
}

/**
 * Update health state after an execution result.
 * Returns the new health state (immutable update).
 */
export function updateHealth(
  health: BrokerHealth,
  result: ExecutionResult,
  config: FailoverConfig = DEFAULT_FAILOVER_CONFIG,
): BrokerHealth {
  const now = new Date().toISOString();

  if (result.success) {
    // Success: reset fail count, update latency
    const newAvg = health.successCount > 0
      ? (health.avgLatencyMs * Math.min(health.successCount, 9) + result.latencyMs) / (Math.min(health.successCount, 9) + 1)
      : result.latencyMs;

    return {
      ...health,
      failCount: 0,
      circuitOpen: false,
      cooldownUntil: null,
      avgLatencyMs: Math.round(newAvg),
      successCount: health.successCount + 1,
      lastSpreads: result.spreadPips !== undefined
        ? { ...health.lastSpreads }
        : health.lastSpreads,
    };
  }

  // Failure
  const newFailCount = health.failCount + 1;
  const shouldOpenCircuit = newFailCount >= config.maxFailures && result.isTransient;

  return {
    ...health,
    failCount: newFailCount,
    lastFailure: now,
    circuitOpen: shouldOpenCircuit,
    cooldownUntil: shouldOpenCircuit
      ? new Date(Date.now() + config.cooldownSeconds * 1000).toISOString()
      : health.cooldownUntil,
    avgLatencyMs: health.avgLatencyMs,
    successCount: health.successCount,
    lastSpreads: health.lastSpreads,
  };
}

/**
 * Check if a connection's circuit breaker has cooled down and can be retried.
 */
export function isConnectionAvailable(
  health: BrokerHealth,
  nowMs: number = Date.now(),
): boolean {
  if (!health.circuitOpen) return true;
  if (!health.cooldownUntil) return true;
  return nowMs >= new Date(health.cooldownUntil).getTime();
}

// ─── Broker Selection ────────────────────────────────────────────────

/**
 * Select the best broker(s) for order execution.
 * Returns an ordered list — caller should try them in sequence.
 *
 * Selection criteria (in priority order):
 *   1. Connection must be active and not in circuit-breaker cooldown
 *   2. User-defined priority (lower number = higher priority)
 *   3. Latency (if latencyAware = true)
 *   4. Spread (if spread data available for the symbol)
 */
export function selectBrokers(
  connections: BrokerConnection[],
  healthMap: Map<string, BrokerHealth>,
  symbol: string,
  config: FailoverConfig = DEFAULT_FAILOVER_CONFIG,
  nowMs: number = Date.now(),
): BrokerSelection {
  const reasoning: string[] = [];

  // Filter to active connections only
  const active = connections.filter((c) => c.isActive);
  if (active.length === 0) {
    return { connections: [], reasoning: ["No active connections"], hasDegradedConnections: false };
  }

  // Partition into available and degraded
  const available: BrokerConnection[] = [];
  const degraded: BrokerConnection[] = [];

  for (const conn of active) {
    const health = healthMap.get(conn.id) || createInitialHealth(conn.id);
    if (isConnectionAvailable(health, nowMs)) {
      available.push(conn);
    } else {
      degraded.push(conn);
      reasoning.push(`${conn.displayName}: circuit open (${health.failCount} failures, cooldown until ${health.cooldownUntil})`);
    }
  }

  if (available.length === 0) {
    // All connections degraded — try the one with earliest cooldown expiry
    const sorted = degraded.sort((a, b) => {
      const ha = healthMap.get(a.id);
      const hb = healthMap.get(b.id);
      const ta = ha?.cooldownUntil ? new Date(ha.cooldownUntil).getTime() : Infinity;
      const tb = hb?.cooldownUntil ? new Date(hb.cooldownUntil).getTime() : Infinity;
      return ta - tb;
    });
    reasoning.push("All connections degraded — using earliest-to-recover");
    return { connections: sorted, reasoning, hasDegradedConnections: true };
  }

  // Score each available connection
  const scored = available.map((conn) => {
    const health = healthMap.get(conn.id) || createInitialHealth(conn.id);
    let score = 0;

    // Priority (lower priority number = higher score)
    score += (10 - Math.min(conn.priority, 10)) * 100;

    // Latency bonus (lower latency = higher score)
    if (config.latencyAware && health.avgLatencyMs > 0) {
      if (health.avgLatencyMs <= config.maxLatencyMs) {
        score += Math.round((config.maxLatencyMs - health.avgLatencyMs) / 50);
      } else {
        score -= 50; // Penalty for slow connections
        reasoning.push(`${conn.displayName}: high latency (${health.avgLatencyMs}ms)`);
      }
    }

    // Spread bonus (lower spread = higher score)
    const lastSpread = health.lastSpreads[symbol];
    if (lastSpread !== undefined) {
      score += Math.round(10 / Math.max(lastSpread, 0.1));
    }

    // Reliability bonus (more successes = higher score, capped)
    score += Math.min(health.successCount, 50);

    return { conn, score, health };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  if (scored.length > 1) {
    reasoning.push(`Primary: ${scored[0].conn.displayName} (score=${scored[0].score}), Failover: ${scored.slice(1).map(s => s.conn.displayName).join(", ")}`);
  }

  return {
    connections: scored.map((s) => s.conn),
    reasoning,
    hasDegradedConnections: degraded.length > 0,
  };
}

// ─── Execution with Failover ─────────────────────────────────────────

/**
 * Execute an order with automatic failover.
 * Tries each connection in the selection order until one succeeds.
 *
 * @param selection - Result from selectBrokers()
 * @param executeFn - Function that attempts execution on a single connection
 * @param healthMap - Current health state (will be mutated with results)
 * @param config - Failover configuration
 * @returns The first successful result, or the last failure
 */
export async function executeWithFailover(
  selection: BrokerSelection,
  executeFn: (conn: BrokerConnection) => Promise<ExecutionResult>,
  healthMap: Map<string, BrokerHealth>,
  config: FailoverConfig = DEFAULT_FAILOVER_CONFIG,
): Promise<{ result: ExecutionResult; attemptCount: number; failedConnections: string[] }> {
  const failedConnections: string[] = [];
  let lastResult: ExecutionResult | null = null;

  for (const conn of selection.connections) {
    const result = await executeFn(conn);
    lastResult = result;

    // Update health
    const currentHealth = healthMap.get(conn.id) || createInitialHealth(conn.id);
    healthMap.set(conn.id, updateHealth(currentHealth, result, config));

    if (result.success) {
      return { result, attemptCount: failedConnections.length + 1, failedConnections };
    }

    failedConnections.push(conn.id);

    // Don't retry on non-transient errors (auth failure, invalid params)
    if (!result.isTransient) {
      break;
    }
  }

  return {
    result: lastResult || {
      connectionId: "",
      success: false,
      latencyMs: 0,
      error: "No connections available",
      isTransient: false,
    },
    attemptCount: failedConnections.length,
    failedConnections,
  };
}

// ─── Position Reconciliation ─────────────────────────────────────────

export interface BrokerPosition {
  connectionId: string;
  brokerName: string;
  symbol: string;
  direction: "long" | "short";
  size: number;
}

export interface ExpectedPosition {
  symbol: string;
  direction: "long" | "short";
  size: number;
  /** Which connections should have this position */
  connectionIds: string[];
}

/**
 * Reconcile expected positions (from paper_positions) against actual broker positions.
 * Identifies mismatches that need manual intervention.
 */
export function reconcilePositions(
  expected: ExpectedPosition[],
  actual: BrokerPosition[],
): ReconciliationResult {
  const mismatches: PositionMismatch[] = [];

  // Check each expected position exists on each expected broker
  for (const exp of expected) {
    for (const connId of exp.connectionIds) {
      const brokerPos = actual.find(
        (a) => a.connectionId === connId && normalizeSymbol(a.symbol) === normalizeSymbol(exp.symbol),
      );

      if (!brokerPos) {
        mismatches.push({
          symbol: exp.symbol,
          expectedDirection: exp.direction,
          expectedSize: exp.size,
          connectionId: connId,
          brokerName: actual.find((a) => a.connectionId === connId)?.brokerName || connId,
          actualDirection: "none",
          actualSize: 0,
          mismatchType: "missing",
        });
      } else if (brokerPos.direction !== exp.direction) {
        mismatches.push({
          symbol: exp.symbol,
          expectedDirection: exp.direction,
          expectedSize: exp.size,
          connectionId: connId,
          brokerName: brokerPos.brokerName,
          actualDirection: brokerPos.direction,
          actualSize: brokerPos.size,
          mismatchType: "wrong_direction",
        });
      } else if (Math.abs(brokerPos.size - exp.size) > 0.001) {
        mismatches.push({
          symbol: exp.symbol,
          expectedDirection: exp.direction,
          expectedSize: exp.size,
          connectionId: connId,
          brokerName: brokerPos.brokerName,
          actualDirection: brokerPos.direction,
          actualSize: brokerPos.size,
          mismatchType: "wrong_size",
        });
      }
    }
  }

  // Check for extra positions on brokers that aren't expected
  const expectedKeys = new Set(
    expected.flatMap((e) => e.connectionIds.map((c) => `${c}:${normalizeSymbol(e.symbol)}`)),
  );
  for (const pos of actual) {
    const key = `${pos.connectionId}:${normalizeSymbol(pos.symbol)}`;
    if (!expectedKeys.has(key)) {
      mismatches.push({
        symbol: pos.symbol,
        expectedDirection: pos.direction,
        expectedSize: 0,
        connectionId: pos.connectionId,
        brokerName: pos.brokerName,
        actualDirection: pos.direction,
        actualSize: pos.size,
        mismatchType: "extra",
      });
    }
  }

  const summary = mismatches.length === 0
    ? "All positions in sync"
    : `${mismatches.length} mismatch(es): ${mismatches.map((m) => `${m.symbol}@${m.brokerName}:${m.mismatchType}`).join(", ")}`;

  return { inSync: mismatches.length === 0, mismatches, summary };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeSymbol(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
