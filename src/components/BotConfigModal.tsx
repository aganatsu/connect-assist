import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { botConfigApi } from "@/lib/api";
import { STYLE_PARAMS, STYLE_META, type TradingStyleMode } from "@/lib/botStyleClassifier";
import { toast } from "sonner";
import { X, Shield, Globe, Search, Bookmark, FolderOpen, ChevronDown, ChevronUp, Trash2, Target, Download, Upload, Flag } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatBrokerTime } from "@/lib/formatTime";
import { HighlightContext } from "@/components/config/ConfigShared";
import { ScanTab } from "@/components/config/ScanTab";
import { EnterTab } from "@/components/config/EnterTab";
import { ExitTab } from "@/components/config/ExitTab";
import { RiskTab } from "@/components/config/RiskTab";

// ─── Search Index ─────────────────────────────────────────────────────────────
// Maps every searchable setting to a tab ID and keywords for the search bar.
const SEARCH_INDEX: { tab: string; label: string; keywords: string[] }[] = [
  // SCAN tab
  { tab: "scan", label: "Trading Style", keywords: ["scalper", "day trader", "swing", "style", "mode"] },
  { tab: "scan", label: "Auto Scan Interval", keywords: ["scan", "interval", "scanner", "frequency"] },
  { tab: "scan", label: "Confluence Threshold", keywords: ["confluence", "score", "threshold", "minimum"] },
  { tab: "scan", label: "Order Blocks", keywords: ["ob", "order block", "smc", "institutional"] },
  { tab: "scan", label: "Fair Value Gaps", keywords: ["fvg", "imbalance", "gap"] },
  { tab: "scan", label: "Liquidity Sweeps", keywords: ["liquidity", "sweep", "equal highs", "equal lows"] },
  { tab: "scan", label: "Market Structure", keywords: ["bos", "choch", "structure", "break", "shift"] },
  { tab: "scan", label: "Displacement", keywords: ["displacement", "impulse", "institutional candle"] },
  { tab: "scan", label: "Breaker Blocks", keywords: ["breaker", "failed ob", "flip"] },
  { tab: "scan", label: "Unicorn Model", keywords: ["unicorn", "breaker fvg", "overlap"] },
  { tab: "scan", label: "Session Quality", keywords: ["session", "kill zone", "silver bullet", "macro"] },
  { tab: "scan", label: "SMT Divergence", keywords: ["smt", "divergence", "correlated", "pair"] },
  { tab: "scan", label: "Volume Profile", keywords: ["volume", "profile", "tpo", "poc", "hvn", "lvn"] },
  { tab: "scan", label: "Trend Direction", keywords: ["trend", "direction", "bias", "higher timeframe"] },
  { tab: "scan", label: "Daily Bias", keywords: ["daily", "bias", "htf", "direction"] },
  { tab: "scan", label: "AMD Model", keywords: ["amd", "accumulation", "manipulation", "distribution"] },
  { tab: "scan", label: "Currency Strength", keywords: ["fotsi", "currency", "strength", "weakness"] },
  { tab: "scan", label: "HTF Bias Hard Veto", keywords: ["htf", "bias", "veto", "hard", "block"] },
  { tab: "scan", label: "Only Buy in Discount", keywords: ["discount", "buy", "premium", "sell", "zone"] },
  { tab: "scan", label: "Only Sell in Premium", keywords: ["premium", "sell", "discount", "buy", "zone"] },
  { tab: "scan", label: "Require Liquidity Sweep", keywords: ["require", "liquidity", "sweep", "entry trigger"] },
  { tab: "scan", label: "Impulse Zone Gate Mode", keywords: ["impulse", "zone", "gate", "mode", "hard", "soft", "off"] },
  { tab: "scan", label: "Max Fib Retracement", keywords: ["fib", "retracement", "max", "ote", "deep"] },
  { tab: "scan", label: "Normalized Scoring", keywords: ["normalized", "scoring", "percentage", "scale"] },
  { tab: "scan", label: "Structural Conviction", keywords: ["structural", "conviction", "bonus", "multi-tf"] },
  { tab: "scan", label: "Regime Scoring", keywords: ["regime", "scoring", "trending", "ranging", "volatile"] },
  { tab: "scan", label: "Structure Lookback", keywords: ["structure", "lookback", "bos", "choch", "bars"] },
  { tab: "scan", label: "FVG Min Size", keywords: ["fvg", "min", "size", "pips", "filter"] },
  { tab: "scan", label: "FVG Only Unfilled", keywords: ["fvg", "unfilled", "mitigated"] },
  { tab: "scan", label: "Liquidity Pool Min Touches", keywords: ["liquidity", "pool", "touches", "equal highs"] },
  { tab: "scan", label: "Tier 1 Gate Enabled", keywords: ["tier 1", "gate", "toggle", "disable", "enable", "core factors"] },
  { tab: "scan", label: "Min Tier 1 Core Factors", keywords: ["tier 1", "core", "factors", "minimum"] },
  { tab: "scan", label: "Instruments", keywords: ["instruments", "pairs", "forex", "crypto", "gold", "indices"] },
  { tab: "scan", label: "Spread Filter", keywords: ["spread", "filter", "max", "pips"] },
  { tab: "scan", label: "ATR Filter", keywords: ["atr", "filter", "volatility", "min", "max"] },
  { tab: "scan", label: "Correlation Filter", keywords: ["correlation", "filter", "correlated", "positions"] },
  { tab: "scan", label: "Asian Session", keywords: ["asian", "session", "tokyo", "hong kong"] },
  { tab: "scan", label: "London Session", keywords: ["london", "session", "uk", "europe"] },
  { tab: "scan", label: "New York Session", keywords: ["new york", "session", "ny", "us"] },
  { tab: "scan", label: "Kill Zone Only", keywords: ["kill zone", "only", "trading", "window"] },
  { tab: "scan", label: "News Filter", keywords: ["news", "filter", "nfp", "fomc", "cpi", "event"] },
  { tab: "scan", label: "News Pause (minutes)", keywords: ["news", "pause", "minutes", "before"] },
  { tab: "scan", label: "Opening Range", keywords: ["opening range", "or", "candle", "bias", "judas"] },
  { tab: "scan", label: "Game Plan", keywords: ["game plan", "session", "dol", "ipda", "bias"] },
  { tab: "scan", label: "ICT 2022 Mentorship", keywords: ["ict", "mentorship", "2022", "smc", "inner circle trader"] },
  { tab: "scan", label: "HTF Framework", keywords: ["ict", "htf", "framework", "weekly", "daily", "containment"] },
  { tab: "scan", label: "Displacement-Validated MSS", keywords: ["ict", "displacement", "mss", "market structure shift"] },
  { tab: "scan", label: "Judas Swing / Liquidity Sweep", keywords: ["ict", "judas", "sweep", "false move"] },
  { tab: "scan", label: "FVG Invalidation Rules", keywords: ["ict", "fvg", "invalidation", "rule of 2", "encroachment"] },
  { tab: "scan", label: "Kill Zones & Silver Bullet", keywords: ["ict", "kill zone", "silver bullet", "window"] },
  { tab: "scan", label: "SMC Enhancements", keywords: ["smc", "enhancement", "phase", "breaker", "zone lifecycle", "trendline", "monthly"] },
  { tab: "scan", label: "Phase Detection", keywords: ["phase", "consolidation", "expansion", "trend", "regime"] },
  { tab: "scan", label: "Zone Lifecycle v2", keywords: ["zone", "lifecycle", "invalidation", "close", "retest"] },
  { tab: "scan", label: "Trendline Liquidity", keywords: ["trendline", "liquidity", "trap", "4th touch"] },
  { tab: "scan", label: "Monthly Containment", keywords: ["monthly", "containment", "htf", "structural"] },
  { tab: "scan", label: "Direction Engine", keywords: ["direction", "engine", "consensus", "strict", "veto", "htf", "mtf"] },
  { tab: "scan", label: "Zone Engine Fine-Tuning", keywords: ["zone", "quality", "threshold", "age", "body", "ratio", "displacement"] },
  { tab: "scan", label: "Thesis Conviction Tracker", keywords: ["thesis", "conviction", "decay", "evidence", "stale"] },
  { tab: "scan", label: "SMT Opposite Veto", keywords: ["smt", "veto", "opposite", "block"] },
  { tab: "scan", label: "Swept-Absorbed Penalty", keywords: ["swept", "absorbed", "penalty", "liquidity"] },
  { tab: "scan", label: "OB Lookback Candles", keywords: ["ob", "order block", "lookback", "advanced"] },
  { tab: "scan", label: "Per-Instrument SL Buffer", keywords: ["sl buffer", "per-instrument", "gold", "xau", "btc"] },
  // ENTER tab
  { tab: "enter", label: "Factor Weights", keywords: ["factor", "weight", "scoring", "tier", "points"] },
  { tab: "enter", label: "Market Structure Weight", keywords: ["market structure", "weight", "factor"] },
  { tab: "enter", label: "Order Block Weight", keywords: ["order block", "weight", "factor"] },
  { tab: "enter", label: "FVG Weight", keywords: ["fvg", "weight", "factor", "fair value"] },
  { tab: "enter", label: "Premium/Discount Weight", keywords: ["premium", "discount", "fib", "weight"] },
  { tab: "enter", label: "Pending Zone Orders", keywords: ["zone", "setup", "pending", "order", "confirmation", "entry type", "limit"] },
  { tab: "enter", label: "Confirmation Method", keywords: ["confirmation", "method", "choch", "indicators", "bollinger", "stochastic", "macd"] },
  { tab: "enter", label: "Indicator Min Count", keywords: ["indicator", "min", "count", "confirmation", "required"] },
  { tab: "enter", label: "Market Fill at Zone", keywords: ["market", "fill", "zone", "immediate", "atr", "proximity"] },
  { tab: "enter", label: "Zone Proximity (ATR)", keywords: ["atr", "multiplier", "proximity", "zone", "distance"] },
  { tab: "enter", label: "Zone Watch Expiry", keywords: ["zone", "expiry", "watch", "cancel", "minutes"] },
  { tab: "enter", label: "Zone Setup Distance", keywords: ["zone", "distance", "pips", "max", "min"] },
  { tab: "enter", label: "Zone Preference", keywords: ["zone", "ob", "fvg", "nearest", "prefer"] },
  { tab: "enter", label: "Per-Pair Gate Overrides", keywords: ["pair", "override", "gate", "symbol", "per-pair"] },
  { tab: "enter", label: "Cooldown Between Trades (minutes)", keywords: ["cooldown", "wait", "between", "delay"] },
  { tab: "enter", label: "Staging Mode", keywords: ["staging", "persist", "cycles", "ttl", "fleeting"] },
  { tab: "enter", label: "Watch Threshold", keywords: ["watch", "threshold", "watchlist", "minimum"] },
  { tab: "enter", label: "Limit Order Distance", keywords: ["limit", "order", "distance", "pips", "pending"] },
  { tab: "enter", label: "Pending Order Cooldown", keywords: ["pending", "cooldown", "expiry", "re-place", "wait"] },
  // EXIT tab
  { tab: "exit", label: "SL Method", keywords: ["sl", "stop loss", "method", "structure", "atr", "fixed pips"] },
  { tab: "exit", label: "SL Buffer (pips)", keywords: ["sl", "stop loss", "buffer", "pips"] },
  { tab: "exit", label: "Fixed SL Pips", keywords: ["sl", "fixed", "pips"] },
  { tab: "exit", label: "ATR Multiple (SL)", keywords: ["atr", "multiple", "sl"] },
  { tab: "exit", label: "ATR Period", keywords: ["atr", "period", "candles"] },
  { tab: "exit", label: "TP Method", keywords: ["tp", "take profit", "method", "rr", "next level"] },
  { tab: "exit", label: "Fixed TP Pips", keywords: ["tp", "fixed", "pips"] },
  { tab: "exit", label: "R:R Ratio", keywords: ["rr", "risk reward", "ratio", "tp"] },
  { tab: "exit", label: "TP ATR Multiple", keywords: ["tp", "atr", "multiple"] },
  { tab: "exit", label: "Trailing Stop", keywords: ["trailing", "stop", "trail", "ratchet", "management"] },
  { tab: "exit", label: "Break Even", keywords: ["break even", "breakeven", "be", "management"] },
  { tab: "exit", label: "Partial Take Profit", keywords: ["partial", "tp", "close", "percent", "level"] },
  { tab: "exit", label: "Close on Reverse Signal", keywords: ["reverse", "close", "opposite"] },
  { tab: "exit", label: "Max Trade Duration", keywords: ["max", "duration", "hours", "time", "hold"] },
  { tab: "exit", label: "Friday Close", keywords: ["friday", "close", "weekend", "gap"] },
  { tab: "exit", label: "Adaptive Trailing", keywords: ["adaptive", "trailing", "atr", "tighten", "widen", "momentum"] },
  { tab: "exit", label: "Regime-Adaptive TP", keywords: ["regime", "adaptive", "tp", "trending", "ranging", "multiplier"] },
  { tab: "exit", label: "Structure Invalidation", keywords: ["structure", "invalidation", "choch", "reversal", "protection"] },
  { tab: "exit", label: "Time-Based Exit", keywords: ["time", "exit", "hours", "auto close", "max hold"] },
  // RISK tab
  { tab: "risk", label: "Risk per Trade (%)", keywords: ["risk", "size", "percent", "percentage"] },
  { tab: "risk", label: "Standalone Size Multiplier", keywords: ["standalone", "multiplier", "size", "half", "conviction"] },
  { tab: "risk", label: "Max Daily Drawdown (%)", keywords: ["drawdown", "daily", "loss", "halt"] },
  { tab: "risk", label: "Max Concurrent Trades", keywords: ["concurrent", "open", "positions", "max"] },
  { tab: "risk", label: "Min R:R Ratio", keywords: ["rr", "risk reward", "ratio", "minimum"] },
  { tab: "risk", label: "Portfolio Heat (%)", keywords: ["portfolio", "heat", "exposure", "total"] },
  { tab: "risk", label: "Max Per Symbol", keywords: ["per symbol", "instrument", "max", "duplicate"] },
  { tab: "risk", label: "Same-Direction Stacking", keywords: ["stacking", "duplicate", "same direction", "pyramid"] },
  { tab: "risk", label: "Max Total Drawdown (%)", keywords: ["drawdown", "kill switch", "total", "max"] },
  { tab: "risk", label: "Position Sizing Method", keywords: ["sizing", "lot", "fixed", "volatility", "atr", "position size"] },
  { tab: "risk", label: "Conflict Threshold Raise", keywords: ["conflict", "opposing", "threshold", "raise", "counter"] },
  { tab: "risk", label: "Conflict Hard Block", keywords: ["conflict", "block", "opposing", "veto", "counter"] },
  { tab: "risk", label: "Fixed Lot Size", keywords: ["lot", "fixed", "size", "volume"] },
  { tab: "risk", label: "ATR Volatility Multiplier", keywords: ["atr", "multiplier", "volatility", "sizing"] },
  { tab: "risk", label: "Max Daily Loss ($)", keywords: ["daily", "loss", "dollar", "protection", "halt"] },
  { tab: "risk", label: "Max Consecutive Losses", keywords: ["consecutive", "losses", "pause", "protection"] },
  { tab: "risk", label: "Equity Circuit Breaker", keywords: ["circuit", "breaker", "equity", "emergency", "override"] },
];

