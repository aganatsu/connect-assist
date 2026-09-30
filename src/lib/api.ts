import { supabase } from "@/integrations/supabase/client";

let brokerExecuteQueue: Promise<void> = Promise.resolve();
const functionCooldownUntil = new Map<string, number>();
const functionResponseCache = new Map<string, { data: any; expiresAt: number }>();

function functionCacheKey(functionName: string, body: Record<string, any>) {
  return `${functionName}:${JSON.stringify(body)}`;
}

function getFunctionFallback(functionName: string, body: Record<string, any>) {
  const cached = functionResponseCache.get(functionCacheKey(functionName, body));
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  if (functionName === "bot-scanner") {
    const action = body?.action;
    if (["scan_logs", "staged_setups", "active_staged", "pending_orders", "active_pending"].includes(action)) return [];
    if (action === "manual_scan") return { error: "Scanner is temporarily unavailable. Please try again shortly.", started: false, pairsScanned: 0, signalsFound: 0, tradesPlaced: 0 };
    return { ok: false, error: "Scanner is temporarily unavailable. Please try again shortly.", fallback: true };
  }

  if (functionName === "broker-execute") {
    const action = body?.action;
    if (["open_trades", "trade_history"].includes(action)) return [];
    if (["account_summary", "account_balance", "connection_status", "symbol_specs", "validate_symbol"].includes(action)) return { ok: false, error: "Broker service is temporarily unavailable. Please try again shortly.", fallback: true };
    if (["place_order", "close_trade", "modify_trade"].includes(action)) return { error: "Broker execution is temporarily unavailable. The order was not sent; please retry shortly.", fallback: true };
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

// Returns a token that is still valid for at least 60s, refreshing proactively.
// Without this, a session that expired while the tab sat idle is sent as-is and
// the edge function replies 500 {"error":"JWT has expired"}.
async function getFreshAccessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const expiresAt = session?.expires_at ? session.expires_at * 1000 : 0;
  if (session?.access_token && expiresAt - Date.now() > 60_000) return session.access_token;
  if (session) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (refreshed?.session?.access_token) return refreshed.session.access_token;
  }
  return session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
}

