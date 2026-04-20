// Trading style classification — pure function, no backend needed

export type TradingStyleMode = "scalper" | "day_trader" | "swing_trader";

export interface StyleOverrides {
  entryTimeframe: string;
  htfTimeframe: string;
  tpRatio: number;
  slBufferPips: number;
  maxHoldHours: number;
  minConfluence: number;
}

export const STYLE_PARAMS: Record<TradingStyleMode, StyleOverrides> = {
  scalper: {
    entryTimeframe: "5m",
    htfTimeframe: "1h",
    tpRatio: 1.5,
    slBufferPips: 1,
    maxHoldHours: 1,
    minConfluence: 5,
  },
  day_trader: {
    entryTimeframe: "15m",
    htfTimeframe: "1d",
    tpRatio: 2.0,
    slBufferPips: 2,
    maxHoldHours: 8,
    minConfluence: 5.5,
  },
  swing_trader: {
    entryTimeframe: "1h",
    htfTimeframe: "1w",
    tpRatio: 3.0,
    slBufferPips: 5,
    maxHoldHours: 120,
    minConfluence: 6.5,
  },
};

export const STYLE_META: Record<TradingStyleMode, { label: string; icon: string; color: string; description: string }> = {
  scalper: {
    label: "Scalper",
    icon: "⚡",
    color: "text-warning bg-warning/10 border-warning/30",
    description: "Quick in-and-out trades on 5m charts. Tight stops, fast exits.",
  },
  day_trader: {
    label: "Day Trader",
    icon: "📊",
    color: "text-primary bg-primary/10 border-primary/30",
    description: "Intraday trades on 15m charts. Balanced risk/reward, closes by end of session.",
  },
  swing_trader: {
    label: "Swing Trader",
    icon: "📈",
    color: "text-success bg-success/10 border-success/30",
    description: "Multi-day holds on 1h charts. Wider stops, larger targets.",
  },
};

export function getActiveStyle(config: any): TradingStyleMode {
  const mode = config?.tradingStyle?.mode || "day_trader";
  return mode as TradingStyleMode;
}
