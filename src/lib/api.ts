import { supabase } from "@/integrations/supabase/client";
import { requireConfirmedBrokerMutation } from "@/lib/brokerMutationResult";

let brokerExecuteQueue: Promise<void> = Promise.resolve();
const functionCooldownUntil = new Map<string, number>();
const functionResponseCache = new Map<string, { data: any; expiresAt: number }>();

function jwtHasSubject(token?: string): boolean {
  if (!token) return false;
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    if (typeof claims?.sub !== "string" || claims.sub.length === 0) return false;
    // Treat tokens within 2 minutes of expiry as invalid so we refresh proactively.
    // Edge functions reject expired JWTs with a 500 before our retry path runs.
    if (typeof claims?.exp === "number" && claims.exp * 1000 - Date.now() < 120_000) return false;
    return true;
  } catch {
    return false;
  }
}

let refreshInFlight: Promise<string | null> | null = null;
let signOutRedirectTriggered = false;

/** Redirect to /login at most once — concurrent polls must not stack
 *  full-page navigations (that leaves the app on a blank screen). */
function redirectToLoginOnce(delayMs = 0) {
  if (typeof window === "undefined") return;
  if (signOutRedirectTriggered) return;
  if (window.location.pathname.startsWith("/login")) return;
  signOutRedirectTriggered = true;
  window.setTimeout(() => {
    window.location.replace("/login");
  }, delayMs);
}

