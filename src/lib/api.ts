import { supabase } from "@/integrations/supabase/client";

// Helper to invoke edge functions with typed responses
export async function invokeFunction<T = any>(
  functionName: string,
  body: Record<string, any>
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
  });
  if (error) throw new Error(error.message || `${functionName} failed`);
  if (data?.error) throw new Error(data.error);
  return data as T;
}

// ── Market Data ──
export const marketApi = {
  candles: (symbol: string, interval: string, outputsize = 200) =>
    invokeFunction("market-data", { action: "candles", symbol, interval, outputsize }),
  quote: (symbol: string) =>
    invokeFunction("market-data", { action: "quote", symbol }),
};

// ── Bot Config ──
export const botConfigApi = {
  get: () => invokeFunction("bot-config", { action: "get" }),
  update: (config: any) => invokeFunction("bot-config", { action: "update", config }),
  reset: () => invokeFunction("bot-config", { action: "reset" }),
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
  create: (data: { broker_type: string; display_name: string; api_key: string; account_id: string; is_live?: boolean }) =>
    invokeFunction("broker-connections", { action: "create", ...data }),
  update: (data: any) => invokeFunction("broker-connections", { action: "update", ...data }),
  delete: (id: string) => invokeFunction("broker-connections", { action: "delete", id }),
  test: (id: string) => invokeFunction("broker-connections", { action: "test", id }),
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
  startEngine: () => invokeFunction("paper-trading", { action: "start_engine" }),
  pauseEngine: () => invokeFunction("paper-trading", { action: "pause_engine" }),
  stopEngine: () => invokeFunction("paper-trading", { action: "stop_engine" }),
  killSwitch: (active: boolean) => invokeFunction("paper-trading", { action: "kill_switch", active }),
  resetAccount: () => invokeFunction("paper-trading", { action: "reset_account" }),
  setExecutionMode: (mode: "paper" | "live") => invokeFunction("paper-trading", { action: "set_execution_mode", mode }),
};

// ── Bot Scanner ──
export const scannerApi = {
  manualScan: () => invokeFunction("bot-scanner", { action: "manual_scan" }),
  logs: () => invokeFunction("bot-scanner", { action: "scan_logs" }),
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
