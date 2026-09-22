/**
 * Management-loop market-data telemetry. OBSERVATION ONLY. PURE.
 *
 * WHY. The 1-minute management cycle is the largest single consumer of provider
 * requests — roughly 23,400/day by subtraction — and it is invisible to the scan
 * telemetry, because that is reset and reported per full scan cycle and
 * management returns before it. Everything known about it today is inference
 * from a residual. This records it directly.
 *
 * IT CHANGES NOTHING. No fetch is added, removed, reordered or deduplicated by
 * this module. It observes the calls the loop already makes and answers, with
 * measurements rather than reading, the questions that decide whether grouping
 * or caching is worth doing:
 *
 *   - does each pending order cause its own fetch, or does the per-cycle
 *     `scanCache` already collapse them?
 *   - do two positions on one symbol/timeframe fetch twice?
 *   - are fetches issued when no management decision could change?
 *   - is the same bar re-fetched within one invocation?
 *
 * A `reason` tag is attached at each call site, because "which code path asked
 * for this" is the one thing a generic wrapper cannot infer and the only thing
 * that makes the totals actionable.
 *
 * ROLLING, NOT A LEDGER. The sink keeps per-reason and per-key aggregates plus a
 * bounded ring of recent invocations. It is operational data with a long expiry,
 * deliberately not a table: adding schema for a temporary measurement would
 * outlive the measurement.
 */

export const MGMT_TELEMETRY_VERSION = 1;
export const RECENT_INVOCATIONS = 60;

export const mgmtTelemetryKey = (userId: string, botId: string) =>
  `smc_mgmt_telemetry:${botId}:${userId}`;

/** Why a candle request was made. Tagged at the call site. */
export type FetchReason =
  | "open_position_price_refresh"
  | "rate_map"
  | "fotsi_daily"
  | "pending_fill_check"
  | "pending_thesis_htf"
  | "pending_thesis_m15"
  | "pending_thesis_weekly"
  | "pending_confirmation"
  | "untagged";

export interface FetchRecord {
  symbol: string;
  interval: string;
  reason: FetchReason;
  /** True when the per-invocation scanCache already had it. */
  cacheHit: boolean;
  bars: number;
  ms: number;
}

export interface InvocationRecord {
  at: string;
  mode: "manage" | "scan";
  durationMs: number;
  openPositions: number;
  pendingOrders: number;
  /** Distinct symbols across open positions and pending orders. */
  distinctSymbols: number;
  fetchCalls: number;
  /** Calls that reached the provider. `fetchCalls - providerFetches` is what the per-cycle cache already saves. */
  providerFetches: number;
  cacheHits: number;
  /** Distinct `symbol|interval` keys touched. The floor a perfect grouping could reach. */
  distinctKeys: number;
  byReason: Record<string, number>;
  /** Keys requested more than once in this invocation — pure waste if any. */
  repeatedKeys: Record<string, number>;
  managementActions: number;
  /** Provider requests refused by the shared budget during this invocation. */
  budgetRefused: number;
  /** Fetches abandoned at the wait ceiling. These surface as skipped work. */
  budgetGaveUp: number;
  /** Granted without accounting because the budget RPC failed. */
  budgetUnenforced: number;
  /** True when nothing was open and nothing pending, so no decision could change. */
  noEligibleWork: boolean;
}

export interface MgmtTelemetry {
  version: number;
  updatedAt: string;
  /** Invocations observed since the counters were last reset. */
  invocations: number;
  manageInvocations: number;
  /** Invocations with nothing to manage. Their fetches are the clearest waste. */
  idleInvocations: number;
  idleInvocationsThatFetched: number;
  totalFetchCalls: number;
  totalProviderFetches: number;
  totalCacheHits: number;
  totalsByReason: Record<string, number>;
  /** Provider fetches per `symbol|interval`, across all invocations. */
  totalsByKey: Record<string, number>;
  budgetRefused: number;
  budgetGaveUp: number;
  budgetUnenforced: number;
  recent: InvocationRecord[];
}

export function emptyTelemetry(): MgmtTelemetry {
  return {
    version: MGMT_TELEMETRY_VERSION,
    updatedAt: new Date(0).toISOString(),
    invocations: 0, manageInvocations: 0,
    idleInvocations: 0, idleInvocationsThatFetched: 0,
    totalFetchCalls: 0, totalProviderFetches: 0, totalCacheHits: 0,
    totalsByReason: {}, totalsByKey: {},
    budgetRefused: 0, budgetGaveUp: 0, budgetUnenforced: 0,
    recent: [],
  };
}