async function invokeSupabaseFunction(functionName: string, body: Record<string, any>) {
  const run = async () => {
    try {
      const token = await getFreshAccessToken();

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
  return /unauthor|invalid.*jwt|bad.?jwt|missing sub|jwt.*expired|expired.*jwt/.test(msg);
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
    if (status === 503 || status === 504 || status === 502) return true;
    const msg = (err?.message || d?.message || d?.error || "").toString();
    return /temporarily unavailable|SUPABASE_EDGE_RUNTIME_ERROR|returned 50[234]|BOOT_ERROR|WORKER_LIMIT/i.test(msg);
  };

  for (let attempt = 0; attempt < 4 && isTransient503(error, data); attempt++) {
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    ({ data, error } = await invokeSupabaseFunction(functionName, body));
  }

  if (isTransient503(error, data)) {
    functionCooldownUntil.set(functionName, Date.now() + 15_000);
  }

  // Bot scanner data is dashboard/polling data. If the hosted function is briefly
  // unavailable even after retries, return a safe empty result instead of letting
  // the Bot page crash into a blank screen.
  if (functionName === "bot-scanner" && isTransient503(error, data)) {
    const action = body?.action;
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
    if (["place_order", "close_trade", "modify_trade"].includes(action)) {
      return {
        error: "Broker execution is temporarily unavailable. The order was not sent; please retry shortly.",
        fallback: true,
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
    const { error: refreshErr } = await supabase.auth.refreshSession();
    if (!refreshErr) {
      ({ data, error } = await invokeSupabaseFunction(functionName, body));
    }
    if (isAuthError(error, data)) {
      // Only force a sign-out when the local session is genuinely gone. A 401/403
      // coming from a single edge function (e.g. its own authorization check, or a
      // request that fell back to the publishable key) must never log the user out
      // and bounce them back to /login.
      const { data: sessionData } = await supabase.auth.getSession();
      const stillSignedIn = !!sessionData.session?.access_token;
      if (!stillSignedIn) {
        if (typeof window !== "undefined") {
          try {
            const { toast } = await import("sonner");
            toast.error("Session expired", {
              description: "Redirecting you to sign in again…",
              duration: 2500,
            });
          } catch {}
          setTimeout(() => {
            window.location.href = "/login";
          }, 1800);
        }
        throw new Error("Session expired. Please sign in again.");
      }
      throw new Error(
        (error?.message || data?.error || `${functionName} request was not authorized`).toString()
      );
    }
  }


  if (error) throw new Error(error.message || `${functionName} failed`);
  if (data?.error && !data?.fallback) throw new Error(data.error);
  functionCooldownUntil.delete(functionName);
  cacheSuccessfulFunctionResponse(functionName, body, data);
  return data as T;
}

// ── Market Data ──
export type CandleSource = "metaapi" | "twelvedata" | "polygon" | "none" | "unknown";
export interface CandlesWithMeta { candles: any[]; source: CandleSource; }

// Low-level fetch so we can read the x-data-source response header
// (the supabase-js invoke() helper doesn't expose response headers).
async function fetchMarketData(body: Record<string, any>): Promise<{ data: any; source: CandleSource }> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-data`;
  const token = await getFreshAccessToken();

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
  // Returns candles plus the source ("metaapi" | "twelvedata" | "polygon") so the UI
  // can surface where prices are actually coming from.
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
  getDefaults: () => invokeFunction("bot-config", { action: "defaults" }),
  update: (config: any, connectionId?: string) => invokeFunction("bot-config", { action: "update", config, connectionId }),
  reset: (connectionId?: string) => invokeFunction("bot-config", { action: "reset", connectionId }),
  // Preset CRUD
  listPresets: () => invokeFunction<Array<{ id: string; name: string; description: string; config_json: any; created_at: string; updated_at: string }>>("bot-config", { action: "presets.list" }),
  savePreset: (name: string, config: any, description?: string) => invokeFunction<{ success: boolean; id: string; updated: boolean }>("bot-config", { action: "presets.save", name, config, description }),
  deletePreset: (presetId: string) => invokeFunction<{ success: boolean }>("bot-config", { action: "presets.delete", presetId }),
};

// ── Trades (Journal) ──
export const tradesApi = {
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
  setExecutionMode: (mode: "paper" | "live") => invokeFunction("paper-trading", { action: "set_execution_mode", mode }),
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
};

// ── Bot Scanner (Bot #1 — SMC) ──
/** One per-pair entry inside a scan's details_json. Shape varies by status. */
type ScanDetailEntry = Record<string, unknown>;
/**
 * The generated Supabase types do not cover jsonb-path selects or the older
 * tables this file reaches, and the rest of the module already casts for the
 * same reason. Named rather than inlined so the reason is stated once.
 */
type SupabaseLoose = {
  from: (t: string) => {
    select: (c: string) => Record<string, (...a: unknown[]) => unknown>;
  };
};

export const scannerApi = {
  manualScan: () => invokeFunction("bot-scanner", { action: "manual_scan" }),
  logs: async () => {
    // METADATA ONLY — details_json is deliberately NOT selected here.
    //
    // This used to `select("*")` over 300 scans. Each row's details_json is
    // ~33 kB, so the response grew to ~28 MB and Postgres began killing the
    // query outright:
    //   57014 canceling statement due to statement timeout
    // Measured on the live table at 3,255 rows / 110 MB: limit 150 returned
    // 13.4 MB and survived, limit 300 timed out. The scan panel then showed
    // whatever the last successful fetch had cached and never updated again.
    //
    // The list only renders timestamps and counts, so the payload it was
    // carrying was never displayed. Fetching metadata instead takes the same
    // 300 scans from ~28 MB to ~49 kB. `details_json` for the ONE scan being
    // viewed is loaded separately by `scanDetail`.
    //
    // Management-cycle and game-plan rows are excluded SERVER-SIDE on
    // pairs_scanned, which separates them exactly and costs nothing to read.
    //
    // bot-scanner writes a scan_logs row from management-only cycles to carry
    // pending-order diagnostics (the confirmation hunt is invisible otherwise).
    // Those are not scans: pairs_scanned 0, no per-pair detail, and they arrive
    // every minute rather than every scanIntervalMinutes. Rendering them made
    // the scan interval look like 60s, with blank panels and "undefined/10".
    // A separate producer writes game-plan rows, whose details_json is an
    // OBJECT rather than an array; those rendered as blank scans too.
    //
    // Measured on the live table: 1,728 management_cycle rows and 75 game_plan
    // rows all have pairs_scanned = 0, and all 1,452 real scans have 1-8. The
    // previous client-side filter read details_json[0].type, which forced every
    // row's jsonb to be detoasted just to classify it — 5 seconds for 300 rows,
    // and it missed the game-plan rows entirely.
    const { data, error } = await (supabase as any)
      .from("scan_logs")
      .select("id, user_id, bot_id, scanned_at, created_at, pairs_scanned, signals_found, trades_placed")
      .gte("pairs_scanned", 1)
      .order("scanned_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data || [];
  },

  /**
   * Recent scans WITH their `details_json`. The heavy variant.
   *
   * Only for callers that must search across scans rather than render one, and
   * deliberately capped low: at ~33 kB per row this is the payload that made
   * the 300-row list query time out. 25 scans is ~825 kB.
   */
  logsWithDetails: async (limit = 25) => {
    const { data, error } = await (supabase as SupabaseLoose)
      .from("scan_logs")
      .select("id, scanned_at, pairs_scanned, signals_found, trades_placed, details_json")
      .order("scanned_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data || []).filter((r: { details_json?: unknown }) => {
      const dj = r.details_json;
      return !(Array.isArray(dj) && (dj[0] as { type?: string })?.type === "management_cycle");
    });
  },

  /**
   * `details_json` for a single scan.
   *
   * Split out from `logs` so the viewer pays for one scan (~110 kB) instead of
   * three hundred. Returns [] for a missing id rather than throwing, because a
   * selection can outlive the row it pointed at.
   */
  scanDetail: async (id?: string): Promise<ScanDetailEntry[]> => {
    if (!id) return [];
    const { data, error } = await (supabase as SupabaseLoose)
      .from("scan_logs")
      .select("details_json")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    let dj: unknown = data?.details_json;
    // Supabase may hand jsonb back as a string.
    if (typeof dj === "string") {
      try { dj = JSON.parse(dj); } catch { return []; }
    }
    return Array.isArray(dj) ? dj : [];
  },
  // Setup Staging / Watchlist
  activeStaged: async (): Promise<StagedSetup[]> => {
    const { data, error } = await (supabase as any)
      .from("staged_setups")
      .select("*")
      .eq("bot_id", "smc")
      .eq("status", "watching")
      .order("current_score", { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  },
  allStaged: async (): Promise<StagedSetup[]> => {
    const { data, error } = await (supabase as any)
      .from("staged_setups")
      .select("*")
      .eq("bot_id", "smc")
      .order("staged_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data || [];
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
  status: "watching" | "promoted" | "expired" | "invalidated";
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
export interface PendingOrder {
  order_id: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  direction: "long" | "short";
  order_type: "limit_ob" | "limit_fvg";
  entry_price: number;
  current_price: number | null;
  stop_loss: number;
  take_profit: number;
  size: number;
  entry_zone_type: string;
  entry_zone_low: number;
  entry_zone_high: number;
  status: "pending" | "awaiting_confirmation" | "filled" | "expired" | "cancelled";
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
  staged_cycles: number;
  staged_initial_score: number | null;
  exit_flags: any;
  placed_at: string;
  created_at: string;
  updated_at: string;

  // ── Route 2 forward telemetry. ALL OPTIONAL: legacy rows predate them, and
  // the panel must render a missing value as missing, never as a default.
  strategy_version?: string | null;
  config_hash?: string | null;
  would_have_been_route1?: boolean | null;
  pending_distance_atr?: number | null;
  zone_id?: string | null;
  zone_touch_time?: string | null;
  last_touch_detection_time?: string | null;
  confirmation_arm_count?: number | null;
  confirmation_checks_count?: number | null;
  confirmation_min_observation_until?: string | null;
  confirmation_type?: string | null;
  confirmation_tier?: number | null;
  confirmation_timeframe?: string | null;
  confirmation_accepted_at?: string | null;
  /** Canonical record — see supabase/functions/_shared/route2Confirmation.ts. */
  entry_confirmation?: Record<string, unknown> | null;
  fill_price?: number | null;
  fill_timestamp?: string | null;
  terminal_reason?: string | null;
  reset_reason?: string | null;
  structural_invalidation?: string | null;
  hard_invalidation?: boolean | null;
}

// Bot #2 (FOTSI Mean Reversion) has been removed — FOTSI currency strength
// is still computed inside the main bot-scanner as a confluence factor.

// ── Fundamentals ──
export const fundamentalsApi = {
  data: () => invokeFunction("fundamentals", { action: "data" }),
  eventsForPair: (pair: string) => invokeFunction("fundamentals", { action: "events_for_pair", pair }),
  highImpactCheck: (pair: string, withinMinutes = 30) =>
    invokeFunction("fundamentals", { action: "high_impact_check", pair, withinMinutes }),
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
    invokeFunction("broker-execute", { action: "close_trade", connectionId, tradeId }),
  tradeHistory: (connectionId: string, limit = 50) =>
    invokeFunction("broker-execute", { action: "trade_history", connectionId, limit }),
  modifyTrade: (connectionId: string, tradeId: string, updates: { stopLoss?: number; takeProfit?: number; symbol?: string }) =>
    invokeFunction("broker-execute", { action: "modify_trade", connectionId, tradeId, ...updates }),
};

// ── Prop Firm ──
export const propFirmApi = {
  status: (botId = "smc") => invokeFunction("prop-firm", { action: "status", botId }),
  getConfig: (botId = "smc") => invokeFunction("prop-firm", { action: "config.get", botId }),
  saveConfig: (config: any, botId = "smc") => invokeFunction("prop-firm", { action: "config.save", config, botId }),
  deleteConfig: (botId = "smc") => invokeFunction("prop-firm", { action: "config.delete", botId }),
  events: (limit = 50, offset = 0, botId = "smc") => invokeFunction("prop-firm", { action: "events", limit, offset, botId }),
  dailyHistory: (days = 30, botId = "smc") => invokeFunction("prop-firm", { action: "daily_history", days, botId }),
};