// ─── Legacy Tab ID → New Tab ID Mapping ───────────────────────────────────────
// Used to translate defaultTab props from other components that still use old IDs.
const TAB_ID_MAP: Record<string, string> = {
  tradingStyle: "scan",
  strategy: "scan",
  instruments: "scan",
  sessions: "scan",
  openingRange: "scan",
  gamePlan: "scan",
  ict2022: "scan",
  smcEnhancements: "scan",
  entry_exit: "exit",
  factorWeights: "enter",
  pairOverrides: "enter",
  risk: "risk",
  protection: "risk",
};

// ─── Full Config Presets ─────────────────────────────────────────────────
const BASE_CONFIG = {
  strategy: {
    enableOB: true, enableFVG: true, enableLiquidity: true, enableStructure: true,
    enableDisplacement: true, enableBreaker: false, enableUnicorn: false,
    enableSession: true, enableSMT: false, enableVolumeProfile: false,
    enableTrendDirection: true, enableDailyBias: true, enableAMD: true, enableFOTSI: false,
    confluenceThreshold: 55, normalizedScoring: true,
    htfBiasHardVeto: false, requireHTFBias: true,
    onlyBuyInDiscount: false, onlySellInPremium: false,
    requireLiquiditySweep: false,
    impulseZoneGateMode: "hard", fibMaxRetracement: 0.786,
    tier1GateEnabled: true, minTier1Factors: 2,
    structuralConvictionEnabled: true,
    regimeScoringEnabled: true, regimeScoringStrength: 1.0,
    structureLookback: 50, fvgMinSizePips: 3, fvgOnlyUnfilled: true, liquidityMinTouches: 2,
    sweptAbsorbedPenalty: 2.0,
  },
  risk: {
    riskPerTrade: 1, positionSizingMethod: "percent_risk",
    maxConcurrentTrades: 5, maxPortfolioHeat: 10, maxPositionsPerSymbol: 2,
    minRR: 1.5, allowSameDirectionStacking: false,
    maxDailyDrawdown: 3, maxDrawdown: 15,
    standaloneMultiplier: 0.5,
    conflictThresholdRaise: 4, conflictBlockAt: 6,
  },
  entry: { cooldownMinutes: 30, scanIntervalMinutes: 15, pendingZoneOrders: true, confirmationMethod: "choch" },
  exit: { slMethod: "structure", slBufferPips: 2, tpMethod: "rr", tpRRRatio: 2 },
  instruments: { enabled: null },
  sessions: { filter: ["london", "newyork"] },
  protection: { maxDailyLoss: 500, maxConsecutiveLosses: 3, circuitBreakerPct: 20 },
  account: { startingBalance: 10000 },
  management: { trailingStopEnabled: false, breakEvenEnabled: false, partialTPEnabled: false, fridayCloseEnabled: true, fridayCloseHour: 20 },
};

