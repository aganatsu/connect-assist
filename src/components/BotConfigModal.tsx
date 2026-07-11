import { useState, useEffect, useRef, useContext, createContext } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { botConfigApi } from "@/lib/api";
import { INSTRUMENTS, INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS } from "@/lib/marketData";
import { STYLE_PARAMS, STYLE_META, type TradingStyleMode } from "@/lib/botStyleClassifier";
import { toast } from "sonner";
import { X, Shield, TrendingUp, Clock, Globe, ShieldAlert, LogIn, LogOut, BarChart3, Gauge, Search, SlidersHorizontal, RotateCcw, Save, Trash2, FolderOpen, ChevronDown, ChevronUp, Bookmark, Crosshair, Sparkles, Target } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatBrokerTime } from "@/lib/formatTime";

// Index of every searchable setting in the modal — used by the search bar to filter
// tabs and to highlight matching fields. Keep keywords broad so users can find
// settings by intuition (e.g. "trailing", "spread", "news", "drawdown").
const SEARCH_INDEX: { tab: string; label: string; keywords: string[] }[] = [
  // Trading Style
  { tab: "tradingStyle", label: "Trading Style", keywords: ["scalper", "day trader", "swing", "style", "mode"] },
  // Strategy
  { tab: "strategy", label: "Auto Scan Interval", keywords: ["scan", "interval", "scanner", "frequency"] },
  { tab: "strategy", label: "Confluence Threshold", keywords: ["confluence", "score", "threshold", "minimum"] },

  { tab: "strategy", label: "Order Blocks", keywords: ["ob", "order block", "smc", "institutional"] },
  { tab: "strategy", label: "Fair Value Gaps", keywords: ["fvg", "imbalance", "gap"] },
  { tab: "strategy", label: "Liquidity Sweeps", keywords: ["liquidity", "sweep", "pool"] },
  { tab: "strategy", label: "Structure Breaks", keywords: ["bos", "choch", "structure", "break"] },
  { tab: "strategy", label: "Displacement Detection", keywords: ["displacement", "candle"] },
  { tab: "strategy", label: "Breaker Blocks", keywords: ["breaker", "flip", "failed ob"] },
  { tab: "strategy", label: "Unicorn Model", keywords: ["unicorn", "breaker", "fvg overlap"] },
  { tab: "strategy", label: "Session Quality", keywords: ["session", "kill zone", "silver bullet", "macro", "timing", "ict"] },
  { tab: "strategy", label: "SMT Divergence", keywords: ["smt", "divergence", "correlated"] },
  { tab: "strategy", label: "SMT Opposite Veto", keywords: ["smt", "veto", "opposite", "block"] },
  { tab: "strategy", label: "Volume Profile", keywords: ["volume", "profile", "poc", "hvn", "lvn", "tpo", "value area"] },
  { tab: "strategy", label: "Trend Direction", keywords: ["trend", "direction", "entry", "timeframe", "higher highs", "lower lows"] },
  { tab: "strategy", label: "Daily Bias", keywords: ["daily", "bias", "htf", "higher timeframe", "bullish", "bearish"] },
  { tab: "strategy", label: "AMD Phase Detection", keywords: ["amd", "accumulation", "manipulation", "distribution", "phase"] },
  { tab: "strategy", label: "FOTSI Currency Strength", keywords: ["fotsi", "currency strength", "tsi", "28 pair", "overbought", "oversold", "veto"] },
  { tab: "strategy", label: "Require HTF Bias Alignment", keywords: ["htf", "bias", "higher timeframe", "alignment"] },
  { tab: "strategy", label: "HTF Bias Hard Veto", keywords: ["htf", "veto", "hard", "block"] },
  { tab: "strategy", label: "Require Entry-Trigger Sweep", keywords: ["liquidity", "sweep", "gate", "entry trigger", "bsl", "ssl", "require"] },
  { tab: "strategy", label: "Swept-Absorbed Penalty", keywords: ["swept", "absorbed", "penalty", "liquidity", "invalidated", "zone"] },
  { tab: "strategy", label: "Only Buy in Discount", keywords: ["premium", "discount", "long", "buy"] },
  { tab: "strategy", label: "Only Sell in Premium", keywords: ["premium", "discount", "short", "sell"] },
  { tab: "strategy", label: "Regime Scoring", keywords: ["regime", "market regime", "trend", "range", "choppy", "alignment", "bonus", "penalty"] },
  { tab: "strategy", label: "Regime Strength", keywords: ["regime", "strength", "multiplier", "scale", "aggressive", "subtle"] },
  { tab: "strategy", label: "Thesis Conviction Tracker", keywords: ["thesis", "conviction", "decay", "evidence", "stale", "impulse credit", "revoke"] },
  { tab: "strategy", label: "Thesis Conviction Mode", keywords: ["thesis", "conviction", "shadow", "active", "mode", "block"] },
  { tab: "strategy", label: "Thesis Conviction Thresholds", keywords: ["thesis", "conviction", "revoke", "kill", "threshold", "decay", "recovery"] },
  { tab: "strategy", label: "Normalized Scoring", keywords: ["normalize", "normalized", "percentage", "scoring", "scale", "auto-adjust", "factor toggle", "weight"] },
  { tab: "strategy", label: "OB Lookback Candles", keywords: ["ob", "order block", "lookback", "history", "advanced", "tuning"] },
  { tab: "strategy", label: "Structure Lookback", keywords: ["structure", "lookback", "bos", "choch", "advanced", "tuning"] },
  { tab: "strategy", label: "FVG Min Size", keywords: ["fvg", "min", "size", "pips", "filter", "advanced", "tuning"] },
  { tab: "strategy", label: "FVG Only Unfilled", keywords: ["fvg", "unfilled", "mitigated", "advanced", "tuning"] },
  { tab: "strategy", label: "Liquidity Pool Min Touches", keywords: ["liquidity", "pool", "touches", "equal highs", "advanced", "tuning"] },
  // Risk
  { tab: "risk", label: "Risk per Trade (%)", keywords: ["risk", "size", "percent", "percentage"] },
  { tab: "risk", label: "Max Daily Drawdown (%)", keywords: ["drawdown", "daily", "loss", "halt"] },
  { tab: "risk", label: "Max Concurrent Trades", keywords: ["concurrent", "open", "positions", "max"] },
  { tab: "risk", label: "Min R:R Ratio", keywords: ["rr", "risk reward", "ratio", "minimum"] },
  { tab: "risk", label: "Portfolio Heat (%)", keywords: ["portfolio", "heat", "exposure", "total"] },
  { tab: "risk", label: "Max Per Symbol", keywords: ["per symbol", "instrument", "max", "duplicate"] },
  { tab: "risk", label: "Same-Direction Stacking", keywords: ["stacking", "duplicate", "same direction", "pyramid", "double"] },
  { tab: "risk", label: "Max Total Drawdown (%)", keywords: ["drawdown", "kill switch", "total", "max"] },
  { tab: "risk", label: "Position Sizing Method", keywords: ["sizing", "lot", "fixed", "volatility", "atr", "position size"] },
  { tab: "risk", label: "Conflict Threshold Raise", keywords: ["conflict", "opposing", "threshold", "raise", "counter", "bidirectional"] },
  { tab: "risk", label: "Conflict Hard Block", keywords: ["conflict", "block", "opposing", "veto", "counter", "bidirectional"] },
  { tab: "risk", label: "Fixed Lot Size", keywords: ["lot", "fixed", "size", "volume"] },
  { tab: "risk", label: "ATR Volatility Multiplier", keywords: ["atr", "multiplier", "volatility", "sizing", "aggressive", "conservative"] },
  // Entry / Exit
  { tab: "entry_exit", label: "Pending Zone Orders", keywords: ["zone", "setup", "pending", "order", "confirmation", "choch", "ob", "fvg", "entry type", "limit"] },
  { tab: "strategy", label: "Tier 1 Gate Enabled", keywords: ["tier 1", "gate", "toggle", "disable", "enable", "gate 19", "core factors", "off"] },
  { tab: "strategy", label: "Min Tier 1 Core Factors", keywords: ["tier 1", "core", "factors", "minimum", "gate 19", "market structure", "ob", "fvg", "premium discount"] },
  { tab: "strategy", label: "Impulse Zone Gate Mode", keywords: ["impulse", "zone", "gate", "mode", "hard", "soft", "off", "blocking", "skip"] },
  { tab: "entry_exit", label: "Market Fill at Zone", keywords: ["market", "fill", "zone", "immediate", "atr", "proximity", "strict"] },
  { tab: "entry_exit", label: "Zone Proximity (ATR)", keywords: ["atr", "multiplier", "proximity", "zone", "strict", "distance", "market fill"] },
  { tab: "entry_exit", label: "Zone Watch Expiry", keywords: ["zone", "expiry", "watch", "cancel", "minutes"] },
  { tab: "entry_exit", label: "Zone Setup Distance", keywords: ["zone", "distance", "pips", "max", "min"] },
  { tab: "entry_exit", label: "Zone Preference", keywords: ["zone", "ob", "fvg", "nearest", "prefer"] },
  { tab: "entry_exit", label: "Cooldown Between Trades (minutes)", keywords: ["cooldown", "wait", "between", "delay"] },
  { tab: "entry_exit", label: "SL Buffer (pips)", keywords: ["sl", "stop loss", "buffer", "pips"] },
  { tab: "entry_exit", label: "Close on Reverse Signal", keywords: ["reverse", "close", "opposite"] },
  { tab: "entry_exit", label: "SL Method", keywords: ["sl", "stop loss", "method", "structure", "atr", "fixed pips"] },
  { tab: "entry_exit", label: "Fixed SL Pips", keywords: ["sl", "fixed", "pips"] },
  { tab: "entry_exit", label: "ATR Multiple", keywords: ["atr", "multiple", "sl"] },
  { tab: "entry_exit", label: "ATR Period", keywords: ["atr", "period", "candles"] },
  { tab: "entry_exit", label: "TP Method", keywords: ["tp", "take profit", "method", "rr", "next level"] },
  { tab: "entry_exit", label: "Fixed TP Pips", keywords: ["tp", "fixed", "pips"] },
  { tab: "entry_exit", label: "R:R Ratio", keywords: ["rr", "risk reward", "ratio", "tp"] },
  { tab: "entry_exit", label: "TP ATR Multiple", keywords: ["tp", "atr", "multiple"] },
  { tab: "entry_exit", label: "Trailing Stop", keywords: ["trailing", "stop", "trail", "ratchet", "management"] },
  { tab: "entry_exit", label: "Break Even", keywords: ["break even", "breakeven", "be", "management"] },
  { tab: "entry_exit", label: "Partial Take Profit", keywords: ["partial", "tp", "scale out", "management"] },
  { tab: "entry_exit", label: "Time-Based Exit", keywords: ["time", "exit", "hours", "auto close", "max hold", "management"] },
  { tab: "entry_exit", label: "Structure Invalidation", keywords: ["structure", "invalidation", "choch", "reversal", "protection", "management"] },
  // Instruments
  { tab: "instruments", label: "Instruments", keywords: ["instruments", "pairs", "symbols", "forex", "crypto", "indices"] },
  { tab: "instruments", label: "Enable Spread Filter", keywords: ["spread", "filter", "broker"] },
  { tab: "instruments", label: "Volatility Filter (ATR)", keywords: ["atr", "volatility", "filter", "min", "max"] },
  { tab: "instruments", label: "Global Spread Override", keywords: ["spread", "max", "pips", "per-instrument", "auto"] },
  { tab: "instruments", label: "Correlation Filter", keywords: ["correlation", "correlated", "pairs", "conflict", "hedge", "doubling", "exposure", "smt"] },
  { tab: "instruments", label: "Max Correlated Positions", keywords: ["correlation", "max", "positions", "limit", "same direction"] },
  { tab: "instruments", label: "Per-Instrument SL Buffer", keywords: ["sl buffer", "stop loss", "per-instrument", "gold", "xau", "btc", "crypto", "commodity", "buffer pips", "instrument buffer"] },
  // Sessions
  { tab: "sessions", label: "Trading Sessions", keywords: ["session", "asian", "london", "new york", "off-hours", "offhours"] },
  { tab: "sessions", label: "Kill Zone Only Trading", keywords: ["kill zone", "killzone", "high volume"] },
  { tab: "sessions", label: "Enable News Filter", keywords: ["news", "nfp", "fomc", "cpi", "economic", "filter"] },
  { tab: "sessions", label: "Pause Window (minutes)", keywords: ["news", "pause", "window", "minutes"] },
  // Protection
  { tab: "protection", label: "Max Daily Loss ($)", keywords: ["daily loss", "kill switch", "dollar", "limit"] },
  { tab: "protection", label: "Max Consecutive Losses", keywords: ["consecutive", "losses", "streak", "pause"] },
  { tab: "protection", label: "Equity Circuit Breaker (%)", keywords: ["circuit breaker", "equity", "emergency", "stop"] },
  // Factor Weights
  { tab: "factorWeights", label: "Factor Weights", keywords: ["factor", "weight", "weights", "importance", "scoring", "tune", "ai", "advisor"] },
  { tab: "factorWeights", label: "Spread Quality", keywords: ["spread", "quality", "penalty", "atr", "execution"] },
  { tab: "factorWeights", label: "GP Key Level", keywords: ["game plan", "key level", "gp", "institutional", "dol"] },
  // Opening Range
  { tab: "openingRange", label: "Enable Opening Range", keywords: ["opening range", "or", "master"] },
  { tab: "openingRange", label: "Candle Count", keywords: ["candle", "count", "or", "range"] },
  { tab: "openingRange", label: "Daily Bias from OR", keywords: ["bias", "or", "daily"] },
  { tab: "openingRange", label: "Judas Swing Detection", keywords: ["judas", "swing", "fake", "sweep"] },
  { tab: "openingRange", label: "OR Key Levels", keywords: ["key levels", "or", "support", "resistance"] },
  { tab: "openingRange", label: "Premium/Discount from OR", keywords: ["premium", "discount", "or"] },
  { tab: "openingRange", label: "Wait for OR Completion", keywords: ["wait", "completion", "or"] },
  // Game Plan
  { tab: "gamePlan", label: "Enable Game Plan", keywords: ["game plan", "premarket", "session bias", "dol", "draw on liquidity"] },
  { tab: "gamePlan", label: "Game Plan Notifications", keywords: ["game plan", "telegram", "notify", "notification", "alert"] },
  { tab: "gamePlan", label: "Game Plan Refresh Interval", keywords: ["game plan", "refresh", "hours", "regenerate", "frequency"] },
  { tab: "gamePlan", label: "Game Plan Trade Filter", keywords: ["game plan", "filter", "gate", "bias", "reject", "alignment"] },
  { tab: "gamePlan", label: "DOL TP Extension", keywords: ["dol", "draw on liquidity", "tp", "take profit", "extension", "target"] },
  { tab: "gamePlan", label: "IPDA Ranges", keywords: ["ipda", "institutional", "data ranges", "20 day", "40 day", "60 day", "equilibrium"] },
  // Per-Pair Gate Overrides
  { tab: "pairOverrides", label: "Per-Pair Gate Overrides", keywords: ["pair", "symbol", "override", "per pair", "per symbol", "specific", "individual"] },
  { tab: "pairOverrides", label: "Per-Pair Min R:R", keywords: ["risk reward", "rr", "effective", "spread", "pair specific"] },
  { tab: "pairOverrides", label: "Per-Pair Tier 1", keywords: ["tier 1", "core factors", "pair", "minimum"] },
  { tab: "pairOverrides", label: "Per-Pair Stacking", keywords: ["stacking", "duplicate", "same direction", "max per symbol"] },
  { tab: "pairOverrides", label: "Per-Pair Confluence", keywords: ["confluence", "score", "threshold", "pair"] },
  { tab: "pairOverrides", label: "Per-Pair Daily Loss", keywords: ["daily", "loss", "pnl", "dollar", "limit", "pair"] },
  { tab: "pairOverrides", label: "Per-Pair Consecutive Losses", keywords: ["consecutive", "losses", "cooldown", "pair"] },
];

// ─── ICT 2022 module definitions (single source of truth for tab + search) ──
const ICT2022_MODULES: {
  key: string;
  label: string;
  description: string;
  enabledField: string;
  gateField: string;
  hasGate: boolean;
}[] = [
  {
    key: "htf",
    label: "HTF Framework",
    description: "Weekly Bias + Daily Impulse + Containment (is your LTF zone inside the Daily OB?). The top-level directional engine from the 2022 Mentorship.",
    enabledField: "ictHTFEnabled",
    gateField: "ictHTFGateMode",
    hasGate: true,
  },
  {
    key: "mss",
    label: "Displacement-Validated MSS",
    description: "A Market Structure Shift is only valid if the break candle shows displacement (body/range ≥ 0.6, range ≥ 1.2× ATR). Sluggish breaks are rejected.",
    enabledField: "ictDisplacementMSSEnabled",
    gateField: "ictDisplacementMSSGateMode",
    hasGate: true,
  },
  {
    key: "judas",
    label: "Judas Swing / Liquidity Sweep",
    description: "Requires a liquidity sweep on the opposite side BEFORE the MSS (the false move that takes stops, then real move begins).",
    enabledField: "ictJudasSwingEnabled",
    gateField: "ictJudasSwingGateMode",
    hasGate: true,
  },
  {
    key: "fvg",
    label: "FVG Invalidation Rules",
    description: "Body-close invalidation (wicks don't count), Consequent Encroachment at 50%, Rule of 2 (FVG exhausted after 2 touches without follow-through).",
    enabledField: "ictFVGInvalidationEnabled",
    gateField: "ictFVGInvalidationGateMode",
    hasGate: true,
  },
  {
    key: "kz",
    label: "Kill Zones & Silver Bullet",
    description: "London KZ, NY KZ, Silver Bullet 1/2/3 windows. Penalises lunch & Asian dead zones. Boosts setups inside prime windows.",
    enabledField: "ictKillZoneEnabled",
    gateField: "ictKillZoneGateMode",
    hasGate: true,
  },
  {
    key: "risk",
    label: "Risk Management",
    description: "Drawdown halving after losses, 1%/day & 2.5%/week loss caps, FVG Rule-of-2 exit, position sizing. Enable as advisory — no built-in gate mode.",
    enabledField: "ictRiskEnabled",
    gateField: "",
    hasGate: false,
  },
];

const ICT2022_SEARCH_ENTRIES = ICT2022_MODULES.flatMap(m => [
  { tab: "ict2022", label: m.label, keywords: ["ict", "mentorship", "2022", m.label.toLowerCase()] },
]);

// Append ICT entries to the main search index
SEARCH_INDEX.push(
  { tab: "ict2022", label: "ICT 2022 Mentorship", keywords: ["ict", "mentorship", "2022", "smc", "inner circle trader"] },
  ...ICT2022_SEARCH_ENTRIES
);

