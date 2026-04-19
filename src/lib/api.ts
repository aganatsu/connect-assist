import { supabase } from "@/integrations/supabase/client";

// Detect auth errors from the edge function (401 / Unauthorized / bad_jwt / missing sub claim)
function isAuthError(error: any, data: any): boolean {
  const msg = (error?.message || data?.error || "").toString().toLowerCase();
  const status = error?.context?.status ?? error?.status;
  if (status === 401 || status === 403) return true;
  return /unauthor|invalid.*jwt|bad.?jwt|missing sub|jwt expired/.test(msg);
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
};

// ── Bot Config ──
export const botConfigApi = {
  get: (connectionId?: string) => invokeFunction("bot-config", { action: "get", connectionId }),
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
  create: (data: { broker_type: string; display_name: string; api_key: string; account_id: string; is_live?: boolean; symbol_suffix?: string; symbol_overrides?: Record<string, string> }) =>
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
  setExecutionMode: (mode: "paper" | "live") => invokeFunction("paper-trading", { action: "set_execution_mode", mode }),
};

// ── Backtest Engine ──
export const backtestApi = {
  run: (params: {
    instruments: string[];
    startDate: string;
    endDate: string;
    startingBalance: number;
    config: any;
    tradingStyle?: string;
    slippagePips?: number;
    spreadPips?: number;
  }) => invokeFunction("backtest-engine", params),
};

// ── Bot Scanner (Bot #1 — SMC) ──
export const scannerApi = {
  manualScan: () => invokeFunction("bot-scanner", { action: "manual_scan" }),
  logs: () => invokeFunction("bot-scanner", { action: "scan_logs" }),
};

// ── Bot Scanner (Bot #2 — FOTSI Mean Reversion) ──
export const fotsiScannerApi = {
  scan: () => invokeFunction("bot-scanner-fotsi", { action: "scan", manual: true, source: "ui" }),
  status: () => invokeFunction("bot-scanner-fotsi", { action: "status" }),
  scanLogs: () => invokeFunction("bot-scanner-fotsi", { action: "scan_logs" }),
};

// ── Bot #2 Config ──
// Bot #2 config is stored as a `fotsi_mr` sub-key inside bot_configs.config_json
export const fotsiConfigApi = {
  get: async () => {
    const full = await botConfigApi.get();
    return full?.fotsi_mr ?? null;
  },
  update: async (fotsiConfig: any) => {
    const full = await botConfigApi.get();
    return botConfigApi.update({ ...full, fotsi_mr: fotsiConfig });
  },
  reset: async () => {
    const full = await botConfigApi.get();
    const { fotsi_mr, ...rest } = full || {};
    return botConfigApi.update(rest);
  },
};

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
};