const PRESETS: Record<string, { config: any; tradingStyle: "swing_trader" | "day_trader" | "scalper"; description: string }> = {
  conservative: {
    tradingStyle: "swing_trader",
    description: "Low frequency, high conviction. Wider stops, longer holds.",
    config: {
      ...JSON.parse(JSON.stringify(BASE_CONFIG)),
      tradingStyle: { mode: "swing_trader" },
      strategy: { ...BASE_CONFIG.strategy, confluenceThreshold: 65, tier1GateEnabled: true, minTier1Factors: 3 },
      risk: { ...BASE_CONFIG.risk, riskPerTrade: 0.5, maxConcurrentTrades: 3, maxDailyDrawdown: 2, maxDrawdown: 10, minRR: 2.5, conflictThresholdRaise: 4, conflictBlockAt: 6 },
      entry: { ...BASE_CONFIG.entry, cooldownMinutes: 60, scanIntervalMinutes: 30 },
      exit: { slMethod: "structure", slBufferPips: 5, tpMethod: "rr", tpRRRatio: 3 },
      sessions: { filter: ["london", "newyork"] },
      management: { ...BASE_CONFIG.management, trailingStopEnabled: true, trailingStopPips: 30, breakEvenEnabled: true, breakEvenTriggerPips: 20 },
    },
  },
  moderate: {
    tradingStyle: "day_trader",
    description: "Balanced approach. Standard SMC setups with moderate risk.",
    config: {
      ...JSON.parse(JSON.stringify(BASE_CONFIG)),
      tradingStyle: { mode: "day_trader" },
      strategy: { ...BASE_CONFIG.strategy, confluenceThreshold: 55, tier1GateEnabled: true, minTier1Factors: 2 },
      risk: { ...BASE_CONFIG.risk, riskPerTrade: 1, maxConcurrentTrades: 5, maxDailyDrawdown: 3, maxDrawdown: 15, minRR: 1.5, conflictThresholdRaise: 4, conflictBlockAt: 6 },
      entry: { ...BASE_CONFIG.entry, cooldownMinutes: 30, scanIntervalMinutes: 15 },
      exit: { slMethod: "structure", slBufferPips: 2, tpMethod: "rr", tpRRRatio: 2 },
      sessions: { filter: ["london", "newyork"] },
      management: { ...BASE_CONFIG.management, trailingStopEnabled: false, breakEvenEnabled: false },
    },
  },
  aggressive: {
    tradingStyle: "scalper",
    description: "High frequency, lower conviction threshold. Tight stops, quick exits.",
    config: {
      ...JSON.parse(JSON.stringify(BASE_CONFIG)),
      tradingStyle: { mode: "scalper" },
      strategy: { ...BASE_CONFIG.strategy, confluenceThreshold: 40, tier1GateEnabled: true, minTier1Factors: 1 },
      risk: { ...BASE_CONFIG.risk, riskPerTrade: 2, maxConcurrentTrades: 8, maxDailyDrawdown: 5, maxDrawdown: 20, minRR: 1.0, conflictThresholdRaise: 4, conflictBlockAt: 6 },
      entry: { ...BASE_CONFIG.entry, cooldownMinutes: 10, scanIntervalMinutes: 5 },
      exit: { slMethod: "atr", slBufferPips: 1, tpMethod: "rr", tpRRRatio: 1.5 },
      sessions: { filter: ["asian", "london", "newyork"] },
      management: { ...BASE_CONFIG.management, trailingStopEnabled: true, trailingStopPips: 10, breakEvenEnabled: true, breakEvenTriggerPips: 8, partialTPEnabled: true, partialTPPercent: 50, partialTPLevel: 1 },
    },
  },
};