export function parseTelemetry(value: string | null | undefined): MgmtTelemetry | null {
  if (!value) return null;
  try {
    const t = JSON.parse(value) as MgmtTelemetry;
    return typeof t?.version === "number" && Array.isArray(t.recent) ? t : null;
  } catch {
    return null;
  }
}

/** Builds one invocation's record from the calls it made. */
export function summariseInvocation(
  input: {
    mode: "manage" | "scan";
    startedAtMs: number;
    endedAtMs: number;
    openPositions: number;
    pendingOrders: number;
    distinctSymbols: number;
    managementActions: number;
    budgetRefused: number;
    budgetGaveUp: number;
    budgetUnenforced: number;
  },
  fetches: FetchRecord[],
): InvocationRecord {
  const byReason: Record<string, number> = {};
  const keyCounts: Record<string, number> = {};
  let providerFetches = 0, cacheHits = 0;

  for (const f of fetches) {
    byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
    const key = `${f.symbol}|${f.interval}`;
    keyCounts[key] = (keyCounts[key] ?? 0) + 1;
    if (f.cacheHit) cacheHits++; else providerFetches++;
  }

  // A key asked for more than once in one invocation was served from the
  // per-cycle cache the second time, so it costs nothing at the provider — but
  // it is the signal that call sites are not aware of each other.
  const repeatedKeys: Record<string, number> = {};
  for (const [k, n] of Object.entries(keyCounts)) if (n > 1) repeatedKeys[k] = n;

  return {
    at: new Date(input.endedAtMs).toISOString(),
    mode: input.mode,
    durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
    openPositions: input.openPositions,
    pendingOrders: input.pendingOrders,
    distinctSymbols: input.distinctSymbols,
    fetchCalls: fetches.length,
    providerFetches,
    cacheHits,
    distinctKeys: Object.keys(keyCounts).length,
    byReason,
    repeatedKeys,
    managementActions: input.managementActions,
    budgetRefused: input.budgetRefused,
    budgetGaveUp: input.budgetGaveUp,
    budgetUnenforced: input.budgetUnenforced,
    // The question "could any decision have changed?" reduces to "was there
    // anything to decide about". Nothing open and nothing pending means every
    // request this invocation made was avoidable.
    noEligibleWork: input.openPositions === 0 && input.pendingOrders === 0,
  };
}

/** Folds one invocation into the rolling aggregate. */
export function accumulate(
  prev: MgmtTelemetry | null, rec: InvocationRecord,
): MgmtTelemetry {
  const t = prev && prev.version === MGMT_TELEMETRY_VERSION
    ? { ...prev, totalsByReason: { ...prev.totalsByReason }, totalsByKey: { ...prev.totalsByKey } }
    : emptyTelemetry();

  t.updatedAt = rec.at;
  t.invocations++;
  if (rec.mode === "manage") t.manageInvocations++;
  if (rec.noEligibleWork) {
    t.idleInvocations++;
    if (rec.providerFetches > 0) t.idleInvocationsThatFetched++;
  }
  t.totalFetchCalls += rec.fetchCalls;
  t.totalProviderFetches += rec.providerFetches;
  t.totalCacheHits += rec.cacheHits;
  for (const [k, n] of Object.entries(rec.byReason)) {
    t.totalsByReason[k] = (t.totalsByReason[k] ?? 0) + n;
  }
  t.budgetRefused += rec.budgetRefused;
  t.budgetGaveUp += rec.budgetGaveUp;
  t.budgetUnenforced += rec.budgetUnenforced;

  t.recent = [rec, ...t.recent].slice(0, RECENT_INVOCATIONS);
  return t;
}

/** Records provider fetches per key, so repeat-across-invocations is visible. */
export function accumulateKeys(
  t: MgmtTelemetry, fetches: FetchRecord[],
): MgmtTelemetry {
  const out = { ...t, totalsByKey: { ...t.totalsByKey } };
  for (const f of fetches) {
    if (f.cacheHit) continue;
    const key = `${f.symbol}|${f.interval}`;
    out.totalsByKey[key] = (out.totalsByKey[key] ?? 0) + 1;
  }
  return out;
}