const HighlightContext = createContext<Set<string>>(new Set());


// ─── Full Config Presets ─────────────────────────────────────────────────
// Each preset is a complete config snapshot. Applying one replaces the entire config.
const BASE_CONFIG = {
  strategy: {
    enableBOS: true, enableCHoCH: true, enableOB: true, enableFVG: true, enableLiquiditySweep: true,
    confluenceThreshold: 55, htfBiasRequired: true, obLookbackCandles: 20,
    fvgMinSizePips: 5, fvgOnlyUnfilled: true, structureLookback: 50,
    liquidityPoolMinTouches: 2, premiumDiscountEnabled: true, onlyBuyInDiscount: true, onlySellInPremium: true,
    regimeScoringEnabled: true, regimeScoringStrength: 1.0,
    normalizedScoring: true,
  },
  risk: {
    riskPerTrade: 1, maxDailyLoss: 5, maxDrawdown: 15, positionSizingMethod: "percent_risk",
    fixedLotSize: 0.1, atrVolatilityMultiplier: 1.5, maxOpenPositions: 5, maxPositionsPerSymbol: 2, allowSameDirectionStacking: false, maxPortfolioHeat: 10, minRiskReward: 1.5,
    conflictThresholdRaise: 4, conflictBlockAt: 6,
  },
  entry: {
    defaultOrderType: "market", entryRefinement: false, refinementTimeframe: "5m",
    trailingEntry: false, trailingEntryPips: 5, maxSlippagePips: 2,
    closeOnReverse: true, cooldownMinutes: 15,
  },
  exit: {
    stopLossMethod: "structure", fixedSLPips: 25, slATRMultiple: 1.5, slATRPeriod: 14,
    takeProfitMethod: "rr_ratio", fixedTPPips: 50, tpRRRatio: 2.0, tpATRMultiple: 2.0,
    trailingStopEnabled: false, trailingStopPips: 15, trailingStopActivation: "after_1r",
    partialTPEnabled: false, partialTPPercent: 50, partialTPLevel: 1.0,
    breakEvenEnabled: true, breakEvenTriggerPips: 20,
    timeBasedExitEnabled: false, maxHoldEnabled: false, maxHoldHours: 24,
  },
  instruments: {
    allowedInstruments: {
      "EUR/USD": true, "GBP/USD": true, "USD/JPY": true, "GBP/JPY": true,
      "AUD/USD": true, "USD/CAD": true, "EUR/GBP": false, "NZD/USD": false,
      "XAU/USD": true, "XAG/USD": false, "BTC/USD": false, "ETH/USD": false,
    },
    spreadFilterEnabled: true, maxSpreadPips: 0, volatilityFilterEnabled: false,
    minATR: 0, maxATR: 999, correlationFilterEnabled: true, maxCorrelation: 0.7, maxCorrelatedPositions: 2,
  },
  sessions: {
    filter: ["london", "newyork"],
    activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
    newsFilterEnabled: true, newsFilterPauseMinutes: 30,
  },
  // notifications: removed — not consumed by bot-scanner, no UI controls
  protection: {
    maxDailyLoss: 500, maxConsecutiveLosses: 3, circuitBreakerPct: 20,
  },
  account: { startingBalance: 10000, leverage: 100, mode: "paper" },
  openingRange: { enabled: false, candleCount: 24, useBias: true, useJudasSwing: true, useKeyLevels: true, usePremiumDiscount: false, waitForCompletion: true },
  factorWeights: {},
};

const PRESETS: Record<string, { config: any; tradingStyle: "swing_trader" | "day_trader" | "scalper"; description: string }> = {
  conservative: {
    description: "Low risk, swing trading",
    tradingStyle: "swing_trader" as const,
    config: {
      strategy: {
        enableBOS: true, enableCHoCH: true, enableOB: true, enableFVG: true, enableLiquiditySweep: true,
        confluenceThreshold: 40, htfBiasRequired: true, obLookbackCandles: 20,
        fvgMinSizePips: 5, fvgOnlyUnfilled: true, structureLookback: 50,
        liquidityPoolMinTouches: 2, premiumDiscountEnabled: true, onlyBuyInDiscount: true, onlySellInPremium: true,
        regimeScoringEnabled: true, regimeScoringStrength: 1.5,
        normalizedScoring: true,
      },
      risk: {
        riskPerTrade: 1.5, maxDailyLoss: 3, maxDrawdown: 20, positionSizingMethod: "percent_risk",
        fixedLotSize: 0.1, atrVolatilityMultiplier: 1.5, maxOpenPositions: 2, maxPositionsPerSymbol: 1,
        allowSameDirectionStacking: false, maxPortfolioHeat: 10, minRiskReward: 2.5,
        conflictThresholdRaise: 4, conflictBlockAt: 6,
      },
      entry: {
        defaultOrderType: "market", entryRefinement: false, refinementTimeframe: "15m",
        trailingEntry: false, trailingEntryPips: 5, maxSlippagePips: 3,
        closeOnReverse: false, cooldownMinutes: 30,
      },
      exit: {
        stopLossMethod: "structure", fixedSLPips: 50, slATRMultiple: 1.5, slATRPeriod: 14,
        takeProfitMethod: "rr_ratio", fixedTPPips: 150, tpRRRatio: 3.0, tpATRMultiple: 3.0,
        trailingStopEnabled: false, trailingStopPips: 25, trailingStopActivation: "after_2r",
        partialTPEnabled: false, partialTPPercent: 33, partialTPLevel: 1.0,
        breakEvenEnabled: false, breakEvenTriggerPips: 40,
        timeBasedExitEnabled: false, maxHoldEnabled: false, maxHoldHours: 120,
      },
      instruments: {
        allowedInstruments: {
          "EUR/USD": true, "GBP/USD": true, "USD/JPY": false, "GBP/JPY": true,
          "AUD/USD": false, "USD/CAD": false, "EUR/GBP": false, "NZD/USD": false,
          "XAU/USD": true, "XAG/USD": false, "BTC/USD": false, "ETH/USD": false,
        },
        spreadFilterEnabled: true, maxSpreadPips: 0, volatilityFilterEnabled: false,
        minATR: 0, maxATR: 999, correlationFilterEnabled: true, maxCorrelation: 0.7, maxCorrelatedPositions: 2,
      },
      sessions: {
        filter: ["london", "newyork"],
        activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
        newsFilterEnabled: true, newsFilterPauseMinutes: 60,
      },
      protection: { maxDailyLoss: 500, maxConsecutiveLosses: 2, circuitBreakerPct: 20 },
      account: { startingBalance: 10000, leverage: 100, mode: "paper" },
      openingRange: { enabled: false, candleCount: 24, useBias: true, useJudasSwing: true, useKeyLevels: true, usePremiumDiscount: false, waitForCompletion: true },
      factorWeights: {},
      tradingStyle: { mode: "swing_trader" },
    },
  },
  moderate: {
    description: "Balanced day trading",
    tradingStyle: "day_trader" as const,
    config: {
      strategy: {
        enableBOS: true, enableCHoCH: true, enableOB: true, enableFVG: true, enableLiquiditySweep: true,
        confluenceThreshold: 55, htfBiasRequired: true, obLookbackCandles: 20,
        fvgMinSizePips: 5, fvgOnlyUnfilled: true, structureLookback: 50,
        liquidityPoolMinTouches: 2, premiumDiscountEnabled: true, onlyBuyInDiscount: true, onlySellInPremium: true,
        regimeScoringEnabled: true, regimeScoringStrength: 1.0,
        normalizedScoring: true,
      },
      risk: {
        riskPerTrade: 1, maxDailyLoss: 3, maxDrawdown: 15, positionSizingMethod: "percent_risk",
        fixedLotSize: 0.1, atrVolatilityMultiplier: 1.5, maxOpenPositions: 4, maxPositionsPerSymbol: 2,
        allowSameDirectionStacking: false, maxPortfolioHeat: 10, minRiskReward: 1.5,
        conflictThresholdRaise: 4, conflictBlockAt: 6,
      },
      entry: {
        defaultOrderType: "market", entryRefinement: false, refinementTimeframe: "5m",
        trailingEntry: false, trailingEntryPips: 5, maxSlippagePips: 2,
        closeOnReverse: true, cooldownMinutes: 15,
      },
      exit: {
        stopLossMethod: "structure", fixedSLPips: 25, slATRMultiple: 1.5, slATRPeriod: 14,
        takeProfitMethod: "rr_ratio", fixedTPPips: 50, tpRRRatio: 2.0, tpATRMultiple: 2.0,
        trailingStopEnabled: true, trailingStopPips: 15, trailingStopActivation: "after_1.5r",
        partialTPEnabled: true, partialTPPercent: 50, partialTPLevel: 1.0,
        breakEvenEnabled: true, breakEvenTriggerPips: 20,
        timeBasedExitEnabled: true, maxHoldEnabled: true, maxHoldHours: 24,
      },
      instruments: {
        allowedInstruments: {
          "EUR/USD": true, "GBP/USD": true, "USD/JPY": true, "GBP/JPY": true,
          "AUD/USD": true, "USD/CAD": true, "EUR/GBP": false, "NZD/USD": false,
          "XAU/USD": true, "XAG/USD": false, "BTC/USD": false, "ETH/USD": false,
        },
        spreadFilterEnabled: true, maxSpreadPips: 0, volatilityFilterEnabled: false,
        minATR: 0, maxATR: 999, correlationFilterEnabled: true, maxCorrelation: 0.7, maxCorrelatedPositions: 2,
      },
      sessions: {
        filter: ["london", "newyork"],
        activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
        newsFilterEnabled: true, newsFilterPauseMinutes: 30,
      },
      protection: { maxDailyLoss: 300, maxConsecutiveLosses: 3, circuitBreakerPct: 15 },
      account: { startingBalance: 10000, leverage: 100, mode: "paper" },
      openingRange: { enabled: false, candleCount: 24, useBias: true, useJudasSwing: true, useKeyLevels: true, usePremiumDiscount: false, waitForCompletion: true },
      factorWeights: {},
      tradingStyle: { mode: "day_trader" },
    },
  },
  aggressive: {
    description: "High frequency scalping",
    tradingStyle: "scalper" as const,
    config: {
      strategy: {
        enableBOS: true, enableCHoCH: true, enableOB: true, enableFVG: true, enableLiquiditySweep: true,
        confluenceThreshold: 40, htfBiasRequired: true, obLookbackCandles: 20,
        fvgMinSizePips: 5, fvgOnlyUnfilled: true, structureLookback: 50,
        liquidityPoolMinTouches: 2, premiumDiscountEnabled: false, onlyBuyInDiscount: false, onlySellInPremium: false,
        regimeScoringEnabled: false, regimeScoringStrength: 1.0,
        normalizedScoring: true,
      },
      risk: {
        riskPerTrade: 0.5, maxDailyLoss: 3, maxDrawdown: 10, positionSizingMethod: "percent_risk",
        fixedLotSize: 0.1, atrVolatilityMultiplier: 1.5, maxOpenPositions: 3, maxPositionsPerSymbol: 1,
        allowSameDirectionStacking: false, maxPortfolioHeat: 5, minRiskReward: 1.5,
        conflictThresholdRaise: 4, conflictBlockAt: 6,
      },
      entry: {
        defaultOrderType: "market", entryRefinement: false, refinementTimeframe: "1m",
        trailingEntry: false, trailingEntryPips: 3, maxSlippagePips: 1,
        closeOnReverse: true, cooldownMinutes: 5,
      },
      exit: {
        stopLossMethod: "structure", fixedSLPips: 10, slATRMultiple: 1.5, slATRPeriod: 14,
        takeProfitMethod: "rr_ratio", fixedTPPips: 20, tpRRRatio: 2.0, tpATRMultiple: 2.0,
        trailingStopEnabled: false, trailingStopPips: 8, trailingStopActivation: "after_1r",
        partialTPEnabled: false, partialTPPercent: 50, partialTPLevel: 1.0,
        breakEvenEnabled: false, breakEvenTriggerPips: 8,
        timeBasedExitEnabled: true, maxHoldEnabled: true, maxHoldHours: 4,
      },
      instruments: {
        allowedInstruments: {
          "EUR/USD": true, "GBP/USD": false, "USD/JPY": false, "GBP/JPY": false,
          "AUD/USD": false, "USD/CAD": false, "EUR/GBP": false, "NZD/USD": false,
          "XAU/USD": false, "XAG/USD": false, "BTC/USD": false, "ETH/USD": false,
        },
        spreadFilterEnabled: true, maxSpreadPips: 0, volatilityFilterEnabled: false,
        minATR: 0, maxATR: 999, correlationFilterEnabled: true, maxCorrelation: 0.7, maxCorrelatedPositions: 2,
      },
      sessions: {
        filter: ["london", "newyork"],
        activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
        newsFilterEnabled: true, newsFilterPauseMinutes: 15,
      },
      protection: { maxDailyLoss: 300, maxConsecutiveLosses: 4, circuitBreakerPct: 10 },
      account: { startingBalance: 10000, leverage: 100, mode: "paper" },
      openingRange: { enabled: false, candleCount: 24, useBias: true, useJudasSwing: true, useKeyLevels: true, usePremiumDiscount: false, waitForCompletion: true },
      factorWeights: {},
      tradingStyle: { mode: "scalper" },
    },
  },
};

interface BotConfigModalProps {
  open: boolean;
  onClose: () => void;
  connectionId?: string;
  connectionName?: string;
  defaultTab?: string;
  defaultSearch?: string;
}

