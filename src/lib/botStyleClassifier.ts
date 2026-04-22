// Trading style classification — pure function, no backend needed

export type TradingStyleMode = "scalper" | "day_trader" | "swing_trader";

export interface StyleOverrides {
  entryTimeframe: string;
  htfTimeframe: string;
  tpRatio: number;
  slBufferPips: number;
  confluenceThreshold: number; // percentage (0-100%)
  // Management defaults (user can override per-broker):
  trailingStopEnabled: boolean;
  trailingStopPips: number;
  trailingStopActivation: string;
  breakEvenEnabled: boolean;
  breakEvenPips: number;
  partialTPEnabled: boolean;
  partialTPPercent: number;
  partialTPLevel: number;
  maxHoldHours: number;
}

// NOTE: breakEvenPips is now a fallback — actual BE trigger is R-based: max(1R, breakEvenPips/riskPips)
// trailingStopPips is a minimum — actual trail distance is max(configPips, 0.5× riskPips)
export const STYLE_PARAMS: Record<TradingStyleMode, StyleOverrides> = {
  scalper: {
    entryTimeframe: "5m",
    htfTimeframe: "1h",
    tpRatio: 1.5,
    slBufferPips: 1,
    confluenceThreshold: 40,
    trailingStopEnabled: true,
    trailingStopPips: 8,              // minimum trail; proportional (0.5× SL) may be larger
    trailingStopActivation: "after_1r",  // let scalps reach 1R before trailing
    breakEvenEnabled: true,
    breakEvenPips: 8,                 // fallback; R-based trigger (min 1R) takes precedence
    partialTPEnabled: false,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
    maxHoldHours: 4,
  },
  day_trader: {
    entryTimeframe: "15m",
    htfTimeframe: "1d",
    tpRatio: 2.0,
    slBufferPips: 2,
    confluenceThreshold: 55,
    trailingStopEnabled: true,        // trailing AFTER partial TP
    trailingStopPips: 15,             // minimum trail; proportional (0.5× SL) may be larger
    trailingStopActivation: "after_1.5r", // activates after partial TP at 1R + buffer
    breakEvenEnabled: true,
    breakEvenPips: 20,                // fallback; R-based trigger (min 1R) takes precedence
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
    maxHoldHours: 24,
  },
  swing_trader: {
    entryTimeframe: "1h",
    htfTimeframe: "1w",
    tpRatio: 3.0,
    slBufferPips: 5,
    confluenceThreshold: 65,
    trailingStopEnabled: true,
    trailingStopPips: 25,             // minimum trail; proportional (0.5× SL) may be larger
    trailingStopActivation: "after_2r", // let swings develop before trailing
    breakEvenEnabled: true,
    breakEvenPips: 40,                // fallback; R-based trigger (min 1R) takes precedence
    partialTPEnabled: true,
    partialTPPercent: 33,             // take 33% at 1R (keep more for the big move)
    partialTPLevel: 1.0,              // lock in profit at 1R
    maxHoldHours: 0,  // no limit for swings
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