// Single-flight refresh: concurrent polling calls must not fire competing
// refresh requests (the loser gets a revoked token and still 500s).
async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = supabase.auth
      .refreshSession()
      .then(async ({ data, error }) => {
        const token = data.session?.access_token;
        if (!error && token) return token;
        // refreshSession can fail transiently (offline, concurrent rotation).
        // Fall back to whatever the client has persisted before giving up.
        const { data: fallback } = await supabase.auth.getSession();
        const persisted = fallback.session?.access_token;
        return persisted && jwtHasSubject(persisted) ? persisted : null;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function getAuthenticatedToken(): Promise<string> {
  let { data: { session } } = await supabase.auth.getSession();
  let token = session?.access_token;
  if (!jwtHasSubject(token)) {
    token = (await refreshAccessToken()) ?? undefined;
  }
  if (!jwtHasSubject(token)) {
    await supabase.auth.signOut().catch(() => {});
    redirectToLoginOnce();
    throw new Error("Session expired. Please sign in again.");
  }
  return token!;
}

function functionCacheKey(functionName: string, body: Record<string, any>) {
  return `${functionName}:${JSON.stringify(body)}`;
}

function getFunctionFallback(functionName: string, body: Record<string, any>) {
  const cached = functionResponseCache.get(functionCacheKey(functionName, body));
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  if (functionName === "bot-scanner") {
    const action = body?.action;
    if (action === "pending_orders" && body?.status === "snapshot") {
      return {
        active: [],
        history: [],
        fetchedAt: null,
        fallback: true,
        error: "Zone Setup data is temporarily unavailable.",
      };
    }
    if (["scan_logs", "staged_setups", "active_staged", "pending_orders", "active_pending"].includes(action)) return [];
    if (action === "manual_scan") return { error: "Scanner is temporarily unavailable. Please try again shortly.", started: false, pairsScanned: 0, signalsFound: 0, tradesPlaced: 0 };
    return { ok: false, error: "Scanner is temporarily unavailable. Please try again shortly.", fallback: true };
  }

  if (functionName === "broker-execute") {
    const action = body?.action;
    if (["open_trades", "trade_history"].includes(action)) return [];
    if (["account_summary", "account_balance", "connection_status", "symbol_specs", "validate_symbol"].includes(action)) return { ok: false, error: "Broker service is temporarily unavailable. Please try again shortly.", fallback: true };
    if (action === "place_order") {
      return {
        error: "Broker execution is temporarily unavailable. The order was not sent; please retry shortly.",
        fallback: true,
      };
    }
    if (["close_trade", "modify_trade"].includes(action)) {
      return {
        error: "Broker execution could not be confirmed. Verify broker state before retrying.",
        fallback: true,
        brokerExecutionStatus: "uncertain",
      };
    }
  }

  if (functionName === "broker-connections") {
    const action = body?.action;
    if (["list", "list_symbols", "probe_symbols"].includes(action)) return [];
    return { error: "Broker connections are temporarily unavailable. Please retry shortly.", fallback: true };
  }

  if (functionName === "paper-trading") {
    const action = body?.action;
    if (action === "status") return { ok: false, error: "Paper trading service is temporarily unavailable. Please try again shortly.", fallback: true, engine_status: "unknown", positions: [], orders: [] };
    if (["place_order", "close_position", "update_position", "start_engine", "pause_engine", "stop_engine", "kill_switch", "reset_account", "reset_balance_only", "set_balance", "set_execution_mode"].includes(action)) return { error: "Paper trading is temporarily unavailable. Please retry shortly.", fallback: true };
  }

  return undefined;
}

function cacheSuccessfulFunctionResponse(functionName: string, body: Record<string, any>, data: any) {
  const action = body?.action;
  const cacheable =
    (functionName === "broker-execute" && ["account_summary", "account_balance", "connection_status", "open_trades", "trade_history"].includes(action)) ||
    (functionName === "paper-trading" && action === "status");
  if (cacheable && data && !data.error) {
    functionResponseCache.set(functionCacheKey(functionName, body), { data, expiresAt: Date.now() + 60_000 });
  }
}

async function invokeSupabaseFunction(functionName: string, body: Record<string, any>) {
  const run = async () => {
    try {
      const token = await getAuthenticatedToken();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${functionName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text ? { message: text } : null;
      }
      if (!response.ok) {
        return {
          data,
          error: {
            message: `Edge function returned ${response.status}: ${response.statusText || "Error"}${text ? `, ${text}` : ""}`,
            status: response.status,
            context: { status: response.status, response },
          },
        };
      }
      return { data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
  if (functionName !== "broker-execute") return run();

  const previous = brokerExecuteQueue.catch(() => undefined);
  const current = previous.then(run);
  brokerExecuteQueue = current.then(() => undefined, () => undefined);
  return current;
}

// Detect auth errors from the edge function (401 / Unauthorized / bad_jwt / missing sub claim)
function isAuthError(error: any, data: any): boolean {
  const msg = (error?.message || data?.error || "").toString().toLowerCase();
  const status = error?.context?.status ?? error?.status;
  if (status === 401 || status === 403) return true;
  return /unauthor|invalid.*jwt|bad.?jwt|missing sub|authenticated session|jwt.*expired|expired.*jwt/.test(msg);
}

// Helper to invoke edge functions with typed responses
export async function invokeFunction<T = any>(
  functionName: string,
  body: Record<string, any>
): Promise<T> {
  const cooldownUntil = functionCooldownUntil.get(functionName) || 0;
  const cooldownFallback = getFunctionFallback(functionName, body);
  if (cooldownFallback !== undefined && cooldownUntil > Date.now()) {
    return cooldownFallback as T;
  }

  let { data, error } = await invokeSupabaseFunction(functionName, body);

  // Transient platform 503 (SUPABASE_EDGE_RUNTIME_ERROR / cold-boot) — retry up to 2x with backoff.
  const isTransient503 = (err: any, d: any): boolean => {
    if (!err) return false;
    const ctx = err?.context;
    const status =
      ctx?.status ??
      ctx?.response?.status ??
      err?.status;
    if (isAuthError(err, d)) return false;
    if (typeof status === "number" && status >= 500) return true;
    const msg = (err?.message || d?.message || d?.error || "").toString();
    // Cloudflare/gateway HTML error pages (520-527, e.g. "525: SSL handshake failed")
    if (/<!DOCTYPE html|cf-error-details|SSL handshake failed|Cloudflare Ray ID|Error code 5\d\d/i.test(msg)) return true;
    return /temporarily unavailable|SUPABASE_EDGE_RUNTIME_ERROR|returned 5\d\d|BOOT_ERROR|WORKER_LIMIT/i.test(msg);
  };

  for (let attempt = 0; attempt < 4 && isTransient503(error, data); attempt++) {
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    ({ data, error } = await invokeSupabaseFunction(functionName, body));
  }

  if (isTransient503(error, data)) {
    functionCooldownUntil.set(functionName, Date.now() + 15_000);
    const transientFallback = getFunctionFallback(functionName, body);
    if (transientFallback !== undefined) return transientFallback as T;
  }


  // Bot scanner data is dashboard/polling data. If the hosted function is briefly
  // unavailable even after retries, return a safe empty result instead of letting
  // the Bot page crash into a blank screen.
  if (functionName === "bot-scanner" && isTransient503(error, data)) {
    const action = body?.action;
    if (action === "pending_orders" && body?.status === "snapshot") {
      return {
        active: [],
        history: [],
        fetchedAt: null,
        fallback: true,
        error: "Zone Setup data is temporarily unavailable.",
      } as T;
    }
    if (["scan_logs", "staged_setups", "active_staged", "pending_orders", "active_pending"].includes(action)) {
      return [] as T;
    }
    if (action === "manual_scan") {
      return {
        error: "Scanner is temporarily unavailable. Please try again shortly.",
        started: false,
        pairsScanned: 0,
        signalsFound: 0,
        tradesPlaced: 0,
      } as T;
    }
    // Any other bot-scanner action (dismiss_staged, cancel_pending, etc.):
    // return a structured fallback rather than throwing into a blank screen.
    return {
      ok: false,
      error: "Scanner is temporarily unavailable. Please try again shortly.",
      fallback: true,
    } as T;
  }

  // Broker execution can be polled from live dashboards. If the hosted runtime
  // briefly returns a platform 503 after retries, keep read-only views alive and
  // return a clear fallback for write actions instead of throwing into a blank screen.
  if (functionName === "broker-execute" && isTransient503(error, data)) {
    const action = body?.action;
    if (["open_trades", "trade_history"].includes(action)) {
      return [] as T;
    }
    if (["account_summary", "account_balance", "connection_status", "symbol_specs", "validate_symbol"].includes(action)) {
      return {
        ok: false,
        error: "Broker service is temporarily unavailable. Please try again shortly.",
        fallback: true,
      } as T;
    }
    if (action === "place_order") {
      return {
        error: "Broker execution is temporarily unavailable. The order was not sent; please retry shortly.",
        fallback: true,
      } as T;
    }
    if (["close_trade", "modify_trade"].includes(action)) {
      return {
        error: "Broker execution could not be confirmed. Verify broker state before retrying.",
        fallback: true,
        brokerExecutionStatus: "uncertain",
      } as T;
    }
  }

  // Paper-trading is polled from the dashboard. If the hosted runtime briefly
  // returns a platform 503 after retries, keep read-only views alive and return
  // a clear fallback for write actions instead of crashing into a blank screen.
  if (functionName === "paper-trading" && isTransient503(error, data)) {
    const action = body?.action;
    if (action === "status") {
      return {
        ok: false,
        error: "Paper trading service is temporarily unavailable. Please try again shortly.",
        fallback: true,
        engine_status: "unknown",
        positions: [],
        orders: [],
      } as T;
    }
    if ([
      "place_order", "close_position", "update_position",
      "start_engine", "pause_engine", "stop_engine",
      "kill_switch", "reset_account", "reset_balance_only",
      "set_balance", "set_execution_mode",
    ].includes(action)) {
      return {
        error: "Paper trading is temporarily unavailable. Please retry shortly.",
        fallback: true,
      } as T;
    }
  }

  // If auth failed, try refreshing the session once and retry.
  if (isAuthError(error, data)) {
    const refreshedToken = await refreshAccessToken();
    if (refreshedToken) {
      ({ data, error } = await invokeSupabaseFunction(functionName, body));
    }
    if (isAuthError(error, data)) {
      // Confirm the session is really gone before tearing the app down — a
      // single 401 on an expired JWT must not blank the screen if the client
      // still holds (or just obtained) a valid session.
      const { data: check } = await supabase.auth.getSession();
      const stillValid = jwtHasSubject(check.session?.access_token);
      if (stillValid) {
        ({ data, error } = await invokeSupabaseFunction(functionName, body));
      }
    }
    if (isAuthError(error, data)) {
      const authFallback = getFunctionFallback(functionName, body);
      await supabase.auth.signOut().catch(() => {});
      if (typeof window !== "undefined" && !signOutRedirectTriggered) {
        try {
          const { toast } = await import("sonner");
          toast.error("Session expired", {
            description: "Redirecting you to sign in again…",
            duration: 2500,
          });
        } catch {}
      }
      redirectToLoginOnce(1800);
      if (authFallback !== undefined) return authFallback as T;
      throw new Error("Session expired. Please sign in again.");
    }
  }

  if (error) throw new Error(error.message || `${functionName} failed`);
  if (data?.error && !data?.fallback) throw new Error(data.error);
  functionCooldownUntil.delete(functionName);
  cacheSuccessfulFunctionResponse(functionName, body, data);
  return data as T;
}

// ── Market Data ──
export type CandleSource = "metaapi" | "oanda" | "twelvedata" | "polygon" | "kv_cache" | "scan_cache" | "none" | "unknown";
export interface CandlesWithMeta { candles: any[]; source: CandleSource; }
export interface BotEvidenceCandles extends CandlesWithMeta { scanCycleId: string | null; observedAt: string | null; completedCandleCutoff: string | null; }

// Low-level fetch so we can read the x-data-source response header
// (the supabase-js invoke() helper doesn't expose response headers).
async function fetchMarketData(body: Record<string, any>): Promise<{ data: any; source: CandleSource }> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-data`;
  const token = await getAuthenticatedToken();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const source = (res.headers.get("x-data-source") as CandleSource) || "unknown";
  if (!res.ok) throw new Error(data?.error || `market-data ${res.status}`);
  if (data?.error && !data?.fallback) throw new Error(data.error);
  return { data, source };
}

export const marketApi = {
  candles: (symbol: string, interval: string, outputsize = 200) =>
    invokeFunction("market-data", { action: "candles", symbol, interval, outputsize }),
  // Returns candles plus the source ("metaapi" | "oanda" | "twelvedata" | "polygon") so the UI
  // can surface where prices are actually coming from.
  botEvidenceCandles: async (symbol: string, interval: string): Promise<BotEvidenceCandles> => {
    const { data, source } = await fetchMarketData({ action: "bot_evidence_candles", symbol, interval });
    return {
      candles: Array.isArray(data?.candles) ? data.candles : [], source,
      scanCycleId: data?.scan_cycle_id ?? null, observedAt: data?.observed_at ?? null,
      completedCandleCutoff: data?.completed_candle_cutoff ?? null,
    };
  },
  candlesWithMeta: async (symbol: string, interval: string, outputsize = 200): Promise<CandlesWithMeta> => {
    const { data, source } = await fetchMarketData({ action: "candles", symbol, interval, outputsize });
    return { candles: Array.isArray(data) ? data : [], source };
  },
  quote: (symbol: string) =>
    invokeFunction("market-data", { action: "quote", symbol }),
  batchQuotes: (symbols: string[]) =>
    invokeFunction<Record<string, { price: number; change: number; percentChange: number; open: number; high: number; low: number; previousClose: number; source: string; error?: string }>>("market-data", { action: "batch_quotes", symbols }),
};

// ── Bot Config ──
export const botConfigApi = {
  get: (connectionId?: string) => invokeFunction("bot-config", { action: "get", connectionId }),
  getEffective: (connectionId?: string) =>
    invokeFunction<{
      effectiveConfig: any;
      provenance: {
        contractVersion: string;
        source: "saved_connection" | "saved_global" | "built_in_defaults";
        configId: string | null;
        connectionId: string | null;
        updatedAt: string | null;
        rawConfigHash: string;
        effectiveConfigHash: string;
        loadedAt: string;
        criticalSettings: {
          tradingStyle: string;
          requireLiquiditySweep: boolean;
          requireUnifiedZone: boolean;
          impulseZoneGateMode: string;
          zoneLocalEnforcementMode: string;
          crossTfAuthorityMode: string;
          dealingRangeMode: string;
          minConfluence: number;
          riskPerTrade: number;
        };
      };
    }>("bot-config", { action: "effective", connectionId }),
  getDefaults: () => invokeFunction("bot-config", { action: "defaults" }),
  update: (config: any, connectionId?: string) => invokeFunction("bot-config", { action: "update", config, connectionId }),
  reset: (connectionId?: string) => invokeFunction("bot-config", { action: "reset", connectionId }),
  getICTScannerComparison: () => invokeFunction<{
    summary: {
      sampleSize: number; comparable: number; unavailable: number; coveragePercent: number;
      agreements: number; disagreements: number; workflowAllows: number; workflowWatches: number; workflowBlocks: number;
      winnersPreserved: number; winnersBlocked: number; poorEntriesRejected: number; poorEntriesWatched: number; poorEntriesAllowed: number;
      stageCounts: Record<string, number>;
    };
    rows: Array<{
      id: string; source: "closed" | "rejected"; symbol: string; direction: string; observedAt: string;
      outcome: "won" | "lost" | "inconclusive"; actualDecision: "allow" | "block";
      workflowDecision: "allow" | "watch" | "block" | null; stage: string | null;
      reasonCode: string | null; explanation: string | null; comparable: boolean;
      decisionsMatch: boolean | null; missingAuthorities: string[]; authorities: any[]; state: any | null;
    }>;
  }>("bot-config", { action: "ict_scanner.comparison" }),
  getAuthorityOutcomeComparison: () => invokeFunction<import("@/components/AuthorityOutcomeResearchCard").AuthorityOutcomeReport>("bot-config", { action: "authority_outcome.comparison" }),
  getSingleOwnershipComparison: () => invokeFunction<{
    summary: { sampleSize: number; comparable: number; unavailable: number; coveragePercent: number; agreements: number; disagreements: number; winnersPreserved: number; winnersBlocked: number; poorEntriesRejected: number; poorEntriesAllowed: number; };
    rows: Array<{ id: string; source: "closed" | "rejected"; symbol: string; direction: string; observedAt: string; outcome: "won" | "lost" | "inconclusive"; legacyDecision: "allow" | "block"; proposedDecision: "allow" | "watch" | "block" | "unavailable" | null; comparable: boolean; decisionsMatch: boolean | null; reasonCodes: string[]; unavailable: string[]; legacyDiagnostics: any; }>;
  }>("bot-config", { action: "single_ownership.comparison" }),
  getStreamlinedDecisionComparison: () => invokeFunction<{
    summary: { sampleSize: number; comparable: number; unavailable: number; coveragePercent: number; agreements: number; disagreements: number; winnersPreserved: number; winnersBlocked: number; poorEntriesRejected: number; poorEntriesAllowed: number; };
    rows: Array<{ id: string; source: "closed" | "rejected"; symbol: string; direction: string; observedAt: string; outcome: "won" | "lost" | "inconclusive"; currentDecision: "allow" | "block"; proposedDecision: "allow" | "watch" | "block" | "unavailable" | null; comparable: boolean; disagreementReasons: string[]; summary: any | null; }>;
  }>("bot-config", { action: "streamlined_decision.comparison" }),
  getDealingRangeComparison: () => invokeFunction<{
    summary: {
      sampleSize: number; available: number; unavailable: number;
      agreements: number; disagreements: number;
      canonicalAllowed: number; canonicalBlocked: number;
      winnersPreserved: number; winnersBlocked: number;
      poorEntriesRejected: number; poorEntriesAllowed: number;
    };
    rows: Array<{
      id: string; source: "closed" | "rejected"; symbol: string; direction: string;
      observedAt: string; outcome: "won" | "lost" | "inconclusive";
      rollingAllowed: boolean | null; canonicalAllowed: boolean | null;
      canonicalPercent: number | null; explanation: string | null; decisionsMatch: boolean | null;
    }>;
  }>("bot-config", { action: "dealing_range.comparison" }),
  // Preset CRUD
  listPresets: () => invokeFunction<Array<{ id: string; name: string; description: string; config_json: any; created_at: string; updated_at: string }>>("bot-config", { action: "presets.list" }),
  savePreset: (name: string, config: any, description?: string) => invokeFunction<{ success: boolean; id: string; updated: boolean }>("bot-config", { action: "presets.save", name, config, description }),
  deletePreset: (presetId: string) => invokeFunction<{ success: boolean }>("bot-config", { action: "presets.delete", presetId }),
};

// ── Trades (Journal) ──
export const tradesApi = {
  reviews: (limit = 250) => invokeFunction("trades", { action: "reviews", limit }),
  saveReview: (review: {
    positionId: string; reviewStatus: "pending" | "reviewed";
    notes?: string; lesson?: string; tags?: string[];
  }) => invokeFunction("trades", { action: "save_review", ...review }),
  list: (limit = 50, offset = 0) => invokeFunction("trades", { action: "list", limit, offset }),
  get: (id: string) => invokeFunction("trades", { action: "get", id }),
  create: (trade: any) => invokeFunction("trades", { action: "create", trade }),
  update: (trade: any) => invokeFunction("trades", { action: "update", trade }),
  delete: (id: string) => invokeFunction("trades", { action: "delete", id }),
  stats: () => invokeFunction("trades", { action: "stats" }),
  equityCurve: () => invokeFunction("trades", { action: "equity_curve" }),
  importFromPaper: () => invokeFunction("trades", { action: "import_from_paper" }),
};

// ── User Settings ──
export const settingsApi = {
  get: () => invokeFunction("user-settings", { action: "get" }),
  upsert: (risk_settings?: any, preferences?: any) =>
    invokeFunction("user-settings", { action: "upsert", risk_settings, preferences }),
};

// ── Broker Connections ──
export const brokerApi = {
  list: () => invokeFunction("broker-connections", { action: "list" }),
  create: (data: { broker_type: string; display_name: string; api_key: string; account_id: string; is_live?: boolean; symbol_suffix?: string; symbol_overrides?: Record<string, string>; commission_per_lot?: number }) =>
    invokeFunction("broker-connections", { action: "create", ...data }),
  update: (data: any) => invokeFunction("broker-connections", { action: "update", ...data }),
  delete: (id: string) => invokeFunction("broker-connections", { action: "delete", id }),
  test: (id: string) => invokeFunction("broker-connections", { action: "test", id }),
  listSymbols: (id: string) => invokeFunction("broker-connections", { action: "list_symbols", id }),
  autoMapSymbols: (id: string) => invokeFunction("broker-connections", { action: "auto_map_symbols", id }),
  probeSymbols: (id: string, symbols: string[]) =>
    invokeFunction("broker-connections", { action: "probe_symbols", id, symbols }),
};

// ── SMC Analysis ──
export const smcApi = {
  fullAnalysis: (candles: any[], dailyCandles?: any[]) =>
    invokeFunction("smc-analysis", { action: "full_analysis", candles, dailyCandles }),
  currencyStrength: (pairData: Record<string, { change: number }>) =>
    invokeFunction("smc-analysis", { action: "currency_strength", pairData }),
  correlation: (data1: number[], data2: number[]) =>
    invokeFunction("smc-analysis", { action: "correlation", data1, data2 }),
  session: () => invokeFunction("smc-analysis", { action: "session" }),
};

// ── Paper Trading ──
export const paperApi = {
  status: () => invokeFunction("paper-trading", { action: "status" }),
  placeOrder: (order: { symbol: string; direction: string; size: number; entryPrice: number; stopLoss?: number; takeProfit?: number; signalReason?: string; signalScore?: number }) =>
    invokeFunction("paper-trading", { action: "place_order", ...order }),
  closePosition: (positionId: string, exitPrice?: number, reason?: string) =>
    invokeFunction("paper-trading", { action: "close_position", positionId, exitPrice, reason }),
  updatePosition: (positionId: string, updates: { stopLoss?: number | null; takeProfit?: number | null; tradeOverrides?: Record<string, any> | null }) =>
    invokeFunction("paper-trading", { action: "update_position", positionId, ...updates }),
  startEngine: () => invokeFunction("paper-trading", { action: "start_engine" }),
  pauseEngine: () => invokeFunction("paper-trading", { action: "pause_engine" }),
  stopEngine: () => invokeFunction("paper-trading", { action: "stop_engine" }),
  killSwitch: (active: boolean) => invokeFunction("paper-trading", { action: "kill_switch", active }),
  resetAccount: () => invokeFunction("paper-trading", { action: "reset_account" }),
  resetBalanceOnly: () => invokeFunction("paper-trading", { action: "reset_balance_only" }),
  setBalance: (balance: number) => invokeFunction("paper-trading", { action: "set_balance", balance }),
  setExecutionMode: (mode: "paper" | "live") =>
    invokeFunction<{
      success?: boolean;
      executionMode?: "paper" | "live";
      error?: string;
      fallback?: boolean;
    }>("paper-trading", { action: "set_execution_mode", mode }),
};

// ── Backtest Engine ──
export const backtestApi = {
  start: (params: {
    instruments: string[];
    startDate: string;
    endDate: string;
    startingBalance: number;
    config: any;
    tradingStyle?: string;
    slippagePips?: number;
    spreadPips?: number;
    commissionPerLot?: number;
    walkForwardFolds?: number;
    researchMode?: boolean;
    zoneLocalReplayEvidence?: boolean;
    historySource?: "provider" | "mt5";
  }) => invokeFunction<{ runId: string; status: string; message: string }>("backtest-engine", { action: "start", ...params }),
  status: (runId: string) => invokeFunction<{
    id: string; status: string; progress: number; progress_message: string;
    results: any; error_message: string | null;
    created_at: string; started_at: string | null; completed_at: string | null;
  }>("backtest-engine", { action: "status", runId }),
  list: (limit = 10) => invokeFunction<Array<{
    id: string; status: string; progress: number; progress_message: string;
    error_message: string | null; created_at: string; started_at: string | null;
    completed_at: string | null; config: any;
  }>>("backtest-engine", { action: "list", limit }),
  cancel: (runId: string) => invokeFunction<{ status: string; message: string }>("backtest-engine", { action: "cancel", runId }),
  listMT5: () => invokeFunction<any[]>("backtest-engine", { action: "mt5_list" }),
  registerMT5: (params: { symbol: string; storagePath: string; originalFilename: string; source?: "mt4" | "mt5"; timezoneOffsetMinutes?: number }) =>
    invokeFunction<any>("backtest-engine", { action: "mt5_register", ...params }),
  deleteMT5: (datasetId: string) =>
    invokeFunction<{ deleted: boolean }>("backtest-engine", { action: "mt5_delete", datasetId }),
  uploadMT5: async (symbol: string, file: File, timezoneOffsetMinutes = 0) => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) throw new Error("Sign in before uploading history");
    if (file.size > 75 * 1024 * 1024) throw new Error("History file exceeds the 75 MB limit");
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${auth.user.id}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await supabase.storage.from("backtest-history")
      .upload(path, file, { contentType: file.type || "text/csv", upsert: false });
    if (error) throw error;
    try {
      return await backtestApi.registerMT5({ symbol, storagePath: path, originalFilename: file.name, source: "mt5", timezoneOffsetMinutes });
    } catch (error) {
      await supabase.storage.from("backtest-history").remove([path]);
      throw error;
    }
  },
};

// ── Bot Scanner (Bot #1 — SMC) ──
async function hydrateImpulseEntryLifecycles(
  rows: StagedSetup[],
): Promise<StagedSetup[]> {
  const ids = rows
    .map((row: any) => row.impulse_entry_lifecycle_id)
    .filter((id: unknown): id is string => typeof id === "string");
  if (ids.length === 0) return rows;
  const { data, error } = await (supabase as any)
    .from("impulse_entry_lifecycles")
    .select("id,lifecycle")
    .in("id", ids);
  // Preserve compatibility while a frontend deploy precedes its migration.
  if (error) return rows;
  const current = new Map(
    (data || []).map((row: any) => [row.id, row.lifecycle]),
  );
  return rows.map((row: any) => ({
    ...row,
    impulse_entry_lifecycle:
      current.get(row.impulse_entry_lifecycle_id) ||
      row.impulse_entry_lifecycle ||
      null,
  }));
}

/** Narrow a possibly-string JSON number to a number, or null. */
function numOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** One Gameplan scenario, flattened with its parent plan's context. */
export interface PlanScenarioRow {
  symbol: string;
  bias: string | null;
  biasConfidence: number | null;
  state: string | null;
  expiresAt: string | null;
  index: number;
  direction: string | null;
  condition: string;
  entryLevel: number | null;
  targetLevel: number | null;
  rewardPips: number | null;
  minStopPips: number | null;
  /** null when the scenario has no target to judge. */
  viable: boolean | null;
  viabilityNote: string | null;
}

/** A hand-marked impulse. You draw it on TradingView; the bot trades it. */
export interface ManualImpulseRow {
  id: string;
  symbol: string;
  direction: "bullish" | "bearish";
  high: number;
  low: number;
  timeframe: "D" | "4H" | "1H";
  high_time: string | null;
  low_time: string | null;
  status: "active" | "invalidated" | "expired" | "cancelled" | "filled";
  resolution_reason: string | null;
  last_resolution_detail: string | null;
  last_resolved_at: string | null;
  expires_at: string;
  created_at: string;
}

export const manualImpulseApi = {
  list: async (): Promise<ManualImpulseRow[]> => {
    const { data, error } = await (supabase as any)
      .from("manual_impulses")
      .select("*")
      .eq("bot_id", "smc")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data || []).map((r: any) => ({
      ...r,
      high: Number(r.high),
      low: Number(r.low),
    }));
  },
  create: async (input: {
    symbol: string;
    direction: "bullish" | "bearish";
    high: number;
    low: number;
    timeframe: "D" | "4H" | "1H";
    validHours: number;
    highTime?: string | null;
    lowTime?: string | null;
  }): Promise<ManualImpulseRow> => {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Not signed in.");
    // One live marking per symbol — retire any existing one first so the
    // partial unique index cannot reject the insert.
    await (supabase as any)
      .from("manual_impulses")
      .update({ status: "cancelled", resolution_reason: "replaced_by_new_marking" })
      .eq("user_id", userId).eq("bot_id", "smc")
      .eq("symbol", input.symbol).eq("status", "active");
    const { data, error } = await (supabase as any)
      .from("manual_impulses")
      .insert({
        user_id: userId,
        bot_id: "smc",
        symbol: input.symbol,
        direction: input.direction,
        high: input.high,
        low: input.low,
        timeframe: input.timeframe,
        high_time: input.highTime || null,
        low_time: input.lowTime || null,
        expires_at: new Date(Date.now() + input.validHours * 3600_000).toISOString(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return { ...data, high: Number(data.high), low: Number(data.low) };
  },
  cancel: async (id: string): Promise<void> => {
    const { error } = await (supabase as any)
      .from("manual_impulses")
      .update({ status: "cancelled", resolution_reason: "cancelled_by_user" })
      .eq("id", id);
    if (error) throw new Error(error.message);
  },
};

export const scannerApi = {
  manualScan: () => invokeFunction("bot-scanner", { action: "manual_scan" }),
  refreshGamePlan: () => invokeFunction<{
    success: boolean;
    generatedAt: string;
    session: string;
    planCount: number;
    tradeableCount: number;
    waitCount: number;
    skipCount: number;
  }>("game-plan-refresh", { action: "refresh" }),
  logs: async () => {
    const { data, error } = await (supabase as any)
      .from("scan_logs")
      .select("*")
      .order("scanned_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data || [];
  },
  /**
   * Scenarios from the currently active Gameplan, annotated with whether their
   * target is reachable at all.
   *
   * A scenario names an entry and a target; the instrument's MIN_SL_PIPS fixes
   * the smallest legal risk, so a target closer than `minStop x minRR` can never
   * be traded at an acceptable reward-to-risk. Observation only — nothing gates
   * on these fields; they exist so an unviable plan cannot look tradeable.
   */
  activePlanScenarios: async (): Promise<PlanScenarioRow[]> => {
    const { data, error } = await (supabase as any)
      .from("active_game_plans")
      .select("symbol,bias,bias_confidence,state,generated_at,expires_at,plan_json")
      .eq("bot_id", "smc")
      .eq("is_active", true)
      .gt("expires_at", new Date().toISOString())
      .order("symbol", { ascending: true });
    if (error) throw new Error(error.message);
    const rows: PlanScenarioRow[] = [];
    for (const plan of data || []) {
      const scenarios = plan?.plan_json?.scenarios;
      if (!Array.isArray(scenarios)) continue;
      scenarios.forEach((scenario: any, index: number) => {
        rows.push({
          symbol: plan.symbol,
          bias: plan.bias ?? null,
          biasConfidence: plan.bias_confidence ?? null,
          state: plan.state ?? null,
          expiresAt: plan.expires_at ?? null,
          index,
          direction: scenario?.direction ?? null,
          condition: scenario?.condition ?? "",
          entryLevel: numOrNull(scenario?.entryLevel),
          targetLevel: numOrNull(scenario?.targetLevel),
          rewardPips: numOrNull(scenario?.rewardPips),
          minStopPips: numOrNull(scenario?.minStopPips),
          // undefined means the scenario carries no target to judge
          viable: typeof scenario?.viable === "boolean" ? scenario.viable : null,
          viabilityNote: scenario?.viabilityNote ?? null,
        });
      });
    }
    return rows;
  },
  // Setup Staging / Watchlist
  activeStaged: async (): Promise<StagedSetup[]> => {
    const { data, error } = await (supabase as any)
      .from("staged_setups")
      .select("*")
      .eq("bot_id", "smc")
      .in("status", ["watching", "qualified"])
      .order("current_score", { ascending: false });
    if (error) throw new Error(error.message);
    return hydrateImpulseEntryLifecycles(data || []);
  },
  allStaged: async (): Promise<StagedSetup[]> => {
    const { data, error } = await (supabase as any)
      .from("staged_setups")
      .select("*")
      .eq("bot_id", "smc")
      .order("staged_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return hydrateImpulseEntryLifecycles(data || []);
  },
  dismissStaged: async (setupId: string) => {
    const { error } = await (supabase as any)
      .from("staged_setups")
      .update({
        status: "invalidated",
        invalidation_reason: "Manually dismissed by user",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", setupId);
    if (error) throw new Error(error.message);
    return { success: true };
  },
  // Pending / Limit Orders — routed through bot-scanner edge function (uses adminClient, bypasses RLS)
  activePending: async (): Promise<PendingOrder[]> => {
    return invokeFunction<PendingOrder[]>("bot-scanner", { action: "active_pending" });
  },
  allPending: async (): Promise<PendingOrder[]> => {
    return invokeFunction<PendingOrder[]>("bot-scanner", { action: "pending_orders", status: "all" });
  },
  pendingSnapshot: async (): Promise<PendingOrderSnapshot> => {
    return invokeFunction<PendingOrderSnapshot>("bot-scanner", {
      action: "pending_orders",
      status: "snapshot",
    });
  },
  cancelPending: async (orderId: string) => {
    return invokeFunction("bot-scanner", { action: "cancel_pending", orderId });
  },
};

// ── Staged Setup Type ──
export interface StagedSetup {
  id: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  direction: "long" | "short";
  initial_score: number;
  current_score: number;
  watch_threshold: number;
  initial_factors: Array<{ name: string; weight: number; tier?: string }>;
  current_factors: Array<{ name: string; weight: number; tier?: string }>;
  missing_factors: Array<{ name: string; weight: number; tier?: string }>;
  entry_price: number | null;
  sl_level: number | null;
  tp_level: number | null;
  status:
    | "watching"
    | "qualified"
    | "pending"
    | "awaiting_confirmation"
    | "filled"
    | "blocked_after_qualification"
    | "invalidated"
    | "expired"
    | "cancelled"
    | "promoted";
  candidate_id: string;
  lifecycle_version?: string;
  lifecycle_reason?: string | null;
  lifecycle_phase?: string | null;
  lifecycle_reason_code?: string | null;
  lifecycle_evidence?: {
    version?: string;
    reasonCode?: string;
    phase?: string;
    milestones?: string[];
    observedAt?: string;
    observedPrice?: number | null;
    frozenDirection?: "long" | "short" | null;
    freshDirection?: "long" | "short" | null;
    boundary?: {
      level?: number | null;
      source?: string;
      bufferPrice?: number | null;
      zone?: { low?: number; high?: number } | null;
    } | null;
    score?: number | null;
    threshold?: number | null;
    sweep?: Record<string, unknown> | null;
    detail?: Record<string, unknown> | null;
  } | null;
  impulse_entry_lifecycle_id?: string | null;
  impulse_entry_lifecycle?: {
    mode: "off" | "observe" | "enforce";
    status: "active" | "entered" | "invalidated" | "expired" | "exhausted";
    activeCandidateId: string | null;
    impulse: { timeframe: string; protectedLevel: number };
    candidates: Array<{ id: string; type: string; low: number; high: number; timeframe: string; state: string }>;
    lastTransitionReason: string;
  } | null;
  qualified_at?: string | null;
  pending_order_id?: string | null;
  position_id?: string | null;
  game_plan_id?: string | null;
  game_plan_version?: string | null;
  direction_verdict_id?: string | null;
  direction_verdict?: any;
  thesis_version?: string | null;
  originating_zone?: any;
  execution_eligible: boolean;
  observation_parent_id?: string | null;
  observation_reason?: string | null;
  confirmation_method?: "choch" | "indicators" | "choch_and_indicators" | null;
  confirmation_config?: {
    indicatorMinCount?: number;
    afterChochMode?: "confirmation_close" | "observe_retracement" | "wait_retracement";
    afterChochExpiryMinutes?: number;
  };
  authorization_result?: any;
  scan_cycles: number;
  min_cycles: number;
  ttl_minutes: number;
  promotion_reason: string | null;
  invalidation_reason: string | null;
  setup_type: string | null;
  tier1_count: number;
  tier2_count: number;
  tier3_count: number;
  analysis_snapshot: any;
  staged_at: string;
  last_eval_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Pending Order Type ──
export interface PendingOrderSnapshot {
  active: PendingOrder[];
  history: PendingOrder[];
  fetchedAt: string | null;
  fallback?: boolean;
  error?: string;
}

export interface PendingOrder {
  order_id: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  direction: "long" | "short";
  order_type: "limit" | "limit_ob" | "limit_fvg";
  entry_price: number;
  current_price: number | null;
  stop_loss: number;
  take_profit: number;
  size: number | null;
  entry_zone_type: string;
  entry_zone_low: number;
  entry_zone_high: number;
  status: "pending" | "awaiting_confirmation" | "filled" | "invalidated" | "expired" | "cancelled"
    | "reconciliation_required"
    | "broker_rejected";
  expiry_minutes: number;
  expires_at: string;
  fill_reason: string | null;
  cancel_reason: string | null;
  filled_at: string | null;
  resolved_at: string | null;
  signal_reason: any;
  signal_score: number;
  setup_type: string | null;
  setup_confidence: string | null;
  from_watchlist: boolean;
  candidate_id?: string | null;
  staged_setup_id?: string | null;
  originating_zone?: any;
  thesis_version?: string | null;
  confirmation_method?: "choch" | "indicators" | "choch_and_indicators" | null;
  confirmation_config?: {
    indicatorMinCount?: number;
    afterChochMode?: "confirmation_close" | "observe_retracement" | "wait_retracement";
    afterChochExpiryMinutes?: number;
  };
  confirmation_build_diagnostic?: {
    contractVersion: string;
    reasonCode: "inactive_contract" | "insufficient_history" |
      "insufficient_post_touch_bars" | "protected_pivot_missing" |
      "break_pivot_missing" | "trigger_ready";
    evaluatedAt: string | null;
    confirmationTimeframe: string | null;
    barsAfterTouch: number;
    requiredBars: number;
    swingCount: number;
    protectedPivotCount: number;
    breakPivotCount: number;
  } | null;
  post_confirmation_entry?: {
    state: "awaiting_retracement" | "ready" | "invalidated" | "expired";
    zone: { type: string; low: number; high: number; midpoint: number };
    protectedLevel: number;
    expiresAt: string;
    reason: string;
  } | null;
  post_confirmation_observation?: any;
  staged_cycles: number;
  staged_initial_score: number | null;
  exit_flags: any;
  final_authorization?: any;
  decision_context?: any;
  game_plan_id?: string | null;
  game_plan_version?: string | null;
  direction_verdict_id?: string | null;
  direction_verdict?: any;
  thesis_validation?: any;
  entry_confirmation?: any;
  liquidity_confirmation_observation?: {
    contractVersion: "liquidity-confirmation.v2";
    observationOnly: true;
    affectsAuthorization: false;
    ready: boolean;
    reasonCode: "sequence_confirmed" | "no_qualifying_sweep" | "sweep_identity_unresolved" | "legacy_contract_requires_fresh_sequence" | "setup_activation_time_unavailable" | "zone_touch_pending" | "sweep_before_zone_touch" | "confirmation_pending" | "confirmation_not_after_sweep";
    candidateId: string;
    sequenceId: string | null;
    sweepId: string | null;
    sweepTime: string | null;
    confirmationId: string | null;
    confirmationTime: string | null;
    stagedAt: string | null;
    zoneTouchTime: string | null;
  } | null;
  impulse_entry_lifecycle_id?: string | null;
  impulse_entry_lifecycle?: {
    mode: "off" | "observe" | "enforce";
    status: string;
    activeCandidateId: string | null;
    impulse: { timeframe: string; protectedLevel: number };
    candidates: Array<{ id: string; type: string; low: number; high: number; timeframe: string; state: string }>;
    confirmation: {
      candidateId: string; generation: number; status: string;
      protectedLevel: number | null; breakLevel: number | null;
      lockedAt: string | null; confirmedAt: string | null;
      revisions: Array<{ revision: number; protectedLevel: number; breakLevel: number; observedAt: string; reason: string }>;
    } | null;
    lastTransitionReason: string;
  } | null;
  placed_at: string;
  created_at: string;
  updated_at: string;
}

// Bot #2 (FOTSI Mean Reversion) has been removed — FOTSI currency strength
// is still computed inside the main bot-scanner as a confluence factor.

// ── Fundamentals ──
export const fundamentalsApi = {
  data: () => invokeFunction("fundamentals", { action: "data" }),
  eventsForPair: (pair: string) => invokeFunction("fundamentals", { action: "events_for_pair", pair }),
  highImpactCheck: (pair: string, withinMinutes = 30) =>
    invokeFunction("fundamentals", { action: "high_impact_check", pair, withinMinutes }),
  newsImpact: (pair?: string) => invokeFunction("fundamentals", { action: "news_impact", pair }),
};

// ── Broker Execution ──
export const brokerExecApi = {
  accountSummary: (connectionId: string) =>
    invokeFunction("broker-execute", { action: "account_summary", connectionId }),
  openTrades: (connectionId: string) =>
    invokeFunction("broker-execute", { action: "open_trades", connectionId }),
  connectionStatus: (connectionId: string) =>
    invokeFunction("broker-execute", { action: "connection_status", connectionId }),
  validateSymbol: (connectionId: string, symbol: string, brokerSymbol?: string) =>
    invokeFunction("broker-execute", { action: "validate_symbol", connectionId, symbol, brokerSymbol }),
  placeOrder: (connectionId: string, order: { symbol: string; direction: string; size: number; stopLoss?: number; takeProfit?: number }) =>
    invokeFunction("broker-execute", { action: "place_order", connectionId, ...order }),
  closeTrade: (connectionId: string, tradeId: string) =>
    invokeFunction("broker-execute", { action: "close_trade", connectionId, tradeId })
      .then(requireConfirmedBrokerMutation),
  tradeHistory: (connectionId: string, limit = 50) =>
    invokeFunction("broker-execute", { action: "trade_history", connectionId, limit }),
  modifyTrade: (connectionId: string, tradeId: string, updates: { stopLoss?: number; takeProfit?: number; symbol?: string }) =>
    invokeFunction("broker-execute", { action: "modify_trade", connectionId, tradeId, ...updates })
      .then(requireConfirmedBrokerMutation),
};

// ── Prop Firm ──
export const propFirmApi = {
  status: (botId = "smc") => invokeFunction("prop-firm", { action: "status", botId }),
  getConfig: (botId = "smc") => invokeFunction("prop-firm", { action: "config.get", botId }),
  saveConfig: (config: any, botId = "smc") => invokeFunction("prop-firm", { action: "config.save", config, botId }),
  deleteConfig: (botId = "smc") => invokeFunction("prop-firm", { action: "config.delete", botId }),
  setActive: (active: boolean, botId = "smc") => invokeFunction("prop-firm", { action: "config.setActive", active, botId }),
  unlockToday: (botId = "smc") => invokeFunction("prop-firm", { action: "daily.unlock", botId }),
  events: (limit = 50, offset = 0, botId = "smc") => invokeFunction("prop-firm", { action: "events", limit, offset, botId }),
  dailyHistory: (days = 30, botId = "smc") => invokeFunction("prop-firm", { action: "daily_history", days, botId }),
};