// ─── Component ────────────────────────────────────────────────────────────────
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
  // Map legacy tab IDs to new ones
  const resolvedDefaultTab = defaultTab ? (TAB_ID_MAP[defaultTab] || defaultTab) : "scan";
  const [activeTab, setActiveTab] = useState(resolvedDefaultTab);
  const [search, setSearch] = useState(defaultSearch || "");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rawConfig && open) setConfig(JSON.parse(JSON.stringify(rawConfig)));
  }, [rawConfig, open]);

  useEffect(() => {
    if (open) {
      setSearch(defaultSearch || "");
      const tab = defaultTab ? (TAB_ID_MAP[defaultTab] || defaultTab) : "scan";
      setActiveTab(tab);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, defaultTab, defaultSearch]);

  // ─── Mutations ───────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: () => {
      if (!config) return Promise.reject(new Error("Config not loaded yet"));
      const clean = JSON.parse(JSON.stringify(config));
      if (clean?.risk) {
        if ("maxOpenPositions" in clean.risk) {
          if (clean.risk.maxConcurrentTrades == null) {
            clean.risk.maxConcurrentTrades = clean.risk.maxOpenPositions;
          }
          delete clean.risk.maxOpenPositions;
        }
      }
      return botConfigApi.update(clean, connectionId);
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
      if (data && typeof data === "object") {
        setConfig(JSON.parse(JSON.stringify(data)));
      }
      toast.success("Config reset to defaults");
    },
    onError: (e: any) => { toast.error(e?.message || "Failed to reset config"); },
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

  // ─── Custom Presets ───────────────────────────────────────────────
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

  // ─── Active Preset Detection ────────────────────────────────────
  const deepMatch = (saved: any, preset: any): boolean => {
    if (preset === saved) return true;
    if (preset == null || saved == null) return preset == saved;
    if (typeof preset !== typeof saved) return false;
    if (typeof preset !== "object") return String(preset) === String(saved);
    if (Array.isArray(preset)) {
      if (!Array.isArray(saved) || preset.length !== saved.length) return false;
      return preset.every((v: any, i: number) => deepMatch(saved[i], v));
    }
    for (const key of Object.keys(preset)) {
      if (!deepMatch(saved[key], preset[key])) return false;
    }
    return true;
  };

  const isPresetActive = (presetConfig: any): boolean => {
    if (!rawConfig || !presetConfig) return false;
    const sections = ["strategy", "risk", "entry", "exit", "instruments", "sessions", "protection"];
    for (const section of sections) {
      if (!presetConfig[section]) continue;
      if (!deepMatch(rawConfig[section], presetConfig[section])) return false;
    }
    return true;
  };

  // ─── Export / Import ─────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    if (!config) return;
    const bundle = {
      _meta: { version: 1, exportedAt: new Date().toISOString(), source: "smc-trading-bot", connectionId: connectionId || null },
      config,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = connectionId ? `-${connectionName || connectionId}` : "-global";
    a.download = `smc-bot-config${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Config exported");
  };

  const handleImportClick = () => { fileInputRef.current?.click(); };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        const configPayload = parsed.config || parsed;
        const meta = parsed._meta;
        if (!configPayload || typeof configPayload !== "object") {
          toast.error("Invalid config file", { description: "No valid configuration found in the file." });
          return;
        }
        const knownSections = ["strategy", "risk", "entry", "exit", "instruments", "sessions", "notifications", "protection", "account"];
        const foundSections = knownSections.filter(s => s in configPayload);
        if (foundSections.length === 0) {
          toast.error("Invalid config file", { description: "File does not contain any recognized config sections." });
          return;
        }
        const exportInfo = meta?.exportedAt ? ` (exported ${meta.exportedAt.slice(0, 10)})` : "";
        if (confirm(`Import config${exportInfo}?\n\nThis will load ${foundSections.length} sections into the editor.\nYou still need to click "Save Config" to apply.`)) {
          setConfig(JSON.parse(JSON.stringify(configPayload)));
          toast.success(`Config loaded from file`, { description: `${foundSections.length} sections imported. Click Save to apply.` });
        }
      } catch {
        toast.error("Invalid file", { description: "Could not parse JSON. Make sure this is a valid config file." });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const applyPresetConfig = (presetConfig: any, label: string) => {
    if (!config) return;
    setConfig(JSON.parse(JSON.stringify(presetConfig)));
    toast.info(`Applied preset: ${label}`);
  };

  // ─── Tabs & Search ──────────────────────────────────────────────
  if (!open) return null;

  const tabs = [
    { id: "scan", label: "SCAN", icon: Globe },
    { id: "enter", label: "ENTER", icon: Target },
    { id: "exit", label: "EXIT", icon: Flag },
    { id: "risk", label: "RISK", icon: Shield },
  ];

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

  const effectiveActiveTab =
    query && filteredTabs.length > 0 && !matchedTabIds.has(activeTab)
      ? filteredTabs[0].id
      : activeTab;

  // ─── Render ─────────────────────────────────────────────────────
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
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1" onClick={handleExport} title="Export config as JSON file">
              <Download className="h-3 w-3" /> Export
            </Button>
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1" onClick={handleImportClick} title="Import config from JSON file">
              <Upload className="h-3 w-3" /> Import
            </Button>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileChange} />
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => resetMut.mutate()}>Reset Defaults</Button>
            <Button variant="outline" size="sm" className="text-xs gap-1" onClick={() => { setPresetName(""); setPresetDescription(""); setShowSavePresetDialog(true); }}>
              <Bookmark className="h-3 w-3" /> Save as Preset
            </Button>
            <Button size="sm" className="text-xs" onClick={() => saveMut.mutate()}>Save Config</Button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground ml-2"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Save Preset Dialog */}
        <Dialog open={showSavePresetDialog} onOpenChange={setShowSavePresetDialog}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Save as Preset</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Save the current configuration as a reusable preset.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium">Name</label>
                <Input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="My Config" className="h-8 text-sm mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium">Description (optional)</label>
                <Textarea value={presetDescription} onChange={e => setPresetDescription(e.target.value)} placeholder="What makes this preset special..." className="text-sm mt-1 h-16 resize-none" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setShowSavePresetDialog(false)}>Cancel</Button>
              <Button size="sm" className="text-xs" onClick={() => savePresetMut.mutate()} disabled={!presetName.trim() || savePresetMut.isPending}>
                {savePresetMut.isPending ? "Saving..." : "Save Preset"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Preset Confirm Dialog */}
        <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
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

        {/* Presets Bar */}
        {customPresets.length > 0 && (
          <div className="px-6 py-3 border-b border-border bg-secondary/30">
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
                    <div
                      key={cp.id}
                      className={`group relative p-2.5 border text-left transition-colors cursor-pointer ${isPresetActive(cp.config) ? "border-primary bg-primary/5" : "border-border hover:border-border/80"}`}
                      onClick={() => applyPresetConfig(cp.config, cp.name)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium truncate">{cp.name}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(cp.id); }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      {cp.description && <p className="text-[9px] text-muted-foreground mt-0.5 line-clamp-1">{cp.description}</p>}
                      <p className="text-[9px] text-muted-foreground/60 mt-1">{formatBrokerTime(cp.updated_at)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Trading Style Quick-Select */}
        {effectiveActiveTab === "scan" && config && (
          <div className="px-6 py-2.5 border-b border-border bg-secondary/20">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-2">Quick Setup</p>
            <div className="grid grid-cols-3 gap-2">
              {(["scalper", "day_trader", "swing_trader"] as TradingStyleMode[]).map(mode => {
                const isActive = (config.tradingStyle?.mode || "day_trader") === mode;
                const meta = STYLE_META[mode];
                const params = STYLE_PARAMS[mode];
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      const presetKey = mode === "scalper" ? "aggressive" : mode === "day_trader" ? "moderate" : "conservative";
                      applyPresetConfig(PRESETS[presetKey].config, `${meta.icon} ${meta.label}`);
                    }}
                    className={`p-2.5 border text-left transition-colors ${isActive ? "border-primary bg-primary/5" : "border-border hover:border-border/80"}`}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-sm">{meta.icon}</span>
                      <span className="text-[10px] font-bold">{meta.label}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-2 text-[8px] text-muted-foreground">
                      <span>TF: <strong className="text-foreground">{params.entryTimeframe}</strong></span>
                      <span>TP: <strong className="text-foreground">{params.tpRatio}:1</strong></span>
                      <span>Thr: <strong className="text-foreground">{params.confluenceThreshold}%</strong></span>
                      <span>Hold: <strong className="text-foreground">{params.maxHoldHours === 0 ? "∞" : `${params.maxHoldHours}h`}</strong></span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Search Bar */}
        <div className="px-6 py-2.5 border-b border-border bg-background/40">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search settings..."
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
                  {effectiveActiveTab === "scan" && <ScanTab config={config} setConfig={setConfig} updateField={updateField} />}
                  {effectiveActiveTab === "enter" && <EnterTab config={config} setConfig={setConfig} updateField={updateField} />}
                  {effectiveActiveTab === "exit" && <ExitTab config={config} setConfig={setConfig} updateField={updateField} />}
                  {effectiveActiveTab === "risk" && <RiskTab config={config} setConfig={setConfig} updateField={updateField} />}
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