export function BotConfigModal({ open, onClose, connectionId, connectionName, defaultTab, defaultSearch }: BotConfigModalProps) {
  const queryClient = useQueryClient();
  const queryKey = connectionId ? ["bot-config", connectionId] : ["bot-config"];
  const { data: rawConfig } = useQuery({ queryKey, queryFn: () => botConfigApi.get(connectionId), enabled: open });
  const [config, setConfig] = useState<any>(null);
  const [activeTab, setActiveTab] = useState(defaultTab || "strategy");
  const [search, setSearch] = useState(defaultSearch || "");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rawConfig && open) setConfig(JSON.parse(JSON.stringify(rawConfig)));
  }, [rawConfig, open]);

  // Reset search + autofocus when modal opens; apply defaults if provided
  useEffect(() => {
    if (open) {
      setSearch(defaultSearch || "");
      if (defaultTab) setActiveTab(defaultTab);
      // Defer to next tick so input is mounted
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, defaultTab, defaultSearch]);

  const saveMut = useMutation({
    mutationFn: () => {
      if (!config) return Promise.reject(new Error("Config not loaded yet"));
      return botConfigApi.update(config, connectionId);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Config saved"); onClose(); },
    onError: (e: any) => {
      const msg = e?.message || "Failed to save config";
      if (msg.toLowerCase().includes("validation") || msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("must be")) {
        toast.error("Config Validation Error", { description: msg, duration: 8000 });
      } else {
        toast.error(msg);
      }
    },
  });

  const resetMut = useMutation({
    mutationFn: () => botConfigApi.reset(connectionId),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey });
      // The reset endpoint returns the default config — use it immediately
      // so the UI doesn't go blank while waiting for the re-fetch.
      if (data) setConfig(JSON.parse(JSON.stringify(data)));
      toast.success("Config reset to defaults");
    },
    onError: (e: any) => {
      toast.error(e?.message || "Failed to reset config");
    },
  });

  const copyFromGlobalMut = useMutation({
    mutationFn: async () => {
      const globalConfig = await botConfigApi.get();
      return globalConfig;
    },
    onSuccess: (data: any) => { setConfig(JSON.parse(JSON.stringify(data))); toast.success("Copied from global config"); },
  });

  const updateField = (section: string, key: string, value: any) => {
    setConfig((prev: any) => ({ ...prev, [section]: { ...(prev?.[section] || {}), [key]: value } }));
  };

  // ─── Custom Presets ───
  const [showSavePresetDialog, setShowSavePresetDialog] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetDescription, setPresetDescription] = useState("");
  const [showMyPresets, setShowMyPresets] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const { data: customPresets = [], refetch: refetchPresets } = useQuery({
    queryKey: ["config-presets"],
    queryFn: () => botConfigApi.listPresets(),
    enabled: open,
  });

  const savePresetMut = useMutation({
    mutationFn: () => botConfigApi.savePreset(presetName.trim(), config, presetDescription.trim() || undefined),
    onSuccess: (result: any) => {
      refetchPresets();
      setShowSavePresetDialog(false);
      setPresetName("");
      setPresetDescription("");
      toast.success(result.updated ? `Preset "${presetName}" updated` : `Preset "${presetName}" saved`);
    },
    onError: (e: any) => {
      const msg = e?.message || "Failed to save preset";
      if (msg.toLowerCase().includes("maximum") || msg.toLowerCase().includes("limit")) {
        toast.error("Preset limit reached", { description: "You can save up to 20 presets. Delete an existing preset to make room." });
      } else {
        toast.error(msg);
      }
    },
  });

  const deletePresetMut = useMutation({
    mutationFn: (id: string) => botConfigApi.deletePreset(id),
    onSuccess: () => {
      refetchPresets();
      setDeleteConfirmId(null);
      toast.success("Preset deleted");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const applyPresetConfig = (presetConfig: any, label: string) => {
    if (!config) return;
    // Deep clone to avoid reference sharing
    setConfig(JSON.parse(JSON.stringify(presetConfig)));
    toast.info(`Applied preset: ${label}`);
  };

  if (!open) return null;

  const tabs = [
    { id: "tradingStyle", label: "Trading Style", icon: Gauge },
    { id: "strategy", label: "Strategy", icon: TrendingUp },
    { id: "risk", label: "Risk", icon: Shield },
    { id: "entry_exit", label: "Entry / Exit", icon: LogIn },
    { id: "instruments", label: "Instruments", icon: Globe },
    { id: "sessions", label: "Sessions", icon: Clock },
    { id: "protection", label: "Protection", icon: ShieldAlert },
    { id: "pairOverrides", label: "Per-Pair Gates", icon: Target },
    { id: "factorWeights", label: "Factor Weights", icon: SlidersHorizontal },
    { id: "openingRange", label: "Opening Range", icon: BarChart3 },
    { id: "gamePlan", label: "Game Plan", icon: Crosshair },
    { id: "ict2022", label: "ICT 2022", icon: Sparkles },
  ];

  // Search filtering — compute once per render
  const query = search.trim().toLowerCase();
  const matches = query
    ? SEARCH_INDEX.filter(item =>
        item.label.toLowerCase().includes(query) ||
        item.keywords.some(k => k.toLowerCase().includes(query))
      )
    : [];
  const matchedTabIds = new Set(matches.map(m => m.tab));
  const matchedLabels = new Set(matches.map(m => m.label.toLowerCase()));
  const filteredTabs = query ? tabs.filter(t => matchedTabIds.has(t.id)) : tabs;
  // Auto-select first matching tab when search yields results but current tab no longer matches
  const effectiveActiveTab =
    query && filteredTabs.length > 0 && !matchedTabIds.has(activeTab)
      ? filteredTabs[0].id
      : activeTab;


  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-0 md:p-4">
      <div className="bg-card border border-border w-full max-w-4xl h-full md:h-auto md:max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 md:px-6 py-3 md:py-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-sm md:text-base font-bold truncate">{connectionName ? `Config: ${connectionName}` : "Global Bot Configuration"}</h2>
            {connectionName && <p className="text-[10px] text-muted-foreground">Settings specific to this broker connection</p>}
          </div>
          <div className="flex items-center gap-1 md:gap-2 shrink-0">
            {connectionId && (
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => copyFromGlobalMut.mutate()}>Copy from Global</Button>
            )}
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => resetMut.mutate()}>Reset Defaults</Button>
            <Button variant="outline" size="sm" className="text-xs gap-1" onClick={() => { setPresetName(""); setPresetDescription(""); setShowSavePresetDialog(true); }}>
              <Bookmark className="h-3 w-3" /> Save as Preset
            </Button>
            <Button size="sm" className="text-xs" onClick={() => saveMut.mutate()}>Save Config</Button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground ml-2"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Presets Bar */}
        {customPresets.length > 0 && (
        <div className="px-6 py-3 border-b border-border bg-secondary/30">
          {/* My Presets */}
            <div>
              <button
                onClick={() => setShowMyPresets(!showMyPresets)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors w-full"
              >
                <FolderOpen className="h-3 w-3 text-primary" />
                My Presets ({customPresets.length})
                {showMyPresets ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
              </button>
              {showMyPresets && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                  {customPresets.map((cp: any) => (
                    <div key={cp.id} className="group relative p-3 border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors text-left">
                      <button
                        onClick={() => applyPresetConfig(cp.config_json, cp.name)}
                        className="w-full text-left"
                      >
                        <p className="text-xs font-bold truncate pr-6">{cp.name}</p>
                        {cp.description && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{cp.description}</p>}
                        <p className="text-[9px] text-muted-foreground/60 mt-1">{formatBrokerTime(cp.updated_at)}</p>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(cp.id); }}
                        className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                        title="Delete preset"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
        </div>
        )}

        {/* Save Preset Dialog */}
        <Dialog open={showSavePresetDialog} onOpenChange={setShowSavePresetDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm">Save Config as Preset</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Save the current configuration as a reusable preset. If a preset with the same name exists, it will be updated.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Preset Name</Label>
                <Input
                  value={presetName}
                  onChange={e => setPresetName(e.target.value)}
                  placeholder="e.g. High Volatility Week, News Day Safe"
                  className="text-xs h-8"
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter" && presetName.trim()) savePresetMut.mutate(); }}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Description (optional)</Label>
                <Textarea
                  value={presetDescription}
                  onChange={e => setPresetDescription(e.target.value)}
                  placeholder="What is this preset tuned for?"
                  className="text-xs min-h-[60px] resize-none"
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setShowSavePresetDialog(false)}>Cancel</Button>
              <Button size="sm" className="text-xs gap-1" onClick={() => savePresetMut.mutate()} disabled={!presetName.trim() || savePresetMut.isPending}>
                <Save className="h-3 w-3" /> {savePresetMut.isPending ? "Saving..." : "Save Preset"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Preset Confirmation */}
        <Dialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Delete Preset</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                This preset will be permanently deleted. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
              <Button variant="destructive" size="sm" className="text-xs gap-1" onClick={() => { if (deleteConfirmId) deletePresetMut.mutate(deleteConfirmId); }} disabled={deletePresetMut.isPending}>
                <Trash2 className="h-3 w-3" /> {deletePresetMut.isPending ? "Deleting..." : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Search Bar */}
        <div className="px-6 py-2.5 border-b border-border bg-background/40">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") {
                  if (search) {
                    e.stopPropagation();
                    setSearch("");
                  } else {
                    onClose();
                  }
                }
              }}
              placeholder="Search settings… (e.g. trailing stop, spread, news, drawdown)"
              className="h-8 pl-8 text-xs bg-secondary/40 border-border"
            />
            {query && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {query && (
            <p className="text-[10px] text-muted-foreground mt-1.5">
              {matches.length === 0
                ? `No settings match "${search}"`
                : `${matches.length} setting${matches.length === 1 ? "" : "s"} across ${filteredTabs.length} tab${filteredTabs.length === 1 ? "" : "s"}`}
            </p>
          )}
        </div>

        {/* Body: Tab nav + content */}
        <div className="flex flex-col md:flex-row flex-1 min-h-0">
          {/* Vertical Tab Nav */}
          <div className="md:w-44 border-b md:border-b-0 md:border-r border-border py-2 shrink-0 overflow-x-auto md:overflow-y-auto flex md:flex-col">
            {filteredTabs.length === 0 && (
              <p className="px-4 py-3 text-[10px] text-muted-foreground italic">No matching tabs</p>
            )}
            {filteredTabs.map(tab => {
              const isActive = effectiveActiveTab === tab.id;
              const matchCount = query ? matches.filter(m => m.tab === tab.id).length : 0;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors ${isActive ? "bg-primary/10 text-primary border-l-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/30 border-l-2 border-transparent"}`}
                >
                  <tab.icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 text-left">{tab.label}</span>
                  {matchCount > 0 && (
                    <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-mono">{matchCount}</Badge>
                  )}
                </button>
              );
            })}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-3 md:p-6">
            <HighlightContext.Provider value={matchedLabels}>
            {config && filteredTabs.length > 0 && (
              <>
                {effectiveActiveTab === "tradingStyle" && (
                  <div className="space-y-5">
                    <SectionHeader title="Trading Style" description="Choose how the bot trades — this overrides entry timeframe, TP/SL ratios, and hold duration" />
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {(["scalper", "day_trader", "swing_trader"] as TradingStyleMode[]).map(mode => {
                        const isActive = (config.tradingStyle?.mode || "day_trader") === mode;
                        const meta = STYLE_META[mode];
                        const params = STYLE_PARAMS[mode];
                        return (
                          <button
                            key={mode}
                            onClick={() => {
                              const presetKey = mode === "scalper" ? "aggressive" : mode === "day_trader" ? "moderate" : "conservative";
                              applyPresetConfig(PRESETS[presetKey].config, `${STYLE_META[mode].icon} ${STYLE_META[mode].label}`);
                            }}
                            className={`p-4 border text-left transition-colors ${isActive ? "border-primary bg-primary/5" : "border-border hover:border-border/80"}`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-lg">{meta.icon}</span>
                              <span className="text-xs font-bold">{meta.label}</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              {meta.description}
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-muted-foreground">
                              <span>Entry TF: <strong className="text-foreground">{params.entryTimeframe}</strong></span>
                              <span>HTF Bias: <strong className="text-foreground">{params.htfTimeframe}</strong></span>
                              <span>TP Ratio: <strong className="text-foreground">{params.tpRatio}:1</strong></span>
                              <span>SL Buffer: <strong className="text-foreground">{params.slBufferPips} pip</strong></span>
                              <span>Threshold: <strong className="text-foreground">{params.confluenceThreshold}%</strong></span>
                              <span>Max Hold: <strong className="text-foreground">{params.maxHoldHours === 0 ? "None" : `${params.maxHoldHours}h`}</strong></span>
                            </div>
                            <div className="mt-1.5 pt-1.5 border-t border-border/50 grid grid-cols-3 gap-x-2 gap-y-0.5 text-[8px] text-muted-foreground">
                              <span>Trail: <strong className={params.trailingStopEnabled ? "text-success" : "text-muted-foreground"}>{params.trailingStopEnabled ? `${params.trailingStopPips}p` : "Off"}</strong></span>
                              <span>BE: <strong className={params.breakEvenEnabled ? "text-success" : "text-muted-foreground"}>{params.breakEvenEnabled ? `${params.breakEvenPips}p` : "Off"}</strong></span>
                              <span>Partial: <strong className={params.partialTPEnabled ? "text-success" : "text-muted-foreground"}>{params.partialTPEnabled ? `${params.partialTPPercent}%@${params.partialTPLevel}R` : "Off"}</strong></span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted-foreground italic">
                      Clicking a style sets ALL parameters (strategy, risk, instruments, sessions, protection). You can fine-tune in the other tabs afterwards.
                    </p>
                  </div>
                )}

                {effectiveActiveTab === "strategy" && (
                  <div className="space-y-5">
                    <SectionHeader title="Strategy Settings" description="Configure how the bot identifies trade setups" />
                    <FieldGroup label="Auto Scan Interval" description="How often the bot scans for new setups. Manual scans always run on demand regardless of this setting.">
                      <div className="flex items-center gap-4">
                        <select
                          value={config.entry?.scanIntervalMinutes ?? 15}
                          onChange={e => updateField('entry', 'scanIntervalMinutes', Number(e.target.value))}
                          className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                        >
                          <option value={5}>Every 5 minutes</option>
                          <option value={10}>Every 10 minutes</option>
                          <option value={15}>Every 15 minutes (default)</option>
                          <option value={20}>Every 20 minutes</option>
                          <option value={30}>Every 30 minutes</option>
                          <option value={45}>Every 45 minutes</option>
                          <option value={60}>Every 1 hour</option>
                        </select>
                        <span className="text-sm font-mono font-bold text-primary w-14 text-right">{config.entry?.scanIntervalMinutes ?? 15}m</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        Server cron runs every 5 min. If interval hasn't elapsed since last scan, the cron cycle is skipped.
                      </p>
                    </FieldGroup>
                    <FieldGroup label="Confluence Threshold" description="Minimum percentage (0-100%) of enabled factor max required to trigger a trade">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.confluenceThreshold ?? 55]} onValueChange={v => updateField('strategy', 'confluenceThreshold', v[0])} min={20} max={90} step={5} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-14 text-right">{config.strategy?.confluenceThreshold ?? 55}%</span>
                      </div>
                    </FieldGroup>
                    <FieldGroup label="Min Zone Score" description="Minimum impulse zone quality score (0–9) to accept a trade. Zones below this threshold are rejected as low-conviction.">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.minZoneScore ?? 4]} onValueChange={v => updateField('strategy', 'minZoneScore', v[0])} min={0} max={9} step={0.5} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-14 text-right">{config.strategy?.minZoneScore ?? 4}/9</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        Zone score = fibDepth + S/R confirmed + LTF refined + HTF confluence. Set to 0 to disable this gate.
                      </p>
                    </FieldGroup>
                    <ToggleField label="Tier 1 Gate Enabled" description="When OFF, the Tier 1 core factors gate (Gate 19) is completely disabled — setups will pass regardless of how many core factors they have. Use this to let your score threshold and R:R gates handle quality filtering instead." checked={config.strategy?.tier1GateEnabled ?? true} onChange={v => updateField('strategy', 'tier1GateEnabled', v)} />
                    {(config.strategy?.tier1GateEnabled ?? true) && (
                    <FieldGroup label="Min Tier 1 Core Factors" description="Minimum number of Tier 1 factors (Market Structure, OB, FVG, Premium/Discount & Fib, Unicorn, HTF FVG/OB/Fib) required to pass Gate 19. Lower = more trades, higher = stricter quality filter.">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.minTier1Factors ?? 3]} onValueChange={v => updateField('strategy', 'minTier1Factors', v[0])} min={1} max={5} step={1} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-14 text-right">{config.strategy?.minTier1Factors ?? 3}/5</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        Default: 3. Set to 2 for more aggressive trading, 4–5 for ultra-conservative (fewer signals).
                      </p>
                    </FieldGroup>
                    )}
                    {/* Min Strong Factors and Min Factor Count removed — single percentage threshold only */}
                    <ToggleField label="Require Unified Zone Confirmation" description="Only take trades when the Unified Zone Engine confirms entry (impulse → zone → liquidity → confirmation). Confirmation can be CHoCH, BOS, sweep+CHoCH, or displacement MSS. Disables the standalone impulse zone fallback — higher win rate, fewer trades." checked={config.strategy?.requireUnifiedZone ?? false} onChange={v => updateField('strategy', 'requireUnifiedZone', v)} />
                    <ToggleField label="Require Entry-Trigger Sweep" description="Block entry until the entry-trigger liquidity pool (BSL above zone for shorts, SSL below zone for longs) has been swept and rejected. Pairs are staged as 'sweep_watch' and auto-re-evaluated when the pool gets swept." checked={config.strategy?.requireLiquiditySweep ?? false} onChange={v => updateField('strategy', 'requireLiquiditySweep', v)} />
                    {(config.strategy?.requireLiquiditySweep ?? false) && (
                    <FieldGroup label="Swept-Absorbed Penalty" description="Score penalty applied when the entry-trigger pool was swept but absorbed (broken through without rejection). Higher = more aggressive filtering of invalidated zones.">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.sweptAbsorbedPenalty ?? 2.0]} onValueChange={v => updateField('strategy', 'sweptAbsorbedPenalty', v[0])} min={0} max={5} step={0.5} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-14 text-right">{config.strategy?.sweptAbsorbedPenalty ?? 2.0}</span>
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-1.5">
                        Default: 2.0. Set to 0 to disable the penalty. A swept-absorbed pool means protective liquidity was consumed without reversal — the zone may be invalidated.
                      </p>
                    </FieldGroup>
                    )}
                    {/* ── Impulse Zone Gate Mode ── */}
                    <FieldGroup label="Impulse Zone Gate Mode" description="Controls how strictly the impulse zone requirement is enforced when Unified Zone is OFF.">
                      <div className="flex items-center gap-3">
                        <Select value={config.strategy?.impulseZoneGateMode ?? 'hard'} onValueChange={(v: string) => updateField('strategy', 'impulseZoneGateMode', v)}>
                          <SelectTrigger className="h-9 text-sm w-48"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="hard">Hard — no zone = skip pair</SelectItem>
                            <SelectItem value="soft">Soft — score penalty only</SelectItem>
                            <SelectItem value="off">Off — zones informational</SelectItem>
                          </SelectContent>
                        </Select>
                        {(config.strategy?.impulseZoneGateMode ?? 'hard') !== 'off' && (
                          <Badge variant="outline" className={`text-[9px] font-mono ${
                            (config.strategy?.impulseZoneGateMode ?? 'hard') === 'hard' ? 'text-loss border-loss/40' : 'text-warn border-warn/40'
                          }`}>
                            {(config.strategy?.impulseZoneGateMode ?? 'hard') === 'hard' ? 'BLOCKING' : 'SCORING'}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-1.5">
                        Hard = pair is skipped if no valid impulse zone exists. Soft = score penalty ({config.strategy?.impulseZonePenalty ?? 2.0} pts) but trade can still proceed. Off = zones are shown in the Zone Story but don't affect trade decisions.
                      </p>
                    </FieldGroup>
                    {/* ── Fib Max Retracement ── */}
                    <FieldGroup label="Max Fib Retracement" description="How deep a zone can sit inside the impulse retracement and still qualify. Higher = more zones qualify near the origin, but SL headroom shrinks (capped at impulse origin).">
                      <div className="flex items-center gap-3">
                        <Select
                          value={String(config.strategy?.fibMaxRetracement ?? 0.786)}
                          onValueChange={(v: string) => updateField('strategy', 'fibMaxRetracement', parseFloat(v))}
                        >
                          <SelectTrigger className="h-9 text-sm w-48"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="0.786">78.6% — Standard (OTE)</SelectItem>
                            <SelectItem value="0.886">88.6% — Deep (more zones)</SelectItem>
                            <SelectItem value="1">100% — To impulse origin</SelectItem>
                          </SelectContent>
                        </Select>
                        <Badge variant="outline" className="text-[9px] font-mono text-muted-foreground">
                          {Math.round(((config.strategy?.fibMaxRetracement ?? 0.786)) * 1000) / 10}%
                        </Badge>
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-1.5">
                        Default 78.6%. Setting 88.6% or 100% catches deeper taps (returns to origin OB), but risk pips shrink because SL is capped at impulse origin.
                      </p>
                    </FieldGroup>
                    {/* ── Origin OB Re-test ── */}
                    <ToggleField
                      label="Origin OB Re-test"
                      description="Allow entries when price returns to the order block that CAUSED the impulse (fib 1.0). The zone is the last opposing candle at the impulse origin swing. Still requires the LTF confirmation gate (CHoCH / displacement / sweep) before firing."
                      checked={config.strategy?.originOBRetest ?? false}
                      onChange={v => updateField('strategy', 'originOBRetest', v)}
                    />
                    {/* ── Entry Flow Diagram ── */}
                    <div className="border border-border/50 rounded-lg p-3 bg-muted/30">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-2">Entry Decision Flow</p>
                      <div className="text-[10px] font-mono text-muted-foreground space-y-1">
                        <p>1. Scanner detects confluence signal for pair</p>
                        <p>2. Impulse Zone Gate checks:</p>
                        <p className="pl-3">• Hard → must have valid zone or pair is skipped</p>
                        <p className="pl-3">• Soft → penalty applied, trade may proceed</p>
                        <p className="pl-3">• Off → no zone requirement</p>
                        <p>3. If Unified Zone Confirmation = ON:</p>
                        <p className="pl-3">• Must reach "triggered" state (impulse→zone→liq→confirm)</p>
                        <p className="pl-3">• If not triggered → pair skipped (no fallback)</p>
                        <p className="pl-3">• Zone depth controlled by Max Fib Retracement (78.6% / 88.6% / 100%)</p>
                        <p className="pl-3">• Origin OB Re-test adds the impulse-origin OB as a valid zone</p>
                        <p className="pl-3">• If Require Entry-Trigger Sweep = ON → waits for BSL/SSL sweep</p>
                        <p>4. Entry method (when zone exists):</p>
                        <p className="pl-3">• Price AT zone + Market Fill ON → immediate fill</p>
                        <p className="pl-3">• Price AT zone + Market Fill OFF → wait for LTF confirm</p>
                        <p className="pl-3">• Price NOT at zone + Pending Orders ON → watch & wait</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <ToggleField label="Order Blocks" description="Detect institutional order blocks" checked={config.strategy?.useOrderBlocks ?? true} onChange={v => updateField('strategy', 'useOrderBlocks', v)} />
                      <ToggleField label="Fair Value Gaps" description="Identify FVG imbalances" checked={config.strategy?.useFVG ?? true} onChange={v => updateField('strategy', 'useFVG', v)} />
                      <ToggleField label="Liquidity Sweeps" description="Track liquidity pool sweeps" checked={config.strategy?.useLiquiditySweep ?? true} onChange={v => updateField('strategy', 'useLiquiditySweep', v)} />
                      <ToggleField label="Structure Breaks" description="BOS / CHoCH detection" checked={config.strategy?.useStructureBreak ?? true} onChange={v => updateField('strategy', 'useStructureBreak', v)} />
                      <ToggleField label="Displacement Detection" description="Score bonus when OBs/FVGs form with strong displacement candles" checked={config.strategy?.useDisplacement ?? true} onChange={v => updateField('strategy', 'useDisplacement', v)} />
                      <ToggleField label="Breaker Blocks" description="Detect failed OBs that flip into support/resistance" checked={config.strategy?.useBreakerBlocks ?? true} onChange={v => updateField('strategy', 'useBreakerBlocks', v)} />
                      <ToggleField label="Unicorn Model" description="Highest conviction: Breaker + FVG overlap zone (1.5 pts)" checked={config.strategy?.useUnicornModel ?? true} onChange={v => updateField('strategy', 'useUnicornModel', v)} />
                      <ToggleField label="Silver Bullet Windows" description="ICT macro windows (London 08-09, AM 15-16, PM 19-20 UTC). +1.0 pt, +0.5 combo bonus when overlapping a kill zone" checked={config.strategy?.useSilverBullet ?? true} onChange={v => updateField('strategy', 'useSilverBullet', v)} />
                      <ToggleField label="ICT Macro Windows" description="8 institutional reprice windows (~20min each). +0.5 pt, +0.5 combo bonus when overlapping a Silver Bullet" checked={config.strategy?.useMacroWindows ?? true} onChange={v => updateField('strategy', 'useMacroWindows', v)} />
                      <ToggleField label="SMT Divergence" description="Compares pair vs correlated pair (e.g. EUR/USD vs GBP/USD). +1.0 pt when one sweeps liquidity but the other holds" checked={config.strategy?.useSMT ?? true} onChange={v => updateField('strategy', 'useSMT', v)} />
                      <ToggleField label="SMT Opposite Veto" description="Block trades where SMT divergence opposes signal direction. Hard veto — trade will not be placed regardless of score" checked={config.strategy?.smtOppositeVeto ?? true} onChange={v => updateField('strategy', 'smtOppositeVeto', v)} />
                      <ToggleField label="Volume Profile" description="TPO-based volume profile: POC (Point of Control), HVN/LVN detection. +0.75 pts when price at key volume node" checked={config.strategy?.useVolumeProfile ?? true} onChange={v => updateField('strategy', 'useVolumeProfile', v)} />
                      <ToggleField label="Daily Bias" description="Higher timeframe daily bias confirmation. +1.0 pts when daily candle structure aligns with trade direction" checked={config.strategy?.useDailyBias ?? true} onChange={v => updateField('strategy', 'useDailyBias', v)} />
                      <ToggleField label="AMD Phase Detection" description="Accumulation→Manipulation→Distribution. +1.0 pt when bias-aligned phase detected. Power of 3 combo bonus (+1.0) when AMD + Sweep/Judas + Trend all align" checked={config.strategy?.useAMD ?? true} onChange={v => updateField('strategy', 'useAMD', v)} />
                      <ToggleField label="FOTSI Currency Strength" description="Scores trades by currency flow (+1.5 pts when buying strong vs weak). Blocks trades when TSI exceeds +50 (overbought) or -50 (oversold) — prevents buying exhausted currencies" checked={config.strategy?.useFOTSI ?? true} onChange={v => updateField('strategy', 'useFOTSI', v)} />
                    </div>
                    <ToggleField label="Require HTF Bias Alignment" description="Only trade in the direction of higher timeframe bias" checked={config.strategy?.requireHTFBias ?? true} onChange={v => updateField('strategy', 'requireHTFBias', v)} />
                    <ToggleField label="HTF Bias Hard Veto" description="Block longs unless daily is bullish, shorts unless daily is bearish (no ranging exception, no score override)" checked={config.strategy?.htfBiasHardVeto ?? false} onChange={v => updateField('strategy', 'htfBiasHardVeto', v)} />
                    <div className="border-t border-border pt-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Structural Conviction Gate</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">Blocks trades when entry-timeframe fractals offer zero support for the direction. Lower thresholds = less restrictive (more trades allowed).</p>
                        </div>
                        <Switch checked={config.strategy?.structuralConvictionEnabled !== false} onCheckedChange={v => updateField('strategy', 'structuralConvictionEnabled', v)} />
                      </div>
                      {config.strategy?.structuralConvictionEnabled !== false && <div className="grid grid-cols-2 gap-4">
                        <FieldGroup label="Long S2F Block Threshold" description="Block longs when Bull fractals 0% AND S2F below this %. Default 35%.">
                          <div className="flex items-center gap-4">
                            <Slider value={[(config.strategy?.structuralConvictionS2FLong ?? 0.35) * 100]} onValueChange={v => updateField('strategy', 'structuralConvictionS2FLong', v[0] / 100)} min={0} max={60} step={5} className="flex-1" />
                            <span className="text-sm font-mono font-bold text-primary w-14 text-right">{Math.round((config.strategy?.structuralConvictionS2FLong ?? 0.35) * 100)}%</span>
                          </div>
                        </FieldGroup>
                        <FieldGroup label="Short S2F Block Threshold" description="Block shorts when Bear fractals 0% AND S2F below this %. Default 20%.">
                          <div className="flex items-center gap-4">
                            <Slider value={[(config.strategy?.structuralConvictionS2FShort ?? 0.20) * 100]} onValueChange={v => updateField('strategy', 'structuralConvictionS2FShort', v[0] / 100)} min={0} max={60} step={5} className="flex-1" />
                            <span className="text-sm font-mono font-bold text-primary w-14 text-right">{Math.round((config.strategy?.structuralConvictionS2FShort ?? 0.20) * 100)}%</span>
                          </div>
                        </FieldGroup>
                        <FieldGroup label="Long Opposite Block" description="Soft block: 0% bulls + bears above this %. Default 30%.">
                          <div className="flex items-center gap-4">
                            <Slider value={[(config.strategy?.structuralConvictionOppositeLong ?? 0.30) * 100]} onValueChange={v => updateField('strategy', 'structuralConvictionOppositeLong', v[0] / 100)} min={10} max={70} step={5} className="flex-1" />
                            <span className="text-sm font-mono font-bold text-primary w-14 text-right">{Math.round((config.strategy?.structuralConvictionOppositeLong ?? 0.30) * 100)}%</span>
                          </div>
                        </FieldGroup>
                        <FieldGroup label="Short Opposite Block" description="Soft block: 0% bears + bulls above this %. Default 45%.">
                          <div className="flex items-center gap-4">
                            <Slider value={[(config.strategy?.structuralConvictionOppositeShort ?? 0.45) * 100]} onValueChange={v => updateField('strategy', 'structuralConvictionOppositeShort', v[0] / 100)} min={10} max={70} step={5} className="flex-1" />
                            <span className="text-sm font-mono font-bold text-primary w-14 text-right">{Math.round((config.strategy?.structuralConvictionOppositeShort ?? 0.45) * 100)}%</span>
                          </div>
                        </FieldGroup>
                      </div>}
                    </div>
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Premium / Discount Filters</p>
                      <div className="grid grid-cols-2 gap-4">
                        <ToggleField label="Only Buy in Discount" description="Only enter longs when price is in discount zone" checked={config.strategy?.onlyBuyInDiscount ?? true} onChange={v => updateField('strategy', 'onlyBuyInDiscount', v)} />
                        <ToggleField label="Only Sell in Premium" description="Only enter shorts when price is in premium zone" checked={config.strategy?.onlySellInPremium ?? true} onChange={v => updateField('strategy', 'onlySellInPremium', v)} />
                      </div>
                    </div>
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Regime-Aware Scoring</p>
                      <ToggleField label="Enable Regime Scoring" description="Adjust confluence score based on market regime alignment. Bonus when setup matches regime (e.g. trend setup in trending market), penalty when mismatched" checked={config.strategy?.regimeScoringEnabled ?? true} onChange={v => updateField('strategy', 'regimeScoringEnabled', v)} />
                      {(config.strategy?.regimeScoringEnabled ?? true) && (
                        <FieldGroup label="Regime Strength" description="Scales the bonus/penalty multiplier. 0.25x = subtle adjustments, 1.0x = default, 2.0x = aggressive filtering">
                          <div className="flex items-center gap-4">
                            <Slider value={[config.strategy?.regimeScoringStrength ?? 1.0]} onValueChange={v => updateField('strategy', 'regimeScoringStrength', v[0])} min={0.25} max={2.0} step={0.25} className="flex-1" />
                            <span className="text-sm font-mono font-bold text-primary w-12 text-right">{(config.strategy?.regimeScoringStrength ?? 1.0).toFixed(2)}x</span>
                          </div>
                          <div className="mt-2 rounded-md bg-muted/50 border border-border p-3 text-[11px] text-muted-foreground space-y-1">
                            <div><span className="text-profit font-medium">Aligned:</span> Trend setup in trending market → +0.25 to +0.5 bonus</div>
                            <div><span className="text-loss font-medium">Mismatched:</span> Trend setup in choppy market → -0.75 to -1.5 penalty</div>
                            <div className="text-muted-foreground/70">Range setups get the inverse. All values scaled by the multiplier above.</div>
                          </div>
                        </FieldGroup>
                      )}
                    </div>
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Thesis Conviction Tracker</p>
                      <p className="text-[11px] text-muted-foreground -mt-2">Tracks how healthy each active thesis is over time. When evidence accumulates against a thesis, impulse-zone credit is revoked to prevent stale entries.</p>
                      <ToggleField label="Enable Thesis Conviction" description="Track evidence for/against each thesis across scan cycles. When disabled, impulse-zone credit is always granted if the zone qualifies." checked={config.strategy?.thesisConvictionEnabled ?? true} onChange={v => updateField('strategy', 'thesisConvictionEnabled', v)} />
                      {(config.strategy?.thesisConvictionEnabled ?? true) && (
                        <div className="space-y-4 pl-2 border-l-2 border-primary/20">
                          <FieldGroup label="Mode" description="Shadow = logs only (no trade impact). Active = revokes impulse credit when conviction drops below threshold.">
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant={((config.strategy?.thesisConvictionMode ?? 'shadow') === 'shadow') ? 'default' : 'outline'}
                                onClick={() => updateField('strategy', 'thesisConvictionMode', 'shadow')}
                                className="text-xs"
                              >Shadow (Log Only)</Button>
                              <Button
                                type="button"
                                size="sm"
                                variant={((config.strategy?.thesisConvictionMode ?? 'shadow') === 'active') ? 'default' : 'outline'}
                                onClick={() => updateField('strategy', 'thesisConvictionMode', 'active')}
                                className="text-xs"
                              >Active (Block Trades)</Button>
                            </div>
                          </FieldGroup>
                          <FieldGroup label="Decay per Cycle" description="Points lost each scan cycle when evidence opposes the thesis. Higher = faster revocation.">
                            <div className="flex items-center gap-3">
                              <Slider value={[config.strategy?.thesisConvictionDecayPerCycle ?? 8]} onValueChange={v => updateField('strategy', 'thesisConvictionDecayPerCycle', v[0])} min={2} max={20} step={1} className="flex-1" />
                              <span className="text-sm font-mono font-bold text-primary w-8 text-right">{config.strategy?.thesisConvictionDecayPerCycle ?? 8}</span>
                            </div>
                          </FieldGroup>
                          <FieldGroup label="Recovery per Cycle" description="Points gained each scan cycle when evidence supports the thesis. Lower = slower recovery after damage.">
                            <div className="flex items-center gap-3">
                              <Slider value={[config.strategy?.thesisConvictionRecoveryPerCycle ?? 5]} onValueChange={v => updateField('strategy', 'thesisConvictionRecoveryPerCycle', v[0])} min={1} max={15} step={1} className="flex-1" />
                              <span className="text-sm font-mono font-bold text-primary w-8 text-right">{config.strategy?.thesisConvictionRecoveryPerCycle ?? 5}</span>
                            </div>
                          </FieldGroup>
                          <FieldGroup label="Revoke Threshold" description="Conviction below this % → impulse-zone credit revoked. Trade must pass normal tier-1 threshold instead.">
                            <div className="flex items-center gap-3">
                              <Slider value={[config.strategy?.thesisConvictionRevokeThreshold ?? 50]} onValueChange={v => updateField('strategy', 'thesisConvictionRevokeThreshold', v[0])} min={20} max={80} step={5} className="flex-1" />
                              <span className="text-sm font-mono font-bold text-primary w-8 text-right">{config.strategy?.thesisConvictionRevokeThreshold ?? 50}%</span>
                            </div>
                          </FieldGroup>
                          <FieldGroup label="Kill Threshold" description="Conviction below this % → thesis killed entirely. No trade will be taken in this direction until evidence recovers.">
                            <div className="flex items-center gap-3">
                              <Slider value={[config.strategy?.thesisConvictionKillThreshold ?? 30]} onValueChange={v => updateField('strategy', 'thesisConvictionKillThreshold', v[0])} min={10} max={60} step={5} className="flex-1" />
                              <span className="text-sm font-mono font-bold text-primary w-8 text-right">{config.strategy?.thesisConvictionKillThreshold ?? 30}%</span>
                            </div>
                          </FieldGroup>
                          <div className="rounded-md bg-muted/50 border border-border p-3 text-[11px] text-muted-foreground space-y-1">
                            <div><span className="text-profit font-medium">80-100% conviction:</span> Impulse credit granted normally</div>
                            <div><span className="text-warn font-medium">60-79% conviction:</span> Credit reduced, score penalty -5%</div>
                            <div><span className="text-loss font-medium">Below revoke threshold:</span> Impulse credit revoked, score penalty -10%</div>
                            <div className="text-muted-foreground/70 pt-1">Evidence sources: Direction Verdict, 4H Regime, Opposing Factors, FOTSI, Game Plan Bias</div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Score Normalization</p>
                      <ToggleField label="Percentage Scoring" description="Score expressed as a percentage (0-100%) of the maximum possible from your enabled factors. 55% always means 55% of what's possible, regardless of which factors are enabled." checked={config.strategy?.normalizedScoring ?? true} onChange={v => updateField('strategy', 'normalizedScoring', v)} />
                      {(config.strategy?.normalizedScoring ?? true) ? (
                        <div className="rounded-md bg-badge-profit border border-emerald-500/20 p-3 text-[11px] text-muted-foreground space-y-1">
                          <div><span className="text-profit font-medium">Active:</span> Score = (raw points / max possible) × 100%</div>
                          <div><span className="text-warn font-medium">Example:</span> Raw 10.5 / max 19.0 = 55.3% confluence</div>
                          <div className="text-muted-foreground/70">Disabling factors doesn't change the effective threshold. The percentage auto-adjusts so your confluence threshold always means the same quality level regardless of which factors are enabled.</div>
                        </div>
                      ) : (
                        <div className="rounded-md bg-badge-warn border border-amber-500/20 p-3 text-[11px] text-muted-foreground space-y-1">
                          <div><span className="text-warn font-medium">Legacy mode:</span> Score clamped to 0-10 scale</div>
                          <div className="text-muted-foreground/70">Warning: Disabling factors silently raises the effective threshold. Consider switching to percentage scoring.</div>
                        </div>
                      )}
                    </div>
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Advanced Tuning</p>
                      <p className="text-[11px] text-muted-foreground -mt-2">Fine-tune detection sensitivity. Defaults are sensible — only change if you know what you're doing.</p>
                      <div className="grid grid-cols-2 gap-4">
                        <FieldGroup label="OB Lookback Candles" description="How far back to scan for valid Order Blocks. Higher = more historical OBs considered, but older zones may be stale.">
                          <Input type="number" value={config.strategy?.obLookbackCandles ?? 50} onChange={e => updateField('strategy', 'obLookbackCandles', parseInt(e.target.value) || 0)} min={10} max={500} step={10} className="h-9 text-sm" />
                        </FieldGroup>
                        <FieldGroup label="Structure Lookback" description="Number of recent candles passed to BOS/CHoCH analysis. Higher = more context, but slower to react to regime shifts.">
                          <Input type="number" value={config.strategy?.structureLookback ?? 50} onChange={e => updateField('strategy', 'structureLookback', parseInt(e.target.value) || 0)} min={20} max={500} step={10} className="h-9 text-sm" />
                        </FieldGroup>
                        <FieldGroup label="FVG Min Size (pips)" description="Skip Fair Value Gaps smaller than this. 0 = no filter. Try 5-20 to filter out tiny noise gaps.">
                          <Input type="number" value={config.strategy?.fvgMinSizePips ?? 0} onChange={e => updateField('strategy', 'fvgMinSizePips', parseFloat(e.target.value) || 0)} min={0} step={1} className="h-9 text-sm" />
                        </FieldGroup>
                        <FieldGroup label="Liquidity Pool Min Touches" description="Minimum equal highs/lows required to qualify as a liquidity pool. Higher = stricter, fewer but higher-quality pools.">
                          <Input type="number" value={config.strategy?.liquidityPoolMinTouches ?? 2} onChange={e => updateField('strategy', 'liquidityPoolMinTouches', parseInt(e.target.value) || 0)} min={2} max={10} step={1} className="h-9 text-sm" />
                        </FieldGroup>
                      </div>
                      <ToggleField label="FVG Only Unfilled" description="Score only Fair Value Gaps that haven't been mitigated/filled yet. Recommended on." checked={config.strategy?.fvgOnlyUnfilled ?? true} onChange={v => updateField('strategy', 'fvgOnlyUnfilled', v)} />
                    </div>
                  </div>
                )}

                {effectiveActiveTab === "risk" && (
                  <div className="space-y-5">
                    <SectionHeader title="Risk Management" description="Control position sizing and drawdown limits" />
                    <FieldGroup label="Starting Balance ($)" description="Configured paper-trading bankroll. Used as the base for all % calculations below.">
                      <Input
                        type="number"
                        value={config.account?.startingBalance ?? 10000}
                        onChange={e => updateField('account', 'startingBalance', parseFloat(e.target.value) || 0)}
                        step={100}
                        min={0}
                        className="h-9 text-sm"
                      />
                    </FieldGroup>

                    {/* ── Position Sizing Method ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Position Sizing</p>
                      <FieldGroup label="Sizing Method" description="How lot size is calculated for each trade">
                        <Select value={config.risk?.positionSizingMethod ?? "percent_risk"} onValueChange={v => updateField('risk', 'positionSizingMethod', v)}>
                          <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="percent_risk">Risk-Based (%)</SelectItem>
                            <SelectItem value="fixed_lot">Fixed Lot Size</SelectItem>
                            <SelectItem value="volatility_adjusted">Volatility-Adjusted (ATR)</SelectItem>
                          </SelectContent>
                        </Select>
                      </FieldGroup>
                      {(config.risk?.positionSizingMethod === "percent_risk" || !config.risk?.positionSizingMethod) && (
                        <p className="text-[10px] text-muted-foreground italic">Lot size = (Balance × Risk%) ÷ SL distance. Adjusts automatically with account growth.</p>
                      )}
                      {config.risk?.positionSizingMethod === "fixed_lot" && (
                        <FieldGroup label="Fixed Lot Size" description="Use this exact lot size for every trade regardless of SL distance">
                          <Input type="number" value={config.risk?.fixedLotSize ?? 0.1} onChange={e => updateField('risk', 'fixedLotSize', parseFloat(e.target.value) || 0.01)} step={0.01} min={0.01} max={100} className="h-9 text-sm" />
                        </FieldGroup>
                      )}
                      {config.risk?.positionSizingMethod === "volatility_adjusted" && (
                        <>
                          <p className="text-[10px] text-muted-foreground italic">Lot size scales inversely with ATR — smaller positions in volatile markets, larger in calm markets. Uses Risk% as the base.</p>
                          <FieldGroup label={`ATR Multiplier: ${config.risk?.atrVolatilityMultiplier ?? 1.5}×`} description="ATR is multiplied by this factor to set the volatility-based risk distance. Lower = larger lots (more aggressive), higher = smaller lots (more conservative)">
                            <Slider
                              value={[config.risk?.atrVolatilityMultiplier ?? 1.5]}
                              onValueChange={([v]) => updateField('risk', 'atrVolatilityMultiplier', Math.round(v * 10) / 10)}
                              min={0.5} max={3.0} step={0.1}
                              className="w-full"
                            />
                            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                              <span>0.5× (aggressive)</span>
                              <span>1.5× (default)</span>
                              <span>3.0× (conservative)</span>
                            </div>
                          </FieldGroup>
                        </>
                      )}
                    </div>

                    {/* ── Risk Limits ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Risk Limits</p>
                      {(config.risk?.positionSizingMethod !== "fixed_lot") && (
                        <FieldGroup label="Risk per Trade (%)" description="Percentage of balance risked per trade">
                          <Input type="number" value={config.risk?.riskPerTrade ?? 1} onChange={e => updateField('risk', 'riskPerTrade', parseFloat(e.target.value) || 0)} step={0.1} className="h-9 text-sm" />
                          <p className="text-[11px] text-muted-foreground mt-1 font-mono">
                            ≈ ${(((config.risk?.riskPerTrade ?? 1) / 100) * (config.account?.startingBalance ?? 10000)).toLocaleString(undefined, { maximumFractionDigits: 2 })} per trade
                          </p>
                        </FieldGroup>
                      )}

                      {/* ── Max Daily Drawdown: dual %/$ input ── */}
                      <FieldGroup label="Max Daily Drawdown" description="Percentage of account balance — halts new trades for the day if intraday loss exceeds this. (Protection tab has a separate dollar-based daily loss limit.)">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 relative">
                            <Input
                              type="number"
                              value={config.risk?._dailyDDMode === "dollar"
                                ? (config.risk?._dailyDDDollar ?? ((config.risk?.maxDailyDrawdown ?? 3) / 100 * (config.account?.startingBalance ?? 10000)))
                                : (config.risk?.maxDailyDrawdown ?? 3)
                              }
                              onChange={e => {
                                const val = parseFloat(e.target.value) || 0;
                                const balance = config.account?.startingBalance ?? 10000;
                                if (config.risk?._dailyDDMode === "dollar") {
                                  const pct = balance > 0 ? (val / balance) * 100 : 0;
                                  updateField('risk', 'maxDailyDrawdown', Math.round(pct * 100) / 100);
                                  updateField('risk', '_dailyDDDollar', val);
                                } else {
                                  updateField('risk', 'maxDailyDrawdown', val);
                                  updateField('risk', '_dailyDDDollar', (val / 100) * balance);
                                }
                              }}
                              step={config.risk?._dailyDDMode === "dollar" ? 10 : 0.5}
                              min={0}
                              className="h-9 text-sm pr-10"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
                              {config.risk?._dailyDDMode === "dollar" ? "$" : "%"}
                            </span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 px-3 text-xs font-mono min-w-[44px]"
                            onClick={() => {
                              const balance = config.account?.startingBalance ?? 10000;
                              const currentPct = config.risk?.maxDailyDrawdown ?? 3;
                              if (config.risk?._dailyDDMode === "dollar") {
                                updateField('risk', '_dailyDDMode', 'percent');
                              } else {
                                updateField('risk', '_dailyDDMode', 'dollar');
                                updateField('risk', '_dailyDDDollar', (currentPct / 100) * balance);
                              }
                            }}
                          >
                            {config.risk?._dailyDDMode === "dollar" ? "%" : "$"}
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1 font-mono">
                          {config.risk?._dailyDDMode === "dollar"
                            ? `= ${(config.risk?.maxDailyDrawdown ?? 3).toFixed(1)}% of $${(config.account?.startingBalance ?? 10000).toLocaleString()}`
                            : `≈ $${(((config.risk?.maxDailyDrawdown ?? 3) / 100) * (config.account?.startingBalance ?? 10000)).toLocaleString(undefined, { maximumFractionDigits: 2 })} of $${(config.account?.startingBalance ?? 10000).toLocaleString()}`
                          }
                        </p>
                      </FieldGroup>

                      <div className="grid grid-cols-2 gap-4">
                        <FieldGroup label="Max Concurrent Trades" description="Maximum open positions at once">
                          <Input type="number" value={config.risk?.maxConcurrentTrades ?? 5} onChange={e => updateField('risk', 'maxConcurrentTrades', parseFloat(e.target.value) || 0)} min={1} max={20} className="h-9 text-sm" />
                        </FieldGroup>
                        <FieldGroup label="Min R:R Ratio" description="Gate: rejects trades below this R:R. (Exit tab's R:R Ratio sets the TP target; this is the minimum to pass the gate.)">
                          <Input type="number" value={config.risk?.minRR ?? 1.5} onChange={e => updateField('risk', 'minRR', parseFloat(e.target.value) || 0)} step={0.5} className="h-9 text-sm" />
                        </FieldGroup>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <FieldGroup label="Portfolio Heat (%)" description="Max total risk exposure across all open positions">
                          <Input type="number" value={config.risk?.maxPortfolioHeat ?? 10} onChange={e => updateField('risk', 'maxPortfolioHeat', parseFloat(e.target.value) || 0)} step={1} min={1} max={100} className="h-9 text-sm" />
                        </FieldGroup>
                        <FieldGroup label="Max Per Symbol" description="Max open positions allowed on the same instrument">
                          <Input type="number" value={config.risk?.maxPositionsPerSymbol ?? 2} onChange={e => updateField('risk', 'maxPositionsPerSymbol', parseFloat(e.target.value) || 0)} min={1} max={10} className="h-9 text-sm" />
                        </FieldGroup>
                      </div>
                      <ToggleField label="Allow Same-Direction Stacking" description="When enabled, the bot can open multiple positions in the same direction on the same pair (e.g. two longs on GBP/USD). Still limited by Max Per Symbol." checked={config.risk?.allowSameDirectionStacking ?? false} onChange={v => updateField('risk', 'allowSameDirectionStacking', v)} />

                      {/* ── Max Total Drawdown: dual %/$ input ── */}
                      <FieldGroup label="Max Total Drawdown" description="Kill switch — stops all trading if drawdown from peak balance exceeds this. Combined with Protection tab's Circuit Breaker: the lower of the two wins.">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 relative">
                            <Input
                              type="number"
                              value={config.risk?._totalDDMode === "dollar"
                                ? (config.risk?._totalDDDollar ?? ((config.risk?.maxDrawdown ?? 15) / 100 * (config.account?.startingBalance ?? 10000)))
                                : (config.risk?.maxDrawdown ?? 15)
                              }
                              onChange={e => {
                                const val = parseFloat(e.target.value) || 0;
                                const balance = config.account?.startingBalance ?? 10000;
                                if (config.risk?._totalDDMode === "dollar") {
                                  const pct = balance > 0 ? (val / balance) * 100 : 0;
                                  updateField('risk', 'maxDrawdown', Math.round(pct * 100) / 100);
                                  updateField('risk', '_totalDDDollar', val);
                                } else {
                                  updateField('risk', 'maxDrawdown', val);
                                  updateField('risk', '_totalDDDollar', (val / 100) * balance);
                                }
                              }}
                              step={config.risk?._totalDDMode === "dollar" ? 50 : 1}
                              min={0}
                              className="h-9 text-sm pr-10"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
                              {config.risk?._totalDDMode === "dollar" ? "$" : "%"}
                            </span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 px-3 text-xs font-mono min-w-[44px]"
                            onClick={() => {
                              const balance = config.account?.startingBalance ?? 10000;
                              const currentPct = config.risk?.maxDrawdown ?? 15;
                              if (config.risk?._totalDDMode === "dollar") {
                                updateField('risk', '_totalDDMode', 'percent');
                              } else {
                                updateField('risk', '_totalDDMode', 'dollar');
                                updateField('risk', '_totalDDDollar', (currentPct / 100) * balance);
                              }
                            }}
                          >
                            {config.risk?._totalDDMode === "dollar" ? "%" : "$"}
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1 font-mono">
                          {config.risk?._totalDDMode === "dollar"
                            ? `= ${(config.risk?.maxDrawdown ?? 15).toFixed(1)}% of $${(config.account?.startingBalance ?? 10000).toLocaleString()}`
                            : `≈ $${(((config.risk?.maxDrawdown ?? 15) / 100) * (config.account?.startingBalance ?? 10000)).toLocaleString(undefined, { maximumFractionDigits: 2 })} of $${(config.account?.startingBalance ?? 10000).toLocaleString()}`
                          }
                        </p>
                      </FieldGroup>

                      {/* ── Conflict Counter Thresholds ── */}
                      <div className="border-t border-border pt-4 space-y-3">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Conflict Counter</p>
                        <p className="text-[10px] text-muted-foreground italic">When multiple factors actively oppose the trade direction, the bot raises the bar or blocks entirely.</p>
                        <FieldGroup label="Threshold Raise At" description="When this many factors oppose the trade, the minimum confluence threshold is raised by 10 percentage points.">
                          <div className="flex items-center gap-4">
                            <Slider value={[config.risk?.conflictThresholdRaise ?? 4]} onValueChange={v => updateField('risk', 'conflictThresholdRaise', v[0])} min={2} max={8} step={1} className="flex-1" />
                            <span className="text-sm font-mono font-bold w-10 text-right">{config.risk?.conflictThresholdRaise ?? 4}</span>
                          </div>
                        </FieldGroup>
                        <FieldGroup label="Hard Block At" description="When this many factors oppose the trade, the trade is blocked entirely regardless of score.">
                          <div className="flex items-center gap-4">
                            <Slider value={[config.risk?.conflictBlockAt ?? 6]} onValueChange={v => updateField('risk', 'conflictBlockAt', v[0])} min={3} max={12} step={1} className="flex-1" />
                            <span className="text-sm font-mono font-bold w-10 text-right">{config.risk?.conflictBlockAt ?? 6}</span>
                          </div>
                        </FieldGroup>
                      </div>
                    </div>
                  </div>
                )}

                {effectiveActiveTab === "entry_exit" && (
                  <div className="space-y-5">
                    <SectionHeader title="Entry & Exit Rules" description="Configure trade entry timing and exit strategies" />
                    <div className="space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Entry</p>
                      <FieldGroup label="Cooldown Between Trades (minutes)" description="Minimum wait time between consecutive trades">
                        <Input type="number" value={config.entry?.cooldownMinutes ?? 30} onChange={e => updateField('entry', 'cooldownMinutes', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="SL Buffer (pips)" description="Extra pips added beyond structure/OB for stop loss placement">
                        <Input type="number" value={config.entry?.slBufferPips ?? 2} onChange={e => updateField('entry', 'slBufferPips', parseFloat(e.target.value) || 0)} step={0.5} min={0} max={20} className="h-9 text-sm" />
                      </FieldGroup>
                      <ToggleField label="Close on Reverse Signal" description="Auto-close position when an opposite signal appears" checked={config.entry?.closeOnReverse ?? false} onChange={v => updateField('entry', 'closeOnReverse', v)} />
                    </div>

                    {/* ── Zone Entry Setup ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Zone Entry</p>
                      <ToggleField label="Pending Zone Orders" description="When price is NOT at the zone yet, place a pending order and watch for price to arrive. Once price reaches the zone, hunts for LTF confirmation (CHoCH/BOS) before filling at live price." checked={config.entry?.limitOrderEnabled ?? false} onChange={v => updateField('entry', 'limitOrderEnabled', v)} />
                      {config.entry?.limitOrderEnabled && (
                        <div className="pl-4 border-l-2 border-primary/20 space-y-3">
                          <FieldGroup label="Zone Watch Expiry (minutes)" description="How long the bot watches for price to reach the zone before cancelling the setup">
                            <div className="flex items-center gap-4">
                              <Slider value={[config.entry?.limitOrderExpiryMinutes ?? 60]} onValueChange={v => updateField('entry', 'limitOrderExpiryMinutes', v[0])} min={15} max={480} step={15} className="flex-1" />
                              <span className="text-sm font-mono font-bold w-16 text-right">{config.entry?.limitOrderExpiryMinutes ?? 60}m</span>
                            </div>
                          </FieldGroup>
                          <p className="text-[9px] text-muted-foreground italic">When enabled, the bot watches for price to reach the zone. Once price is in the zone, it hunts for LTF confirmation (CHoCH, BOS, or sweep+CHoCH) before entering at live price. If impulse zone gate mode is "hard", pending zone orders are auto-enabled.</p>
                        </div>
                      )}
                    </div>

                    {/* ── Market Fill at Zone ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Market Fill at Zone</p>
                      <ToggleField label="Market Fill at Zone" description="When price IS at the impulse zone (within ATR proximity) and all gates pass, fill at market immediately without waiting for LTF confirmation. Turn OFF to always require CHoCH/BOS confirmation even when price is at zone." checked={config.entry?.marketFillAtZone ?? true} onChange={v => updateField('entry', 'marketFillAtZone', v)} />
                      {(config.entry?.marketFillAtZone ?? true) && (
                        <div className="pl-4 border-l-2 border-primary/20 space-y-3">
                          <FieldGroup label="Zone Proximity (ATR×)" description="How close price must be to the zone edge for a market fill. Lower = stricter (must be closer). Range: 0.1–1.0">
                            <div className="flex items-center gap-4">
                              <Slider value={[(config.entry?.marketFillStrictATRMult ?? 0.3) * 100]} onValueChange={v => updateField('entry', 'marketFillStrictATRMult', v[0] / 100)} min={10} max={100} step={5} className="flex-1" />
                              <span className="text-sm font-mono font-bold w-16 text-right">{(config.entry?.marketFillStrictATRMult ?? 0.3).toFixed(2)}×</span>
                            </div>
                          </FieldGroup>
                          <p className="text-[9px] text-muted-foreground italic">Default: 0.30× ATR. At 0.10×, price must be almost touching the zone. At 1.00×, price can be up to 1×ATR away. Requires impulse zone gate mode = "hard" to be active.</p>
                        </div>
                      )}
                    </div>

                    {/* ── Stop Loss Method ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Stop Loss Method</p>
                      <FieldGroup label="SL Method" description="How the stop loss price is calculated">
                        <Select value={config.exit?.stopLossMethod ?? "structure"} onValueChange={v => updateField('exit', 'stopLossMethod', v)}>
                          <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="fixed_pips">Fixed Pips</SelectItem>
                            <SelectItem value="atr_based">ATR Based</SelectItem>
                            <SelectItem value="structure">Structure (Swing)</SelectItem>
                            <SelectItem value="below_ob">Below/Above Order Block</SelectItem>
                          </SelectContent>
                        </Select>
                      </FieldGroup>
                      {(config.exit?.stopLossMethod === "fixed_pips" || config.exit?.stopLossMethod === undefined) && config.exit?.stopLossMethod === "fixed_pips" && (
                        <FieldGroup label="Fixed SL Pips" description="Distance in pips from entry">
                          <Input type="number" value={config.exit?.fixedSLPips ?? 25} onChange={e => updateField('exit', 'fixedSLPips', parseFloat(e.target.value) || 0)} step={1} min={1} className="h-9 text-sm" />
                        </FieldGroup>
                      )}
                      {config.exit?.stopLossMethod === "atr_based" && (
                        <div className="grid grid-cols-2 gap-4">
                          <FieldGroup label="ATR Multiple" description="Multiplier applied to ATR value">
                            <Input type="number" value={config.exit?.slATRMultiple ?? 1.5} onChange={e => updateField('exit', 'slATRMultiple', parseFloat(e.target.value) || 0)} step={0.1} min={0.5} max={5} className="h-9 text-sm" />
                          </FieldGroup>
                          <FieldGroup label="ATR Period" description="Number of candles for ATR calculation">
                            <Input type="number" value={config.exit?.slATRPeriod ?? 14} onChange={e => updateField('exit', 'slATRPeriod', parseInt(e.target.value) || 14)} min={5} max={50} className="h-9 text-sm" />
                          </FieldGroup>
                        </div>
                      )}
                      {(config.exit?.stopLossMethod === "structure" || (!config.exit?.stopLossMethod)) && (
                        <p className="text-[10px] text-muted-foreground italic">SL placed below nearest swing low (longs) or above nearest swing high (shorts) + buffer pips.</p>
                      )}
                      {config.exit?.stopLossMethod === "below_ob" && (
                        <p className="text-[10px] text-muted-foreground italic">SL placed below nearest unmitigated bullish OB (longs) or above bearish OB (shorts) + buffer pips.</p>
                      )}
                    </div>

                    {/* ── Take Profit Method ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Take Profit Method</p>
                      <FieldGroup label="TP Method" description="How the take profit price is calculated">
                        <Select value={config.exit?.takeProfitMethod ?? "rr_ratio"} onValueChange={v => updateField('exit', 'takeProfitMethod', v)}>
                          <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="fixed_pips">Fixed Pips</SelectItem>
                            <SelectItem value="rr_ratio">R:R Ratio</SelectItem>
                            <SelectItem value="next_level">Next Structure Level</SelectItem>
                            <SelectItem value="atr_multiple">ATR Multiple</SelectItem>
                          </SelectContent>
                        </Select>
                      </FieldGroup>
                      {config.exit?.takeProfitMethod === "fixed_pips" && (
                        <FieldGroup label="Fixed TP Pips" description="Distance in pips from entry">
                          <Input type="number" value={config.exit?.fixedTPPips ?? 50} onChange={e => updateField('exit', 'fixedTPPips', parseFloat(e.target.value) || 0)} step={1} min={1} className="h-9 text-sm" />
                        </FieldGroup>
                      )}
                      {(config.exit?.takeProfitMethod === "rr_ratio" || !config.exit?.takeProfitMethod) && (
                        <FieldGroup label="R:R Ratio (TP Target)" description="Sets the Take Profit distance: TP = SL × this ratio. (Risk tab's Min R:R is the gate that rejects trades below a threshold.)">
                          <Input type="number" value={config.exit?.tpRRRatio ?? 2.0} onChange={e => updateField('exit', 'tpRRRatio', parseFloat(e.target.value) || 0)} step={0.5} min={1} max={10} className="h-9 text-sm" />
                        </FieldGroup>
                      )}
                      {config.exit?.takeProfitMethod === "next_level" && (
                        <p className="text-[10px] text-muted-foreground italic">TP targets nearest PDH/PDL/PWH/PWL or liquidity pool. Falls back to Fixed Pips if none found.</p>
                      )}
                      {config.exit?.takeProfitMethod === "atr_multiple" && (
                        <FieldGroup label="TP ATR Multiple" description="TP = ATR × this multiplier">
                          <Input type="number" value={config.exit?.tpATRMultiple ?? 2.0} onChange={e => updateField('exit', 'tpATRMultiple', parseFloat(e.target.value) || 0)} step={0.1} min={1} max={10} className="h-9 text-sm" />
                        </FieldGroup>
                      )}
                    </div>

                    {/* ── Trade Management ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Trade Management</p>
                        {(() => {
                          const activeStyle = (config.tradingStyle?.mode || "day_trader") as TradingStyleMode;
                          const styleMeta = STYLE_META[activeStyle];
                          return (
                            <Badge variant="secondary" className="text-[9px] px-2 py-0.5 font-normal">
                              {styleMeta.icon} {styleMeta.label} defaults
                            </Badge>
                          );
                        })()}
                      </div>

                      {/* Style defaults summary card */}
                      {(() => {
                        const activeStyle = (config.tradingStyle?.mode || "day_trader") as TradingStyleMode;
                        const sp = STYLE_PARAMS[activeStyle];
                        return (
                          <div className="bg-muted/30 border border-border/60 p-3 space-y-2">
                            <p className="text-[10px] text-muted-foreground">Your <strong>{STYLE_META[activeStyle].label}</strong> style sets these management defaults. Override any value below to customize for your broker.</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                              <span className="text-muted-foreground">Trailing:</span>
                              <span className={sp.trailingStopEnabled ? "text-success font-medium" : "text-muted-foreground"}>{sp.trailingStopEnabled ? `ON — ${sp.trailingStopPips}p @ ${sp.trailingStopActivation.replace("after_", "")}` : "OFF"}</span>
                              <span className="text-muted-foreground">Break-Even:</span>
                              <span className={sp.breakEvenEnabled ? "text-success font-medium" : "text-muted-foreground"}>{sp.breakEvenEnabled ? `ON — after ${sp.breakEvenPips}p profit` : "OFF"}</span>
                              <span className="text-muted-foreground">Partial TP:</span>
                              <span className={sp.partialTPEnabled ? "text-success font-medium" : "text-muted-foreground"}>{sp.partialTPEnabled ? `ON — ${sp.partialTPPercent}% @ ${sp.partialTPLevel}R` : "OFF"}</span>
                              <span className="text-muted-foreground">Max Hold:</span>
                              <span className="font-medium">{sp.maxHoldHours > 0 ? `${sp.maxHoldHours}h` : "No limit"}</span>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Important: activation conditions note */}
                      <div className="bg-badge-info border border-blue-500/20 p-3">
                        <p className="text-[10px] text-info-c font-medium">Activation Safety</p>
                        <p className="text-[10px] text-muted-foreground mt-1">Trailing stops and break-even only activate when the trade is <strong>in profit</strong>. They will never fire on a losing position. Structure invalidation may tighten SL on underwater trades to reduce loss.</p>
                      </div>

                      {/* ── Trailing Stop ── */}
                      <div className="border border-border/60 p-3 space-y-3">
                        <ToggleField label="Trailing Stop" description="Ratchet SL forward as price moves in your favor — locks in profit automatically" checked={config.exit?.trailingStop ?? config.exit?.trailingStopEnabled ?? false} onChange={v => { updateField('exit', 'trailingStop', v); updateField('exit', 'trailingStopEnabled', v); }} />
                        {(config.exit?.trailingStop || config.exit?.trailingStopEnabled) && (
                          <div className="pl-4 border-l-2 border-primary/20 space-y-3">
                            <FieldGroup label="Trailing Distance (pips)" description="How far behind current price the trailing SL follows">
                              <div className="flex items-center gap-4">
                                <Slider value={[config.exit?.trailingStopPips ?? 15]} onValueChange={v => updateField('exit', 'trailingStopPips', v[0])} min={1} max={100} step={1} className="flex-1" />
                                <span className="text-sm font-mono font-bold w-12 text-right">{config.exit?.trailingStopPips ?? 15}</span>
                              </div>
                            </FieldGroup>
                            <FieldGroup label="Activation Threshold" description="When to start trailing — only activates when trade reaches this R-multiple in profit">
                              <Select value={config.exit?.trailingStopActivation ?? 'after_1r'} onValueChange={v => updateField('exit', 'trailingStopActivation', v)}>
                                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="immediate">Immediately (any profit)</SelectItem>
                                  <SelectItem value="after_0.5r">After 0.5R profit</SelectItem>
                                  <SelectItem value="after_1r">After 1R profit</SelectItem>
                                  <SelectItem value="after_1.5r">After 1.5R profit</SelectItem>
                                  <SelectItem value="after_2r">After 2R profit</SelectItem>
                                </SelectContent>
                              </Select>
                            </FieldGroup>
                            <p className="text-[9px] text-muted-foreground italic">Once activated, the SL ratchets forward each scan cycle as price moves further in profit. It never moves backward.</p>
                          </div>
                        )}
                      </div>

                      {/* ── Break Even ── */}
                      <div className="border border-border/60 p-3 space-y-3">
                        <ToggleField label="Break Even" description="Move SL to entry price once trade reaches a profit threshold" checked={config.exit?.breakEven ?? config.exit?.breakEvenEnabled ?? false} onChange={v => { updateField('exit', 'breakEven', v); updateField('exit', 'breakEvenEnabled', v); }} />
                        {(config.exit?.breakEven || config.exit?.breakEvenEnabled) && (
                          <div className="pl-4 border-l-2 border-primary/20 space-y-3">
                            <FieldGroup label="Break-Even Trigger (pips)" description="Move SL to entry after this many pips of profit">
                              <div className="flex items-center gap-4">
                                <Slider value={[config.exit?.breakEvenTriggerPips ?? 20]} onValueChange={v => updateField('exit', 'breakEvenTriggerPips', v[0])} min={1} max={100} step={1} className="flex-1" />
                                <span className="text-sm font-mono font-bold w-12 text-right">{config.exit?.breakEvenTriggerPips ?? 20}</span>
                              </div>
                            </FieldGroup>
                            <FieldGroup label="Break-Even Offset (pips)" description="How far above entry (long) / below entry (short) to park the SL. Set ≥ spread + commission so a BE stop nets ~flat, not a small loss.">
                              <div className="flex items-center gap-4">
                                <Slider value={[config.exit?.breakEvenOffsetPips ?? 3]} onValueChange={v => updateField('exit', 'breakEvenOffsetPips', v[0])} min={0} max={20} step={1} className="flex-1" />
                                <span className="text-sm font-mono font-bold w-12 text-right">{config.exit?.breakEvenOffsetPips ?? 3}</span>
                              </div>
                            </FieldGroup>
                            <p className="text-[9px] text-muted-foreground italic">Only fires once per position. After activation, SL sits at entry ± offset pips. Default 3 covers typical spread + commission so a BE close is roughly breakeven, not a 1-pip loss.</p>
                          </div>
                        )}
                      </div>

                      {/* ── Partial Take Profit ── */}
                      <div className="border border-border/60 p-3 space-y-3">
                        <ToggleField label="Partial Take Profit" description="Close a portion of the position at an R-multiple target, let the rest run" checked={config.exit?.partialTP ?? config.exit?.partialTPEnabled ?? false} onChange={v => { updateField('exit', 'partialTP', v); updateField('exit', 'partialTPEnabled', v); }} />
                        {(config.exit?.partialTP || config.exit?.partialTPEnabled) && (
                          <div className="pl-4 border-l-2 border-primary/20 space-y-3">
                            <FieldGroup label="Close Percentage" description="Portion of position to close at partial TP">
                              <div className="flex items-center gap-4">
                                <Slider value={[config.exit?.partialTPPercent ?? 50]} onValueChange={v => updateField('exit', 'partialTPPercent', v[0])} min={10} max={90} step={5} className="flex-1" />
                                <span className="text-sm font-mono font-bold w-12 text-right">{config.exit?.partialTPPercent ?? 50}%</span>
                              </div>
                            </FieldGroup>
                            <FieldGroup label="Trigger Level (R-multiple)" description="Close partial at this R-multiple (e.g., 1.0 = 1R profit)">
                              <div className="flex items-center gap-4">
                                <Slider value={[config.exit?.partialTPLevel ?? 1.0]} onValueChange={v => updateField('exit', 'partialTPLevel', v[0])} min={0.3} max={5} step={0.1} className="flex-1" />
                                <span className="text-sm font-mono font-bold w-12 text-right">{(config.exit?.partialTPLevel ?? 1.0).toFixed(1)}R</span>
                              </div>
                            </FieldGroup>
                            <p className="text-[9px] text-muted-foreground italic">Fires once per position. The remaining portion continues to the full TP target.</p>
                          </div>
                        )}
                      </div>

                      {/* ── Time-Based Exit ── */}
                      <div className="border border-border/60 p-3 space-y-3">
                        <ToggleField label="Time-Based Exit" description="Auto-tighten SL or close after a maximum hold duration" checked={(config.exit?.maxHoldEnabled ?? config.exit?.timeBasedExitEnabled ?? (config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 0) > 0)} onChange={v => { updateField('exit', 'maxHoldEnabled', v); updateField('exit', 'timeBasedExitEnabled', v); if (!v) { updateField('exit', 'timeExitHours', 0); updateField('exit', 'maxHoldHours', 0); } }} />
                        {(config.exit?.maxHoldEnabled || config.exit?.timeBasedExitEnabled || (config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 0) > 0) && (
                          <div className="pl-4 border-l-2 border-primary/20 space-y-3">
                            <FieldGroup label="Max Hold Time (hours)" description="After this duration, SL moves to breakeven if in profit, or position is flagged for review">
                              <div className="flex items-center gap-4">
                                <Slider value={[config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 24]} onValueChange={v => { updateField('exit', 'timeExitHours', v[0]); updateField('exit', 'maxHoldHours', v[0]); }} min={1} max={168} step={1} className="flex-1" />
                                <span className="text-sm font-mono font-bold w-16 text-right">{config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 24}h</span>
                              </div>
                            </FieldGroup>
                          </div>
                        )}
                      </div>

                      {/* ── Structure Invalidation ── */}
                      <div className="border border-border/60 p-3 space-y-3">
                        <ToggleField label="Structure Invalidation" description="Tighten SL by 50% when market structure breaks against your trade (CHoCH detected). Protects against holding through reversals." checked={config.exit?.structureInvalidationEnabled ?? false} onChange={v => updateField('exit', 'structureInvalidationEnabled', v)} />
                      </div>
                    </div>
                  </div>
                )}

                {effectiveActiveTab === "instruments" && (
                  <div className="space-y-5">
                    <SectionHeader title="Instruments" description="Select which instruments to scan" />
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground">{(config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol)).length} / {INSTRUMENTS.length} enabled</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" className="text-[10px] h-6" onClick={() => updateField('instruments', 'enabled', INSTRUMENTS.map(i => i.symbol))}>All</Button>
                        <Button variant="ghost" size="sm" className="text-[10px] h-6" onClick={() => updateField('instruments', 'enabled', [])}>None</Button>
                      </div>
                    </div>
                    {INSTRUMENT_TYPES.map(type => {
                      const typeInstruments = INSTRUMENTS.filter(i => i.type === type);
                      const enabledInType = typeInstruments.filter(i => (config.instruments?.enabled || INSTRUMENTS.map(x => x.symbol)).includes(i.symbol)).length;
                      return (
                        <div key={type} className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{INSTRUMENT_TYPE_LABELS[type]} <span className="font-normal">({enabledInType}/{typeInstruments.length})</span></p>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" className="text-[9px] h-5 px-1.5" onClick={() => {
                                const current = config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol);
                                const typeSymbols = typeInstruments.map(i => i.symbol);
                                updateField('instruments', 'enabled', [...new Set([...current, ...typeSymbols])]);
                              }}>All</Button>
                              <Button variant="ghost" size="sm" className="text-[9px] h-5 px-1.5" onClick={() => {
                                const current = config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol);
                                const typeSymbols = typeInstruments.map(i => i.symbol);
                                updateField('instruments', 'enabled', current.filter((s: string) => !typeSymbols.includes(s)));
                              }}>None</Button>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            {typeInstruments.map(inst => {
                              const enabled = config.instruments?.enabled?.includes(inst.symbol) ?? true;
                              return (
                                <button
                                  key={inst.symbol}
                                  onClick={() => {
                                    const current = config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol);
                                    updateField('instruments', 'enabled', enabled ? current.filter((s: string) => s !== inst.symbol) : [...current, inst.symbol]);
                                  }}
                                  className={`flex items-center gap-2 px-3 py-2 border text-xs transition-colors ${enabled ? "border-primary/40 bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:border-border/80"}`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`} />
                                  {inst.symbol}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {/* ── Spread Filter ── */}
                    <div className="border-t border-border pt-4 mt-4">
                      <SectionHeader title="Spread Filter" description="Skip broker execution when the live bid/ask spread is too wide. Each instrument has its own default max spread." />
                      <ToggleField label="Enable Spread Filter" description="Block live trades when spread exceeds the maximum" checked={config.instruments?.spreadFilterEnabled ?? true} onChange={v => updateField('instruments', 'spreadFilterEnabled', v)} />
                      {(config.instruments?.spreadFilterEnabled ?? true) && (
                        <>
                          <FieldGroup label="Global Spread Override (pips)" description="Set to 0 to use per-instrument defaults (recommended). Any value > 0 overrides all instruments.">
                            <div className="flex items-center gap-4">
                              <Slider value={[config.instruments?.maxSpreadPips ?? 0]} onValueChange={v => updateField('instruments', 'maxSpreadPips', v[0])} min={0} max={20} step={0.5} className="flex-1" />
                              <span className="text-sm font-mono font-bold w-16 text-right">{(config.instruments?.maxSpreadPips ?? 0) === 0 ? 'Auto' : `${config.instruments?.maxSpreadPips}p`}</span>
                            </div>
                          </FieldGroup>
                          {/* Per-instrument spread defaults reference */}
                          <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border">
                            <p className="text-xs text-muted-foreground mb-2 font-medium">Per-instrument defaults (used when override = 0):</p>
                            <div className="grid grid-cols-3 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                              {[
                                { pair: 'EUR/USD', max: 2 }, { pair: 'GBP/USD', max: 3 }, { pair: 'USD/JPY', max: 2 },
                                { pair: 'AUD/USD', max: 3 }, { pair: 'NZD/USD', max: 3 }, { pair: 'USD/CAD', max: 3 },
                                { pair: 'GBP/JPY', max: 5 }, { pair: 'EUR/JPY', max: 4 }, { pair: 'GBP/NZD', max: 6 },
                                { pair: 'XAU/USD', max: 5 }, { pair: 'US30', max: 3 }, { pair: 'BTC/USD', max: 50 },
                              ].map(({ pair, max }) => (
                                <div key={pair} className="flex justify-between">
                                  <span className="text-muted-foreground">{pair}</span>
                                  <span className="font-mono font-medium">{max}p</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* ── ATR Volatility Filter ── */}
                    <div className="border-t border-border pt-4 mt-4">
                      <SectionHeader title="Volatility Filter (ATR)" description="Skip trades when market volatility is outside your preferred range" />
                      <ToggleField label="Enable Volatility Filter" description="Gate trades based on current ATR value" checked={config.instruments?.volatilityFilterEnabled ?? false} onChange={v => updateField('instruments', 'volatilityFilterEnabled', v)} />
                      {(config.instruments?.volatilityFilterEnabled) && (
                        <div className="grid grid-cols-2 gap-4 mt-3">
                          <FieldGroup label="Min ATR (pips)" description="Skip if ATR is below this — market too quiet">
                            <Input type="number" value={config.instruments?.minATR ?? 0} onChange={e => updateField('instruments', 'minATR', parseFloat(e.target.value) || 0)} step={1} min={0} className="h-9 text-sm" disabled={!(config.instruments?.volatilityFilterEnabled)} />
                          </FieldGroup>
                          <FieldGroup label="Max ATR (pips)" description="Skip if ATR exceeds this — market too volatile">
                            <Input type="number" value={config.instruments?.maxATR ?? 999} onChange={e => updateField('instruments', 'maxATR', parseFloat(e.target.value) || 0)} step={1} min={0} className="h-9 text-sm" disabled={!(config.instruments?.volatilityFilterEnabled)} />
                          </FieldGroup>
                        </div>
                      )}
                      {!(config.instruments?.volatilityFilterEnabled) && (
                        <p className="text-[10px] text-muted-foreground italic mt-2">When disabled, the bot trades regardless of market volatility.</p>
                      )}
                    </div>
                    {/* ── Correlation Filter ── */}
                    <div className="border-t border-border pt-4 mt-4">
                      <SectionHeader title="Correlation Filter" description="Prevent conflicting or doubling exposure on correlated pairs" />
                      <ToggleField label="Enable Correlation Filter" description="Block trades that conflict with or double exposure on open positions" checked={config.instruments?.correlationFilterEnabled ?? false} onChange={v => updateField('instruments', 'correlationFilterEnabled', v)} />
                      {(config.instruments?.correlationFilterEnabled) && (
                        <>
                          <FieldGroup label="Correlation Threshold" description="Minimum correlation strength (±) that counts as related. Lower = stricter (catches more pairs).">
                            <div className="flex items-center gap-4">
                              <Slider value={[config.instruments?.maxCorrelation ?? 0.8]} onValueChange={v => updateField('instruments', 'maxCorrelation', v[0])} min={0.5} max={0.95} step={0.05} className="flex-1" />
                              <span className="text-sm font-mono font-bold w-12 text-right">{(config.instruments?.maxCorrelation ?? 0.8).toFixed(2)}</span>
                            </div>
                          </FieldGroup>
                          <FieldGroup label="Max Correlated Positions" description="Maximum same-direction correlated pairs allowed before blocking. E.g., 1 = only one EUR long pair at a time.">
                            <div className="flex items-center gap-4">
                              <Slider value={[config.instruments?.maxCorrelatedPositions ?? 1]} onValueChange={v => updateField('instruments', 'maxCorrelatedPositions', v[0])} min={1} max={5} step={1} className="flex-1" />
                              <span className="text-sm font-mono font-bold w-8 text-right">{config.instruments?.maxCorrelatedPositions ?? 1}</span>
                            </div>
                          </FieldGroup>
                          <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border">
                            <p className="text-xs text-muted-foreground mb-2 font-medium">How it works:</p>
                            <div className="space-y-1.5 text-xs text-muted-foreground">
                              <p><span className="text-loss font-medium">Blocks conflicts:</span> Long EUR/USD + Long USD/CHF (betting against yourself on USD)</p>
                              <p><span className="text-highlight font-medium">Limits doubling:</span> Long EUR/USD + Long GBP/USD (both selling USD — capped by max above)</p>
                              <p><span className="text-cyan font-medium">SMT pairs:</span> EUR/USD↔GBP/USD, USD/JPY↔USD/CHF, AUD/USD↔NZD/USD, XAU/USD↔XAG/USD, BTC/USD↔ETH/USD</p>
                            </div>
                          </div>
                        </>
                      )}
                      {!(config.instruments?.correlationFilterEnabled) && (
                        <p className="text-[10px] text-muted-foreground italic mt-2">When disabled, the bot may open conflicting or doubling positions on correlated pairs.</p>
                      )}
                    </div>

                    {/* ── Per-Instrument SL Buffer Overrides ── */}
                    <div className="border-t border-border pt-4 mt-4">
                      <SectionHeader title="Per-Instrument SL Buffer" description="Override the global SL buffer for specific instruments. When set, the override is used directly (no asset-class multiplier). Leave empty to use the global buffer." />
                      <div className="space-y-3 mt-3">
                        {(['commodity', 'crypto', 'index'] as const).map(type => {
                          const typeInstruments = INSTRUMENTS.filter(i => i.type === type);
                          if (typeInstruments.length === 0) return null;
                          return (
                            <div key={type} className="space-y-2">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{INSTRUMENT_TYPE_LABELS[type]}</p>
                              <div className="space-y-2">
                                {typeInstruments.map(inst => {
                                  const currentVal = (config.instrumentBuffers as any)?.[inst.symbol]?.slBufferPips;
                                  const priceDistance = currentVal != null ? (currentVal * inst.pipSize).toFixed(inst.pipSize < 0.01 ? 4 : 2) : null;
                                  return (
                                    <div key={inst.symbol} className="flex items-center gap-3">
                                      <span className="text-xs font-medium w-20 shrink-0">{inst.symbol}</span>
                                      <Input
                                        type="number"
                                        placeholder="Global"
                                        value={currentVal ?? ''}
                                        onChange={e => {
                                          const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                          setConfig((prev: any) => {
                                            const buffers = { ...(prev?.instrumentBuffers || {}) };
                                            if (val == null || isNaN(val)) {
                                              delete buffers[inst.symbol];
                                            } else {
                                              buffers[inst.symbol] = { slBufferPips: val };
                                            }
                                            return { ...prev, instrumentBuffers: buffers };
                                          });
                                        }}
                                        step={1}
                                        min={1}
                                        max={1000}
                                        className="h-8 text-sm w-24"
                                      />
                                      <span className="text-[10px] text-muted-foreground w-24">
                                        {priceDistance ? `= $${priceDistance}` : `Global: ${(config.entry?.slBufferPips ?? 2)} pips`}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border">
                        <p className="text-xs text-muted-foreground"><span className="font-medium">How it works:</span> Forex pairs use the global SL buffer ({config.entry?.slBufferPips ?? 2} pips × asset multiplier). Commodities, crypto, and indices often need larger buffers due to higher volatility. Set a per-instrument value here to override the global calculation entirely.</p>
                      </div>
                    </div>
                  </div>
                )}

                {effectiveActiveTab === "sessions" && (
                  <div className="space-y-5">
                    <SectionHeader title="Trading Sessions" description="Toggle which market sessions the bot is active during. Session windows use fixed NY/ET times (DST-aware)." />
                    <div className="space-y-1">
                      {[
                        { id: "asian", label: "Asian Session", desc: "8:00 PM – 2:00 AM ET (Tokyo / Hong Kong)" },
                        { id: "london", label: "London Session", desc: "2:00 AM – 8:30 AM ET (London open)" },
                        { id: "newyork", label: "New York Session", desc: "8:30 AM – 4:00 PM ET (NY open)" },
                        { id: "offhours", label: "Off-Hours", desc: "4:00 PM – 8:00 PM ET (gap between NY close & Asian open)" },
                      ].map(session => {
                        // Derive enabled state: prefer filter array, fall back to legacy booleans
                        const filterArr = config.sessions?.filter;
                        const legacyKey = `${session.id}Enabled` as string;
                        const enabled = Array.isArray(filterArr)
                          ? filterArr.includes(session.id)
                          : (config.sessions?.[legacyKey] ?? false);
                        const toggle = (checked: boolean) => {
                          const sessions_cfg = config.sessions || {};
                          // Always normalise to filter-array format on toggle
                          const current: string[] = Array.isArray(sessions_cfg.filter)
                            ? [...sessions_cfg.filter]
                            : [
                                ...(sessions_cfg.asianEnabled ? ["asian"] : []),
                                ...(sessions_cfg.londonEnabled ? ["london"] : []),
                                ...(sessions_cfg.newYorkEnabled || sessions_cfg.newyorkEnabled ? ["newyork"] : []),
                                ...(sessions_cfg.sydneyEnabled || sessions_cfg.offHoursEnabled ? ["offhours"] : []),
                              ];
                          const updated = checked
                            ? [...new Set([...current, session.id])]
                            : current.filter((s: string) => s !== session.id);
                          updateField('sessions', 'filter', updated);
                        };
                        return (
                          <div key={session.id} className={`flex items-start justify-between gap-3 p-3 border transition-colors ${enabled ? "border-primary/40 bg-primary/5" : "border-border hover:border-border/80"}`}>
                            <div>
                              <p className={`text-xs font-medium ${enabled ? "text-primary" : ""}`}>{session.label}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">{session.desc}</p>
                            </div>
                            <Switch checked={enabled} onCheckedChange={toggle} className="shrink-0 mt-0.5" />
                          </div>
                        );
                      })}
                    </div>
                    <ToggleField label="Kill Zone Only Trading" description="Only trade during high-volume kill zone windows (London 02-05 ET, NY 08:30-11 ET)" checked={config.sessions?.killZoneOnly ?? false} onChange={v => updateField('sessions', 'killZoneOnly', v)} />
                    {/* ── News Event Filter ── */}
                    <div className="border-t border-border pt-4 mt-4">
                      <SectionHeader title="News Event Filter" description="Pause trading around high-impact economic events (NFP, FOMC, CPI, etc.)" />
                      <ToggleField label="Enable News Filter" description="Block new trades when a high-impact event is imminent" checked={config.sessions?.newsFilterEnabled ?? true} onChange={v => updateField('sessions', 'newsFilterEnabled', v)} />
                      <FieldGroup label="Pause Window (minutes)" description="Minutes before a high-impact event to stop opening new trades">
                        <div className="flex items-center gap-4">
                          <Slider value={[config.sessions?.newsFilterPauseMinutes ?? 30]} onValueChange={v => updateField('sessions', 'newsFilterPauseMinutes', v[0])} min={5} max={120} step={5} className="flex-1" disabled={!(config.sessions?.newsFilterEnabled ?? true)} />
                          <span className="text-sm font-mono font-bold w-12 text-right">{config.sessions?.newsFilterPauseMinutes ?? 30}m</span>
                        </div>
                      </FieldGroup>
                    </div>
                  </div>
                )}

                {effectiveActiveTab === "protection" && (
                  <div className="space-y-5">
                    <SectionHeader title="Protection" description="Safety limits and circuit breakers" />
                    <div className="grid grid-cols-2 gap-4">
                      <FieldGroup label="Max Daily Loss ($)" description="Hard dollar limit on closed-trade P&L — halts trading for the day. (Risk tab's Daily Drawdown uses % of balance instead.)">
                        <Input type="number" value={config.protection?.maxDailyLoss ?? 500} onChange={e => updateField('protection', 'maxDailyLoss', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="Max Consecutive Losses" description="Pause after N consecutive losing trades">
                        <Input type="number" value={config.protection?.maxConsecutiveLosses ?? 3} onChange={e => updateField('protection', 'maxConsecutiveLosses', parseFloat(e.target.value) || 0)} min={1} max={10} className="h-9 text-sm" />
                      </FieldGroup>
                    </div>
                    <FieldGroup label="Equity Circuit Breaker (%)" description="Emergency override — combined with Risk tab's Max Total Drawdown via Math.min (the lower value wins). Set this higher than Max Total Drawdown to let that control take priority.">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.protection?.circuitBreakerPct ?? 20]} onValueChange={v => updateField('protection', 'circuitBreakerPct', v[0])} min={5} max={50} step={1} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-destructive w-10 text-right">{config.protection?.circuitBreakerPct ?? 20}%</span>
                      </div>
                    </FieldGroup>
                  </div>
                )}

                {effectiveActiveTab === "pairOverrides" && (
                  <PairOverridesTab config={config} setConfig={setConfig} />
                )}

                {effectiveActiveTab === "factorWeights" && (
                  <FactorWeightsTab config={config} setConfig={setConfig} />
                )}

                {effectiveActiveTab === "openingRange" && (
                  <div className="space-y-5">
                    <SectionHeader title="Opening Range" description="Use the first N hourly candles of the trading day to derive bias, levels, and filters" />
                    <ToggleField label="Enable Opening Range" description="Master toggle — all sub-features require this to be on" checked={config.openingRange?.enabled ?? false} onChange={v => updateField('openingRange', 'enabled', v)} />
                    <FieldGroup label="Candle Count" description="Number of 1h candles that define the opening range (default 24)">
                      <Input type="number" value={config.openingRange?.candleCount ?? 24} onChange={e => updateField('openingRange', 'candleCount', Math.max(1, parseInt(e.target.value) || 24))} min={1} max={48} className="h-9 text-sm" disabled={!config.openingRange?.enabled} />
                    </FieldGroup>
                    <div className="grid grid-cols-2 gap-3">
                      <ToggleField label="Daily Bias from OR" description="Determine bullish/bearish bias based on price vs OR range" checked={config.openingRange?.useBias ?? true} onChange={v => updateField('openingRange', 'useBias', v)} />
                      <ToggleField label="Judas Swing Detection" description="Detect fake breakouts (sweeps) of OR high/low" checked={config.openingRange?.useJudasSwing ?? true} onChange={v => updateField('openingRange', 'useJudasSwing', v)} />
                      <ToggleField label="OR Key Levels" description="Use OR high, low, midpoint as support/resistance" checked={config.openingRange?.useKeyLevels ?? true} onChange={v => updateField('openingRange', 'useKeyLevels', v)} />
                      <ToggleField label="Premium/Discount from OR" description="Use OR range instead of swing range for P/D zones" checked={config.openingRange?.usePremiumDiscount ?? false} onChange={v => updateField('openingRange', 'usePremiumDiscount', v)} />
                    </div>
                    <ToggleField label="Wait for OR Completion" description="Don't trade until the opening range candle count is fully formed" checked={config.openingRange?.waitForCompletion ?? true} onChange={v => updateField('openingRange', 'waitForCompletion', v)} />
                    {!config.openingRange?.enabled && (
                      <p className="text-[10px] text-muted-foreground italic">Enable the master toggle above to activate sub-features.</p>
                    )}
                  </div>
                )}
                {effectiveActiveTab === "gamePlan" && (
                  <div className="space-y-5">
                    <SectionHeader title="Pre-Session Game Plan" description="Automatically generates session bias, Draw on Liquidity targets, IPDA ranges, and weekly profiles before each session. Analysis is integrated into the scoring engine to boost aligned trades and penalize opposing ones." />
                    <ToggleField label="Enable Game Plan" description="Master toggle — when enabled, the bot generates a game plan once per session and integrates it into scoring, TP placement, and scan priority" checked={config.gamePlanEnabled !== false} onChange={v => setConfig((prev: any) => ({ ...prev, gamePlanEnabled: v }))} />
                    <ToggleField label="Telegram Notifications" description="Send the game plan summary to Telegram when a new plan is generated (once per session, not every scan)" checked={config.gamePlanNotify !== false} onChange={v => setConfig((prev: any) => ({ ...prev, gamePlanNotify: v }))} />

                    <FieldGroup label="Refresh Interval (hours)" description="How often to regenerate the game plan within the same session. Default is 4 hours — the plan stays fresh for this long before a new one is generated.">
                      <Input type="number" value={config.gamePlanRefreshHours ?? 4} onChange={e => setConfig((prev: any) => ({ ...prev, gamePlanRefreshHours: Math.max(1, Math.min(12, parseInt(e.target.value) || 4)) }))} min={1} max={12} step={1} className="h-9 text-sm" disabled={!config.gamePlanEnabled} />
                    </FieldGroup>

                    {config.gamePlanEnabled && (
                      <div className="grid grid-cols-2 gap-3">
                        <ToggleField label="DOL TP Extension" description="Extend Take Profit to Draw on Liquidity targets when they are beyond the current TP. Only extends, never shortens. Respects 4× SL cap." checked={config.dolTPExtensionEnabled !== false} onChange={v => setConfig((prev: any) => ({ ...prev, dolTPExtensionEnabled: v }))} />
                        <ToggleField label="IPDA Ranges" description="Compute 20/40/60-day institutional data ranges and merge them as key levels into the game plan. Adds high/low/equilibrium reference points." checked={config.ipdaRangesEnabled !== false} onChange={v => setConfig((prev: any) => ({ ...prev, ipdaRangesEnabled: v }))} />
                      </div>
                    )}

                    {!config.gamePlanEnabled && (
                      <p className="text-[10px] text-muted-foreground italic">Enable the master toggle above to activate game plan features.</p>
                    )}
                    {config.gamePlanEnabled && (
                      <div className="border border-border rounded p-3 bg-secondary/30">
                        <p className="text-[11px] text-muted-foreground">
                          <strong className="text-foreground">How it works:</strong> The game plan runs once per session (London, NY, Asian). It analyzes D1/4H structure, identifies Draw on Liquidity targets, and generates conditional trade scenarios. The plan is cached for {config.gamePlanRefreshHours ?? 4} hours — subsequent scans reuse it without regenerating. Game plan bias, key levels, and DOL targets are integrated into the scoring engine — aligned trades score higher, opposing trades score lower. IPDA ranges and weekly profiles provide additional institutional context.
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {effectiveActiveTab === "ict2022" && (
                  <ICT2022Tab config={config} setConfig={setConfig} />
                )}
              </>
            )}
            {config && filteredTabs.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <Search className="h-8 w-8 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">No settings match "{search}"</p>
                <button
                  onClick={() => setSearch("")}
                  className="text-xs text-primary hover:underline mt-2"
                >
                  Clear search
                </button>
              </div>
            )}
            </HighlightContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Factor Weights Tab ───────────────────────────────────────────────────
const FACTOR_WEIGHT_DEFS: { key: string; name: string; defaultWeight: number; tier: 1 | 2 | 3; tierPts: number; description: string }[] = [
  // Tier 1 — Core Setup (×2 pts)
  { key: "marketStructure", name: "Market Structure", defaultWeight: 2.5, tier: 1, tierPts: 2, description: "BOS/CHoCH + entry TF trend alignment (merged)" },
  { key: "orderBlock", name: "Order Block", defaultWeight: 2.0, tier: 1, tierPts: 2, description: "Institutional order blocks" },
  { key: "fairValueGap", name: "Fair Value Gap", defaultWeight: 2.0, tier: 1, tierPts: 2, description: "FVG imbalances" },
  { key: "premiumDiscountFib", name: "Premium/Discount & Fib", defaultWeight: 2.0, tier: 1, tierPts: 2, description: "Fibonacci OTE zones" },
  // Tier 2 — Confirmation (×1 pt)
  { key: "pdPwLevels", name: "PD/PW Levels", defaultWeight: 1.0, tier: 2, tierPts: 1, description: "Previous day/week levels" },
  { key: "liquiditySweep", name: "Liquidity Sweep", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Liquidity pool sweeps with rejection confirmation" },
  { key: "displacement", name: "Displacement", defaultWeight: 1.0, tier: 2, tierPts: 1, description: "Strong institutional candles" },
  { key: "reversalCandle", name: "Reversal Candle", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Reversal at key levels — primary entry trigger" },
  { key: "sessionQuality", name: "Session Quality", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Combined Kill Zone + Silver Bullet + Macro timing (7-tier scoring)" },
  { key: "htfPoiAlignment", name: "HTF POI Alignment", defaultWeight: 2.0, tier: 2, tierPts: 1, description: "Price inside higher-timeframe OB/FVG/Breaker zone" },
  { key: "htfFibPdLiquidity", name: "HTF Fib + PD + Liquidity", defaultWeight: 2.5, tier: 2, tierPts: 1, description: "HTF Fibonacci + Premium/Discount + Liquidity alignment" },
  { key: "confluenceStack", name: "Confluence Stack", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Multiple POIs overlapping at same price level" },
  // Tier 3 — Bonus (×0.5 pts)
  { key: "currencyStrength", name: "Currency Strength", defaultWeight: 1.5, tier: 3, tierPts: 0.5, description: "FOTSI alignment" },
  { key: "smtDivergence", name: "SMT Divergence", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "Correlated pair divergence" },
  { key: "dailyBias", name: "Daily Bias", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "HTF daily trend alignment" },
  { key: "breakerBlock", name: "Breaker Block", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "Failed OB flip zones" },
  { key: "unicornModel", name: "Unicorn Model", defaultWeight: 1.5, tier: 3, tierPts: 0.5, description: "Breaker + FVG overlap" },
  { key: "volumeProfile", name: "Volume Profile", defaultWeight: 0.75, tier: 3, tierPts: 0.5, description: "TPO-based POC/HVN/LVN (reduced: synthetic data)" },
  { key: "amdPhase", name: "AMD Phase", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "Accumulation→Manipulation→Distribution" },
  { key: "judasSwing", name: "Judas Swing", defaultWeight: 0.75, tier: 3, tierPts: 0.5, description: "NY midnight-anchored fake breakout + liquidity sweep" },
  { key: "pullbackHealth", name: "Pullback Health", defaultWeight: 0.5, tier: 3, tierPts: 0.5, description: "Pullback decay analysis — healthy retracement vs exhaustion" },
  { key: "gamePlanKeyLevel", name: "GP Key Level", defaultWeight: 1.0, tier: 2, tierPts: 1, description: "Boosts score when entry is near a game plan key level (OBs, FVGs, PD levels, liquidity). Requires Game Plan enabled." },
];

const TIER_META: { tier: 1 | 2 | 3; label: string; subtitle: string; pts: string; color: string; borderColor: string }[] = [
  { tier: 1, label: "TIER 1 — CORE SETUP", subtitle: "Must-have setup components. At least 2 required for any trade.", pts: "×2 pts", color: "text-tier1", borderColor: "border-tier1/40" },
  { tier: 2, label: "TIER 2 — CONFIRMATION", subtitle: "Adds confidence to the setup.", pts: "×1 pt", color: "text-tier2", borderColor: "border-tier2/40" },
  { tier: 3, label: "TIER 3 — BONUS", subtitle: "Nice-to-have extras that boost score.", pts: "×0.5 pts", color: "text-tier3", borderColor: "border-tier3/40" },
];

function FactorWeightsTab({ config, setConfig }: { config: any; setConfig: (fn: any) => void }) {
  const fw: Record<string, number> = config.factorWeights || {};
  const hasOverrides = Object.keys(fw).length > 0;

  const updateWeight = (key: string, value: number) => {
    setConfig((prev: any) => ({
      ...prev,
      factorWeights: { ...(prev.factorWeights || {}), [key]: Math.round(value * 100) / 100 },
    }));
  };

  const resetAllWeights = () => {
    setConfig((prev: any) => ({ ...prev, factorWeights: {} }));
    toast.info("All factor weights reset to defaults");
  };

  const resetSingleWeight = (key: string) => {
    setConfig((prev: any) => {
      const next = { ...(prev.factorWeights || {}) };
      delete next[key];
      return { ...prev, factorWeights: next };
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <SectionHeader title="Factor Weights" description="Fine-tune how much each confluence factor contributes to the overall score. AI Advisor recommendations can auto-apply here." />
        {hasOverrides && (
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1" onClick={resetAllWeights}>
            <RotateCcw className="h-3 w-3" /> Reset All
          </Button>
        )}
      </div>

      <div className="rounded border border-border bg-muted/20 p-3 space-y-1.5">
        <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">How Tiered Scoring Works</p>
        <p className="text-[10px] text-muted-foreground">
          Each factor has a <span className="font-bold text-foreground">tier base value</span> (T1 = 2pts, T2 = 1pt, T3 = 0.5pts) that determines its importance.
          Your <span className="font-bold text-foreground">custom weight</span> multiplies this base value.
          For example, Market Structure at weight 2.5 scores <span className="font-mono">2.5 × 2pts = 5pts</span> when present.
        </p>
        <p className="text-[10px] text-muted-foreground">
          The final score is the sum of all present factors' weighted points, expressed as a percentage of the maximum possible.
          No group caps — your weights work directly.
        </p>
      </div>

      {TIER_META.map(tm => {
        const tierFactors = FACTOR_WEIGHT_DEFS.filter(f => f.tier === tm.tier);
        return (
          <div key={tm.tier} className={`border ${tm.borderColor} p-4 space-y-3`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-[10px] uppercase tracking-wider font-bold ${tm.color}`}>{tm.label}</p>
                <p className="text-[10px] text-muted-foreground">{tm.subtitle}</p>
              </div>
              <Badge variant="outline" className={`text-[9px] font-mono font-bold ${tm.color} border-current`}>{tm.pts}</Badge>
            </div>
            {tierFactors.map(factor => {
              const currentValue = fw[factor.key] ?? factor.defaultWeight;
              const isOverridden = fw[factor.key] !== undefined;
              const maxSlider = Math.max(factor.defaultWeight * 2, 3);
              const effectivePoints = (currentValue * factor.tierPts).toFixed(1);
              return (
                <div key={factor.key} className={`space-y-1 p-2 -mx-2 transition-colors ${isOverridden ? "bg-primary/5 border border-primary/20" : ""}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{factor.name}</span>
                      {isOverridden && (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-mono">custom</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] text-muted-foreground font-mono">{currentValue.toFixed(2)} × {factor.tierPts}pts =</span>
                      <span className="text-sm font-mono font-bold text-primary w-14 text-right">{effectivePoints}pts</span>
                      {isOverridden && (
                        <button
                          onClick={() => resetSingleWeight(factor.key)}
                          className="text-muted-foreground hover:text-foreground"
                          title={`Reset to default (${factor.defaultWeight})`}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{factor.description} (default weight: {factor.defaultWeight})</p>
                  <Slider
                    value={[currentValue]}
                    onValueChange={v => updateWeight(factor.key, v[0])}
                    min={0}
                    max={maxSlider}
                    step={0.25}
                    className="mt-1"
                  />
                  <div className="flex justify-between text-[9px] text-muted-foreground">
                    <span>0 (disabled)</span>
                    <span>{factor.defaultWeight} (default)</span>
                    <span>{maxSlider} (max)</span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Gates (not weight-adjustable) */}
      <div className="border border-border p-4 space-y-3">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">GATES (Pass/Fail)</p>
          <p className="text-[10px] text-muted-foreground">These are binary checks — not scored. A failed gate rejects the trade regardless of score.</p>
        </div>
        <div className="space-y-1 p-2 -mx-2 opacity-70">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Tier 1 Minimum</span>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-mono">gate</Badge>
          </div>
          <p className="text-[10px] text-muted-foreground">At least 2 Tier 1 (Core) factors must be present for any trade to pass. Not adjustable.</p>
        </div>
        <div className="space-y-1 p-2 -mx-2 opacity-70">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Regime Alignment</span>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-mono">gate</Badge>
          </div>
          <p className="text-[10px] text-muted-foreground">Market regime must align with trade direction (e.g., trending market for trend trades). Fails if regime conflicts.</p>
        </div>
      </div>

      {/* Spread Quality (info-only) */}
      <div className="border border-border/50 p-4 space-y-2 opacity-60">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">INFO ONLY</p>
        </div>
        <div className="space-y-1 p-2 -mx-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Spread Quality</span>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-mono text-muted-foreground">info</Badge>
          </div>
          <p className="text-[10px] text-muted-foreground">Shows indicative spread-to-ATR ratio from market data. Does not block trades — your actual broker spread (ECN/raw) is checked at execution time. Displayed for awareness only.</p>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-bold">{title}</h3>
      <p className="text-[11px] text-muted-foreground">{description}</p>
    </div>
  );
}

function FieldGroup({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  const highlight = useContext(HighlightContext);
  const isMatch = highlight.has(label.toLowerCase());
  return (
    <div className={`space-y-1.5 transition-all ${isMatch ? "ring-1 ring-primary/60 bg-primary/5 rounded-sm p-2 -m-2" : ""}`}>
      <div>
        <Label className={`text-xs font-medium ${isMatch ? "text-primary" : ""}`}>{label}</Label>
        {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function ToggleField({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const highlight = useContext(HighlightContext);
  const isMatch = highlight.has(label.toLowerCase());
  return (
    <div className={`flex items-start justify-between gap-3 p-3 border transition-colors ${isMatch ? "border-primary/60 bg-primary/5" : "border-border hover:border-border/80"}`}>
      <div>
        <p className={`text-xs font-medium ${isMatch ? "text-primary" : ""}`}>{label}</p>
        {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="shrink-0 mt-0.5" />
    </div>
  );
}

// ─── Per-Pair Gate Overrides Tab ──────────────────────────────────────────────
// Allows per-symbol overrides for key gate thresholds. Overrides are stored in
// config.pairGateOverrides[symbol] and applied by applyPairOverrides() in the scanner.

const RECOMMENDED_OVERRIDES: Record<string, Record<string, any>> = {
  'EUR/JPY': { minTier1Factors: 1, allowSameDirectionStacking: true, maxPerSymbol: 2, minRiskReward: 0.8 },
  'GBP/USD': { protectionMaxDailyLossDollar: 5000, maxConsecutiveLosses: 8 },
  'USD/CAD': { minTier1Factors: 2 },
  'USD/CHF': { minRiskReward: 0.8 },
  'NZD/CHF': { minRiskReward: 0.8 },
  'XAU/USD': { minConfluence: 35 },
  'BTC/USD': { minTier1Factors: 4, allowSameDirectionStacking: false, maxPerSymbol: 1 },
};

const OVERRIDE_FIELDS = [
  { key: 'minRiskReward', label: 'Min R:R', type: 'number', min: 0.1, max: 5, step: 0.1, description: 'Effective R:R threshold (after spread/commission)' },
  { key: 'minTier1Factors', label: 'Min Tier 1', type: 'number', min: 1, max: 5, step: 1, description: 'Minimum core factors (MS, OB, FVG, P/D, HTF)' },
  { key: 'minConfluence', label: 'Min Confluence %', type: 'number', min: 10, max: 80, step: 5, description: 'Score threshold for this pair' },
  { key: 'maxPerSymbol', label: 'Max Per Symbol', type: 'number', min: 1, max: 5, step: 1, description: 'Max concurrent positions for this pair' },
  { key: 'allowSameDirectionStacking', label: 'Allow Stacking', type: 'toggle', description: 'Allow same-direction stacking' },
  { key: 'protectionMaxDailyLossDollar', label: 'Max Daily Loss ($)', type: 'number', min: 50, max: 10000, step: 50, description: 'Pair-specific daily P&L limit' },
  { key: 'maxConsecutiveLosses', label: 'Max Consec Losses', type: 'number', min: 1, max: 15, step: 1, description: 'Pair-specific consecutive loss cooldown' },
] as const;

function PairOverridesTab({ config, setConfig }: { config: any; setConfig: (fn: any) => void }) {
  const [expandedPair, setExpandedPair] = useState<string | null>(null);
  const overrides: Record<string, Record<string, any>> = config.pairGateOverrides || {};

  const updateOverride = (symbol: string, field: string, value: any) => {
    setConfig((prev: any) => {
      const current = { ...(prev.pairGateOverrides || {}) };
      const pairCfg = { ...(current[symbol] || {}) };
      if (value === undefined || value === '' || value === null) {
        delete pairCfg[field];
      } else {
        pairCfg[field] = value;
      }
      // Remove pair entry if empty
      if (Object.keys(pairCfg).length === 0) {
        delete current[symbol];
      } else {
        current[symbol] = pairCfg;
      }
      return { ...prev, pairGateOverrides: current };
    });
  };

  const clearPairOverrides = (symbol: string) => {
    setConfig((prev: any) => {
      const current = { ...(prev.pairGateOverrides || {}) };
      delete current[symbol];
      return { ...prev, pairGateOverrides: current };
    });
  };

  const applyRecommendations = () => {
    setConfig((prev: any) => ({
      ...prev,
      pairGateOverrides: { ...(prev.pairGateOverrides || {}), ...RECOMMENDED_OVERRIDES },
    }));
    toast.success('Applied data-driven recommendations for 7 pairs');
  };

  const hasOverride = (symbol: string) => {
    const o = overrides[symbol];
    return o && Object.keys(o).length > 0;
  };

  const enabledInstruments = config.instruments?.enabled || INSTRUMENTS.map((i: any) => i.symbol);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Per-Pair Gate Overrides"
        description="Set symbol-specific gate thresholds. Empty fields use the global setting. Only enabled instruments are shown."
      />

      {/* Quick Apply Recommendations */}
      <div className="border border-dashed border-primary/40 rounded p-3 bg-primary/5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-primary">Data-Driven Recommendations</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Apply optimized overrides based on rejected setups analysis (EUR/JPY, GBP/USD, USD/CAD, USD/CHF, NZD/CHF, XAU/USD, BTC/USD)
            </p>
          </div>
          <Button variant="outline" size="sm" className="text-[10px] h-7 shrink-0 border-primary/40 text-primary hover:bg-primary/10" onClick={applyRecommendations}>
            Apply All
          </Button>
        </div>
      </div>

      {/* Pair list grouped by type */}
      {INSTRUMENT_TYPES.map(type => {
        const typeInstruments = INSTRUMENTS.filter((i: any) => i.type === type && enabledInstruments.includes(i.symbol));
        if (typeInstruments.length === 0) return null;
        return (
          <div key={type} className="space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{INSTRUMENT_TYPE_LABELS[type]}</p>
            <div className="space-y-1">
              {typeInstruments.map((inst: any) => {
                const isExpanded = expandedPair === inst.symbol;
                const pairOverride = overrides[inst.symbol] || {};
                const hasOvr = hasOverride(inst.symbol);
                return (
                  <div key={inst.symbol} className={`border transition-colors ${hasOvr ? 'border-primary/40 bg-primary/5' : 'border-border'}`}>
                    {/* Pair header row */}
                    <button
                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-secondary/30 transition-colors"
                      onClick={() => setExpandedPair(isExpanded ? null : inst.symbol)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium w-20">{inst.symbol}</span>
                        {hasOvr && (
                          <Badge variant="secondary" className="text-[9px] h-4 px-1.5">
                            {Object.keys(pairOverride).length} override{Object.keys(pairOverride).length > 1 ? 's' : ''}
                          </Badge>
                        )}
                      </div>
                      {isExpanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
                    </button>

                    {/* Expanded override fields */}
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          {OVERRIDE_FIELDS.map(field => {
                            if (field.type === 'toggle') {
                              const val = pairOverride[field.key];
                              return (
                                <div key={field.key} className="col-span-2">
                                  <div className="flex items-center justify-between gap-3 p-2 border border-border rounded">
                                    <div>
                                      <p className="text-[11px] font-medium">{field.label}</p>
                                      <p className="text-[9px] text-muted-foreground">{field.description}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {val !== undefined && (
                                        <button className="text-[9px] text-muted-foreground hover:text-destructive" onClick={() => updateOverride(inst.symbol, field.key, undefined)}>✕</button>
                                      )}
                                      <Switch
                                        checked={val ?? config.risk?.allowSameDirectionStacking ?? false}
                                        onCheckedChange={v => updateOverride(inst.symbol, field.key, v)}
                                        className="shrink-0"
                                      />
                                    </div>
                                  </div>
                                </div>
                              );
                            }
                            const val = pairOverride[field.key];
                            return (
                              <div key={field.key} className="space-y-1">
                                <Label className="text-[10px] font-medium">{field.label}</Label>
                                <Input
                                  type="number"
                                  placeholder="Global"
                                  value={val ?? ''}
                                  onChange={e => {
                                    const v = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                    updateOverride(inst.symbol, field.key, v);
                                  }}
                                  step={field.step}
                                  min={field.min}
                                  max={field.max}
                                  className="h-7 text-[11px]"
                                />
                                <p className="text-[9px] text-muted-foreground">{field.description}</p>
                              </div>
                            );
                          })}
                        </div>
                        {hasOvr && (
                          <div className="flex justify-end">
                            <Button variant="ghost" size="sm" className="text-[10px] h-6 text-destructive hover:text-destructive" onClick={() => clearPairOverrides(inst.symbol)}>
                              <Trash2 className="h-3 w-3 mr-1" /> Clear All Overrides
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Summary of active overrides */}
      {Object.keys(overrides).length > 0 && (
        <div className="border border-border rounded p-3 bg-secondary/30">
          <p className="text-[11px] text-muted-foreground">
            <strong className="text-foreground">Active overrides:</strong>{' '}
            {Object.entries(overrides).map(([sym, o]) => (
              <span key={sym} className="inline-block mr-2">
                <Badge variant="outline" className="text-[9px] h-4">{sym}: {Object.keys(o).length} field{Object.keys(o).length > 1 ? 's' : ''}</Badge>
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── ICT 2022 Mentorship Tab ──────────────────────────────────────────────
// Frontend-only surface for the ICT modules already wired into bot-scanner.
// Values are written into config.strategy.* so the scanner's existing
// `strategy.X ?? raw.X ?? DEFAULTS.X` resolution chain picks them up
// without any bot-logic changes.
function ICT2022Tab({ config, setConfig }: { config: any; setConfig: (fn: any) => void }) {
  const strategy = config.strategy || {};

  const updateStrategy = (key: string, value: any) => {
    setConfig((prev: any) => ({
      ...prev,
      strategy: { ...(prev.strategy || {}), [key]: value },
    }));
  };

  const getEnabled = (field: string, fallback = true) =>
    strategy[field] !== undefined ? !!strategy[field] : fallback;
  const getGate = (field: string): "off" | "soft" | "hard" =>
    (strategy[field] as "off" | "soft" | "hard") || "off";

  const enabledCount = ICT2022_MODULES.filter(m => getEnabled(m.enabledField)).length;
  const activeGates = ICT2022_MODULES.filter(m => m.hasGate && getGate(m.gateField) !== "off").length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <SectionHeader
          title="ICT 2022 Mentorship"
          description="Inner Circle Trader 2022 Mentorship modules. Already wired into the scanner — these toggles expose the gate modes."
        />
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className="text-[9px] font-mono">
            {enabledCount}/{ICT2022_MODULES.length} enabled
          </Badge>
          <Badge variant="outline" className="text-[9px] font-mono">
            {activeGates} active gate{activeGates === 1 ? "" : "s"}
          </Badge>
        </div>
      </div>

      <div className="rounded border border-tier3/40 bg-badge-info p-3 space-y-1.5">
        <p className="text-[10px] text-tier3 font-bold uppercase tracking-wider">How gate modes work</p>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          <span className="font-mono font-bold text-foreground">Off</span> — module logs its verdict but has zero impact on trades. Use this to observe behaviour first.{" "}
          <span className="font-mono font-bold text-foreground">Soft</span> — module adds a score bonus when satisfied / penalty when violated.{" "}
          <span className="font-mono font-bold text-foreground">Hard</span> — module blocks the trade entirely when its rule is violated.
        </p>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Recommended rollout: leave on <span className="font-mono">Off</span> for a few sessions, watch the logs, then move one module at a time to <span className="font-mono">Soft</span>.
        </p>
      </div>

      <div className="space-y-3">
        {ICT2022_MODULES.map(m => {
          const enabled = getEnabled(m.enabledField);
          const gate = m.hasGate ? getGate(m.gateField) : null;
          return (
            <div
              key={m.key}
              className={`border p-3 space-y-3 transition-colors ${
                enabled ? "border-border" : "border-border/40 opacity-70"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold">{m.label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{m.description}</p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={v => updateStrategy(m.enabledField, v)}
                  className="shrink-0 mt-0.5"
                />
              </div>

              {m.hasGate && (
                <div className="flex items-center gap-3 pt-1 border-t border-border/40">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
                    Gate Mode
                  </Label>
                  <Select
                    value={gate || "off"}
                    onValueChange={(v: "off" | "soft" | "hard") => updateStrategy(m.gateField, v)}
                    disabled={!enabled}
                  >
                    <SelectTrigger className="h-8 text-xs w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off" className="text-xs">Off — log only</SelectItem>
                      <SelectItem value="soft" className="text-xs">Soft — score impact</SelectItem>
                      <SelectItem value="hard" className="text-xs">Hard — block trade</SelectItem>
                    </SelectContent>
                  </Select>
                  {gate && gate !== "off" && (
                    <Badge
                      variant="outline"
                      className={`text-[9px] font-mono ${
                        gate === "hard" ? "text-loss border-loss/40" : "text-warn border-warn/40"
                      }`}
                    >
                      {gate === "hard" ? "BLOCKING" : "SCORING"}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded border border-border bg-muted/20 p-3">
        <p className="text-[10px] text-muted-foreground">
          <span className="font-bold text-foreground">Note:</span> The scanner reads these flags from{" "}
          <span className="font-mono">config.strategy</span> first, then falls back to its compiled defaults.
          Saving here persists overrides to your bot config — no redeploy required.
        </p>
      </div>
    </div>
  );
}
