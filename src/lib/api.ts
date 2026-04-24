import { supabase } from "@/integrations/supabase/client";

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
  let { data, error } = await supabase.functions.invoke(functionName, { body });

  // If auth failed, try refreshing the session once and retry.
  if (isAuthError(error, data)) {
    const { error: refreshErr } = await supabase.auth.refreshSession();
    if (!refreshErr) {
      ({ data, error } = await supabase.functions.invoke(functionName, { body }));
    }
    if (isAuthError(error, data)) {
      await supabase.auth.signOut().catch(() => {});
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
  }

  if (error) throw new Error(error.message || `${functionName} failed`);
  if (data?.error && !data?.fallback) throw new Error(data.error);
  return data as T;
}

// ── Market Data ──
export type CandleSource = "metaapi" | "twelvedata" | "yahoo" | "none" | "unknown";
export interface CandlesWithMeta { candles: any[]; source: CandleSource; }

// Low-level fetch so we can read the x-data-source response header
// (the supabase-js invoke() helper doesn't expose response headers).
async function fetchMarketData(body: Record<string, any>): Promise<{ data: any; source: CandleSource }> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-data`;
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
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
  // Returns candles plus the source ("metaapi" | "twelvedata" | "yahoo") so the UI
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
  updatePosition: (positionId: string, updates: { stopLoss?: number | null; takeProfit?: number | null }) =>
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
};

// ── Bot Scanner (Bot #1 — SMC) ──
export const scannerApi = {
  manualScan: () => invokeFunction("bot-scanner", { action: "manual_scan" }),
  logs: () => invokeFunction("bot-scanner", { action: "scan_logs" }),
  // Setup Staging / Watchlist
  activeStaged: () => invokeFunction<StagedSetup[]>("bot-scanner", { action: "active_staged" }),
  allStaged: () => invokeFunction<StagedSetup[]>("bot-scanner", { action: "staged_setups" }),
  dismissStaged: (setupId: string) => invokeFunction("bot-scanner", { action: "dismiss_staged", setupId }),
  // Pending / Limit Orders
  activePending: () => invokeFunction<PendingOrder[]>("bot-scanner", { action: "active_pending" }),
  allPending: () => invokeFunction<PendingOrder[]>("bot-scanner", { action: "pending_orders" }),
  cancelPending: (orderId: string) => invokeFunction("bot-scanner", { action: "cancel_pending", orderId }),
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
  status: "pending" | "filled" | "expired" | "cancelled";
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
  placeOrder: (connectionId: string, order: { symbol: string; direction: string; size: number; stopLoss?: number; takeProfit?: number }) =>
    invokeFunction("broker-execute", { action: "place_order", connectionId, ...order }),
  closeTrade: (connectionId: string, tradeId: string) =>
    invokeFunction("broker-execute", { action: "close_trade", connectionId, tradeId }),
  tradeHistory: (connectionId: string, limit = 50) =>
    invokeFunction("broker-execute", { action: "trade_history", connectionId, limit }),
  modifyTrade: (connectionId: string, tradeId: string, updates: { stopLoss?: number; takeProfit?: number; symbol?: string }) =>
    invokeFunction("broker-execute", { action: "modify_trade", connectionId, tradeId, ...updates }),
};
