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
import { X, Zap, Shield, TrendingUp, Clock, Globe, ShieldAlert, LogIn, LogOut, BarChart3, Gauge, Search, SlidersHorizontal, RotateCcw, Save, Trash2, FolderOpen, ChevronDown, ChevronUp, Bookmark } from "lucide-react";
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
  { tab: "strategy", label: "Min Factor Count", keywords: ["factor", "factors", "count", "breadth"] },
  { tab: "strategy", label: "Order Blocks", keywords: ["ob", "order block", "smc", "institutional"] },
  { tab: "strategy", label: "Fair Value Gaps", keywords: ["fvg", "imbalance", "gap"] },
  { tab: "strategy", label: "Liquidity Sweeps", keywords: ["liquidity", "sweep", "pool"] },
  { tab: "strategy", label: "Structure Breaks", keywords: ["bos", "choch", "structure", "break"] },
  { tab: "strategy", label: "Displacement Detection", keywords: ["displacement", "candle"] },
  { tab: "strategy", label: "Breaker Blocks", keywords: ["breaker", "flip", "failed ob"] },
  { tab: "strategy", label: "Unicorn Model", keywords: ["unicorn", "breaker", "fvg overlap"] },
  { tab: "strategy", label: "Silver Bullet Windows", keywords: ["silver bullet", "ict", "window", "macro"] },
  { tab: "strategy", label: "ICT Macro Windows", keywords: ["macro", "ict", "reprice"] },
  { tab: "strategy", label: "SMT Divergence", keywords: ["smt", "divergence", "correlated"] },
  { tab: "strategy", label: "Volume Profile", keywords: ["volume", "profile", "poc", "hvn", "lvn", "tpo", "value area"] },
  { tab: "strategy", label: "Trend Direction", keywords: ["trend", "direction", "entry", "timeframe", "higher highs", "lower lows"] },
  { tab: "strategy", label: "Daily Bias", keywords: ["daily", "bias", "htf", "higher timeframe", "bullish", "bearish"] },
  { tab: "strategy", label: "AMD Phase Detection", keywords: ["amd", "accumulation", "manipulation", "distribution", "phase"] },
  { tab: "strategy", label: "FOTSI Currency Strength", keywords: ["fotsi", "currency strength", "tsi", "28 pair", "overbought", "oversold", "veto"] },
  { tab: "strategy", label: "Require HTF Bias Alignment", keywords: ["htf", "bias", "higher timeframe", "alignment"] },
  { tab: "strategy", label: "HTF Bias Hard Veto", keywords: ["htf", "veto", "hard", "block"] },
  { tab: "strategy", label: "Only Buy in Discount", keywords: ["premium", "discount", "long", "buy"] },
  { tab: "strategy", label: "Only Sell in Premium", keywords: ["premium", "discount", "short", "sell"] },
  { tab: "strategy", label: "Regime Scoring", keywords: ["regime", "market regime", "trend", "range", "choppy", "alignment", "bonus", "penalty"] },
  { tab: "strategy", label: "Regime Strength", keywords: ["regime", "strength", "multiplier", "scale", "aggressive", "subtle"] },
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
  { tab: "risk", label: "Fixed Lot Size", keywords: ["lot", "fixed", "size", "volume"] },
  // Entry / Exit
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
  // Instruments
  { tab: "instruments", label: "Instruments", keywords: ["instruments", "pairs", "symbols", "forex", "crypto", "indices"] },
  { tab: "instruments", label: "Enable Spread Filter", keywords: ["spread", "filter", "broker"] },
  { tab: "instruments", label: "Volatility Filter (ATR)", keywords: ["atr", "volatility", "filter", "min", "max"] },
  { tab: "instruments", label: "Max Spread (pips)", keywords: ["spread", "max", "pips"] },
  // Sessions
  { tab: "sessions", label: "Trading Sessions", keywords: ["session", "asian", "london", "new york", "sydney"] },
  { tab: "sessions", label: "Kill Zone Only Trading", keywords: ["kill zone", "killzone", "high volume"] },
  { tab: "sessions", label: "Enable News Filter", keywords: ["news", "nfp", "fomc", "cpi", "economic", "filter"] },
  { tab: "sessions", label: "Pause Window (minutes)", keywords: ["news", "pause", "window", "minutes"] },
  // Protection
  { tab: "protection", label: "Max Daily Loss ($)", keywords: ["daily loss", "kill switch", "dollar", "limit"] },
  { tab: "protection", label: "Max Consecutive Losses", keywords: ["consecutive", "losses", "streak", "pause"] },
  { tab: "protection", label: "Equity Circuit Breaker (%)", keywords: ["circuit breaker", "equity", "emergency", "stop"] },
  // Factor Weights
  { tab: "factorWeights", label: "Factor Weights", keywords: ["factor", "weight", "weights", "importance", "scoring", "tune", "ai", "advisor"] },
  // Opening Range
  { tab: "openingRange", label: "Enable Opening Range", keywords: ["opening range", "or", "master"] },
  { tab: "openingRange", label: "Candle Count", keywords: ["candle", "count", "or", "range"] },
  { tab: "openingRange", label: "Daily Bias from OR", keywords: ["bias", "or", "daily"] },
  { tab: "openingRange", label: "Judas Swing Detection", keywords: ["judas", "swing", "fake", "sweep"] },
  { tab: "openingRange", label: "OR Key Levels", keywords: ["key levels", "or", "support", "resistance"] },
  { tab: "openingRange", label: "Premium/Discount from OR", keywords: ["premium", "discount", "or"] },
  { tab: "openingRange", label: "Wait for OR Completion", keywords: ["wait", "completion", "or"] },
];

const HighlightContext = createContext<Set<string>>(new Set());


// ─── Full Config Presets ─────────────────────────────────────────────────
// Each preset is a complete config snapshot. Applying one replaces the entire config.
const BASE_CONFIG = {
  strategy: {
    enableBOS: true, enableCHoCH: true, enableOB: true, enableFVG: true, enableLiquiditySweep: true,
    minConfluenceScore: 6.0, minFactorCount: 0, htfBiasRequired: true, obLookbackCandles: 20,
    fvgMinSizePips: 5, fvgOnlyUnfilled: true, structureLookback: 50,
    liquidityPoolMinTouches: 2, premiumDiscountEnabled: true, onlyBuyInDiscount: true, onlySellInPremium: true,
    regimeScoringEnabled: true, regimeScoringStrength: 1.0,
  },
  risk: {
    riskPerTrade: 1, maxDailyLoss: 5, maxDrawdown: 15, positionSizingMethod: "percent_risk",
    fixedLotSize: 0.1, maxOpenPositions: 5, maxPositionsPerSymbol: 2, allowSameDirectionStacking: false, maxPortfolioHeat: 10, minRiskReward: 1.5,
  },
  entry: {
    defaultOrderType: "market", entryRefinement: false, refinementTimeframe: "5m",
    trailingEntry: false, trailingEntryPips: 5, maxSlippagePips: 2,
    pyramidingEnabled: false, maxPyramidAdds: 1, closeOnReverse: true, cooldownMinutes: 15,
  },
  exit: {
    stopLossMethod: "structure", fixedSLPips: 25, slATRMultiple: 1.5, slATRPeriod: 14,
    takeProfitMethod: "rr_ratio", fixedTPPips: 50, tpRRRatio: 2.0, tpATRMultiple: 2.0,
    trailingStopEnabled: false, trailingStopPips: 15, trailingStopActivation: "after_1r",
    partialTPEnabled: false, partialTPPercent: 50, partialTPLevel: 1.0,
    breakEvenEnabled: true, breakEvenTriggerPips: 20,
    timeBasedExitEnabled: false, maxHoldHours: 24, endOfSessionClose: false,
  },
  instruments: {
    allowedInstruments: {
      "EUR/USD": true, "GBP/USD": true, "USD/JPY": true, "GBP/JPY": true,
      "AUD/USD": true, "USD/CAD": true, "EUR/GBP": false, "NZD/USD": false,
      "XAU/USD": true, "XAG/USD": false, "BTC/USD": false, "ETH/USD": false,
    },
    spreadFilterEnabled: true, maxSpreadPips: 3, volatilityFilterEnabled: false,
    minATR: 0, maxATR: 999, correlationFilterEnabled: false, maxCorrelation: 0.8,
  },
  sessions: {
    filter: ["london", "newyork"],
    activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true },
    newsFilterEnabled: true, newsFilterPauseMinutes: 30,
  },
  notifications: {
    notifyOnTrade: true, notifyOnSignal: true, notifyOnError: true,
    notifyDailySummary: true, notifyChannel: "in_app",
  },
  protection: {
    dailyProfitTarget: 0, dailyLossLimit: 0, cumulativeProfitTarget: 0,
    cumulativeLossLimit: 0, haltOnDailyTarget: false, haltOnDailyLoss: true,
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
      ...BASE_CONFIG,
      strategy: { ...BASE_CONFIG.strategy, minConfluenceScore: 6.5, minFactorCount: 7, regimeScoringStrength: 1.5 },
      risk: { ...BASE_CONFIG.risk, riskPerTrade: 0.5, maxDailyLoss: 2, maxOpenPositions: 2, minRiskReward: 2.0 },
      entry: { ...BASE_CONFIG.entry, cooldownMinutes: 30 },
      exit: { ...BASE_CONFIG.exit, tpRRRatio: 3.0, trailingStopEnabled: true, trailingStopPips: 20, breakEvenEnabled: true, breakEvenTriggerPips: 15, maxHoldHours: 120 },
      tradingStyle: { mode: "swing_trader" },
    },
  },
  moderate: {
    description: "Balanced day trading",
    tradingStyle: "day_trader" as const,
    config: {
      ...BASE_CONFIG,
      strategy: { ...BASE_CONFIG.strategy, minConfluenceScore: 5.5, minFactorCount: 5 },
      risk: { ...BASE_CONFIG.risk, riskPerTrade: 1, maxDailyLoss: 3, maxOpenPositions: 4, minRiskReward: 1.5 },
      exit: { ...BASE_CONFIG.exit, tpRRRatio: 2.0, trailingStopEnabled: false, breakEvenEnabled: true, breakEvenTriggerPips: 20, maxHoldHours: 24 },
      tradingStyle: { mode: "day_trader" },
    },
  },
  aggressive: {
    description: "High frequency scalping",
    tradingStyle: "scalper" as const,
    config: {
      ...BASE_CONFIG,
      strategy: { ...BASE_CONFIG.strategy, minConfluenceScore: 4.0, minFactorCount: 3, regimeScoringEnabled: false },
      risk: { ...BASE_CONFIG.risk, riskPerTrade: 2, maxDailyLoss: 5, maxOpenPositions: 6, minRiskReward: 1.0 },
      entry: { ...BASE_CONFIG.entry, cooldownMinutes: 5 },
      exit: { ...BASE_CONFIG.exit, tpRRRatio: 1.5, trailingStopEnabled: false, breakEvenEnabled: false, maxHoldHours: 1 },
      sessions: { ...BASE_CONFIG.sessions, filter: ["asian", "london", "newyork", "sydney"] },
      tradingStyle: { mode: "scalper" },
    },
  },
};

interface BotConfigModalProps {
  open: boolean;
  onClose: () => void;
  connectionId?: string;
  connectionName?: string;
}

export function BotConfigModal({ open, onClose, connectionId, connectionName }: BotConfigModalProps) {
  const queryClient = useQueryClient();
  const queryKey = connectionId ? ["bot-config", connectionId] : ["bot-config"];
  const { data: rawConfig } = useQuery({ queryKey, queryFn: () => botConfigApi.get(connectionId), enabled: open });
  const [config, setConfig] = useState<any>(null);
  const [activeTab, setActiveTab] = useState("strategy");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rawConfig && open) setConfig(JSON.parse(JSON.stringify(rawConfig)));
  }, [rawConfig, open]);

  // Reset search + autofocus when modal opens
  useEffect(() => {
    if (open) {
      setSearch("");
      // Defer to next tick so input is mounted
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

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
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); setConfig(null); toast.success("Config reset"); },
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
    { id: "factorWeights", label: "Factor Weights", icon: SlidersHorizontal },
    { id: "openingRange", label: "Opening Range", icon: BarChart3 },
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
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-bold">{connectionName ? `Config: ${connectionName}` : "Global Bot Configuration"}</h2>
            {connectionName && <p className="text-[10px] text-muted-foreground">Settings specific to this broker connection</p>}
          </div>
          <div className="flex items-center gap-2">
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
        <div className="px-6 py-3 border-b border-border bg-secondary/30">
          {/* Quick Presets (full config snapshots) */}
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1"><Zap className="h-3 w-3 text-primary" /> Quick Presets</p>
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(PRESETS).map(([key, preset]) => (
              <button key={key} onClick={() => {
                applyPresetConfig(preset.config, `${key.charAt(0).toUpperCase() + key.slice(1)} → ${STYLE_META[preset.tradingStyle].icon} ${STYLE_META[preset.tradingStyle].label}`);
              }} className="p-3 border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors text-left">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold capitalize">{key}</p>
                  <span className="text-[10px] text-muted-foreground">{STYLE_META[preset.tradingStyle].icon} {STYLE_META[preset.tradingStyle].label}</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">{preset.description}</p>
              </button>
            ))}
          </div>

          {/* My Presets */}
          {customPresets.length > 0 && (
            <div className="mt-3">
              <button
                onClick={() => setShowMyPresets(!showMyPresets)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors w-full"
              >
                <FolderOpen className="h-3 w-3 text-primary" />
                My Presets ({customPresets.length})
                {showMyPresets ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
              </button>
              {showMyPresets && (
                <div className="grid grid-cols-2 gap-2 mt-2">
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
          )}
        </div>

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
        <div className="flex flex-1 min-h-0">
          {/* Vertical Tab Nav */}
          <div className="w-44 border-r border-border py-2 shrink-0 overflow-y-auto">
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
          <div className="flex-1 overflow-y-auto p-6">
            <HighlightContext.Provider value={matchedLabels}>
            {config && filteredTabs.length > 0 && (
              <>
                {effectiveActiveTab === "tradingStyle" && (
                  <div className="space-y-5">
                    <SectionHeader title="Trading Style" description="Choose how the bot trades — this overrides entry timeframe, TP/SL ratios, and hold duration" />
                    <div className="grid grid-cols-3 gap-3">
                      {(["scalper", "day_trader", "swing_trader"] as TradingStyleMode[]).map(mode => {
                        const isActive = (config.tradingStyle?.mode || "day_trader") === mode;
                        const meta = STYLE_META[mode];
                        const params = STYLE_PARAMS[mode];
                        return (
                          <button
                            key={mode}
                            onClick={() => updateField("tradingStyle", "mode", mode)}
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
                              <span>Min Score: <strong className="text-foreground">{params.minConfluence}</strong></span>
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
                      Style sets default parameters. You can still fine-tune individual settings in the other tabs — manual overrides take precedence.
                    </p>
                  </div>
                )}

                {effectiveActiveTab === "strategy" && (
                  <div className="space-y-5">
                    <SectionHeader title="Strategy Settings" description="Configure how the bot identifies trade setups" />
                    <FieldGroup label="Auto Scan Interval" description="Scan frequency is controlled by the server cron — this UI control is informational only">
                      <div className="text-xs text-muted-foreground italic px-1">
                        Scans run automatically on the server schedule. Manual scans always run on demand.
                      </div>
                    </FieldGroup>
                    <FieldGroup label="Confluence Threshold" description="Minimum weighted score (1-10) required to consider a trade setup valid">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.confluenceThreshold ?? 5]} onValueChange={v => updateField('strategy', 'confluenceThreshold', v[0])} min={1} max={10} step={0.5} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-10 text-right">{(config.strategy?.confluenceThreshold ?? 5).toFixed(1)}</span>
                      </div>
                    </FieldGroup>
                    <FieldGroup label="Min Factor Count" description="Require at least N of 20 factors to align (in addition to score threshold). 0 = off. Score is weighted but count enforces breadth.">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.minFactorCount ?? 0]} onValueChange={v => updateField('strategy', 'minFactorCount', v[0])} min={0} max={20} step={1} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-10 text-right">{config.strategy?.minFactorCount ?? 0}/20</span>
                      </div>
                      {(config.strategy?.minFactorCount ?? 0) > 0 && (
                        <p className="text-[10px] text-muted-foreground mt-1.5">
                          Gate: ≥ {(config.strategy?.confluenceThreshold ?? 5).toFixed(1)}/10 score AND ≥ {config.strategy?.minFactorCount}/20 factors. Tip: During kill zones, 10–14/20 factors typically score 6.0–8.5. Outside kill zones, expect 6–9 factors and 4.0–6.0 scores.
                        </p>
                      )}
                    </FieldGroup>
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
                      <ToggleField label="Volume Profile" description="TPO-based volume profile: POC (Point of Control), HVN/LVN detection. +1.5 pts when price at key volume node" checked={config.strategy?.useVolumeProfile ?? true} onChange={v => updateField('strategy', 'useVolumeProfile', v)} />
                      <ToggleField label="Trend Direction" description="Entry timeframe trend via HH/HL (bullish) or LH/LL (bearish). +1.5 pts when trend aligns with trade direction" checked={config.strategy?.useTrendDirection ?? true} onChange={v => updateField('strategy', 'useTrendDirection', v)} />
                      <ToggleField label="Daily Bias" description="Higher timeframe daily bias confirmation. +1.5 pts when daily candle structure aligns with trade direction" checked={config.strategy?.useDailyBias ?? true} onChange={v => updateField('strategy', 'useDailyBias', v)} />
                      <ToggleField label="AMD Phase Detection" description="Accumulation→Manipulation→Distribution. +1.0 pt when bias-aligned phase detected. Power of 3 combo bonus (+1.0) when AMD + Sweep/Judas + Trend all align" checked={config.strategy?.useAMD ?? true} onChange={v => updateField('strategy', 'useAMD', v)} />
                      <ToggleField label="FOTSI Currency Strength" description="Scores trades by currency flow (+1.5 pts when buying strong vs weak). Blocks trades when TSI exceeds +50 (overbought) or -50 (oversold) — prevents buying exhausted currencies" checked={config.strategy?.useFOTSI ?? true} onChange={v => updateField('strategy', 'useFOTSI', v)} />
                    </div>
                    <ToggleField label="Require HTF Bias Alignment" description="Only trade in the direction of higher timeframe bias" checked={config.strategy?.requireHTFBias ?? true} onChange={v => updateField('strategy', 'requireHTFBias', v)} />
                    <ToggleField label="HTF Bias Hard Veto" description="Block longs unless daily is bullish, shorts unless daily is bearish (no ranging exception, no score override)" checked={config.strategy?.htfBiasHardVeto ?? false} onChange={v => updateField('strategy', 'htfBiasHardVeto', v)} />
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
                            <div><span className="text-emerald-500 font-medium">Aligned:</span> Trend setup in trending market → +0.25 to +0.5 bonus</div>
                            <div><span className="text-red-500 font-medium">Mismatched:</span> Trend setup in choppy market → -0.75 to -1.5 penalty</div>
                            <div className="text-muted-foreground/70">Range setups get the inverse. All values scaled by the multiplier above.</div>
                          </div>
                        </FieldGroup>
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
                        <p className="text-[10px] text-muted-foreground italic">Lot size scales inversely with ATR — smaller positions in volatile markets, larger in calm markets. Uses Risk% as the base.</p>
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
                      <FieldGroup label="Max Daily Drawdown" description="Halt trading if daily loss exceeds this. Toggle between % and $ input.">
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
                        <FieldGroup label="Min R:R Ratio" description="Minimum risk-to-reward ratio">
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
                      <FieldGroup label="Max Total Drawdown" description="Kill switch — stops all trading if total drawdown exceeds this. Toggle between % and $.">
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
                        <FieldGroup label="R:R Ratio" description="TP = SL distance × this ratio">
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
                      <div className="bg-blue-500/5 border border-blue-500/20 p-3">
                        <p className="text-[10px] text-blue-400 font-medium">Activation Safety</p>
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
                            <p className="text-[9px] text-muted-foreground italic">Only fires once per position. After activation, SL sits at entry + 1 pip to guarantee a risk-free trade.</p>
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
                        <ToggleField label="Time-Based Exit" description="Auto-tighten SL or close after a maximum hold duration" checked={(config.exit?.timeBasedExitEnabled ?? (config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 0) > 0)} onChange={v => { updateField('exit', 'timeBasedExitEnabled', v); if (!v) { updateField('exit', 'timeExitHours', 0); updateField('exit', 'maxHoldHours', 0); } }} />
                        {(config.exit?.timeBasedExitEnabled || (config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 0) > 0) && (
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
                      <SectionHeader title="Spread Filter" description="Skip broker execution when the live bid/ask spread is too wide" />
                      <ToggleField label="Enable Spread Filter" description="Block live trades when spread exceeds the maximum" checked={config.instruments?.spreadFilterEnabled ?? true} onChange={v => updateField('instruments', 'spreadFilterEnabled', v)} />
                      <FieldGroup label="Max Spread (pips)" description="Maximum allowed spread before skipping broker execution">
                        <div className="flex items-center gap-4">
                          <Slider value={[config.instruments?.maxSpreadPips ?? 3]} onValueChange={v => updateField('instruments', 'maxSpreadPips', v[0])} min={0.5} max={20} step={0.5} className="flex-1" disabled={!(config.instruments?.spreadFilterEnabled ?? true)} />
                          <span className="text-sm font-mono font-bold w-12 text-right">{config.instruments?.maxSpreadPips ?? 3}</span>
                        </div>
                      </FieldGroup>
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
                        { id: "sydney", label: "Sydney Session", desc: "5:00 PM – 2:00 AM ET (FX week open)" },
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
                                ...(sessions_cfg.sydneyEnabled ? ["sydney"] : []),
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
                      <FieldGroup label="Max Daily Loss ($)" description="Hard dollar limit — triggers kill switch">
                        <Input type="number" value={config.protection?.maxDailyLoss ?? 500} onChange={e => updateField('protection', 'maxDailyLoss', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="Max Consecutive Losses" description="Pause after N consecutive losing trades">
                        <Input type="number" value={config.protection?.maxConsecutiveLosses ?? 3} onChange={e => updateField('protection', 'maxConsecutiveLosses', parseFloat(e.target.value) || 0)} min={1} max={10} className="h-9 text-sm" />
                      </FieldGroup>
                    </div>
                    <FieldGroup label="Equity Circuit Breaker (%)" description="Emergency stop if equity drops below this percentage of peak">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.protection?.circuitBreakerPct ?? 20]} onValueChange={v => updateField('protection', 'circuitBreakerPct', v[0])} min={5} max={50} step={1} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-destructive w-10 text-right">{config.protection?.circuitBreakerPct ?? 20}%</span>
                      </div>
                    </FieldGroup>
                  </div>
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
const FACTOR_WEIGHT_DEFS: { key: string; name: string; defaultWeight: number; group: string; description: string }[] = [
  { key: "marketStructure", name: "Market Structure", defaultWeight: 1.5, group: "Market Structure", description: "BOS/CHoCH detection" },
  { key: "trendDirection", name: "Trend Direction", defaultWeight: 1.5, group: "Market Structure", description: "Entry TF trend alignment" },
  { key: "orderBlock", name: "Order Block", defaultWeight: 2.0, group: "Order Flow Zones", description: "Institutional order blocks" },
  { key: "fairValueGap", name: "Fair Value Gap", defaultWeight: 2.0, group: "Order Flow Zones", description: "FVG imbalances" },
  { key: "breakerBlock", name: "Breaker Block", defaultWeight: 1.0, group: "Order Flow Zones", description: "Failed OB flip zones" },
  { key: "unicornModel", name: "Unicorn Model", defaultWeight: 1.5, group: "Order Flow Zones", description: "Breaker + FVG overlap" },
  { key: "premiumDiscountFib", name: "Premium/Discount & Fib", defaultWeight: 2.0, group: "Premium/Discount", description: "Fibonacci OTE zones" },
  { key: "pdPwLevels", name: "PD/PW Levels", defaultWeight: 1.0, group: "Premium/Discount", description: "Previous day/week levels" },
  { key: "sessionKillZone", name: "Session/Kill Zone", defaultWeight: 1.0, group: "Timing", description: "Kill zone timing filter" },
  { key: "silverBullet", name: "Silver Bullet", defaultWeight: 1.0, group: "Timing", description: "ICT macro windows" },
  { key: "macroWindow", name: "Macro Window", defaultWeight: 1.0, group: "Timing", description: "Institutional reprice windows" },
  { key: "judasSwing", name: "Judas Swing", defaultWeight: 0.5, group: "Price Action", description: "Fake breakout confirmation" },
  { key: "reversalCandle", name: "Reversal Candle", defaultWeight: 0.5, group: "Price Action", description: "Reversal at key levels" },
  { key: "liquiditySweep", name: "Liquidity Sweep", defaultWeight: 1.0, group: "Price Action", description: "Liquidity pool sweeps" },
  { key: "displacement", name: "Displacement", defaultWeight: 1.0, group: "Price Action", description: "Strong institutional candles" },
  { key: "amdPhase", name: "AMD Phase", defaultWeight: 1.0, group: "AMD / Power of 3", description: "Accumulation→Manipulation→Distribution" },
  { key: "smtDivergence", name: "SMT Divergence", defaultWeight: 1.0, group: "Macro Confirmation", description: "Correlated pair divergence" },
  { key: "currencyStrength", name: "Currency Strength", defaultWeight: 1.5, group: "Macro Confirmation", description: "FOTSI alignment" },
  { key: "volumeProfile", name: "Volume Profile", defaultWeight: 1.5, group: "Volume Profile", description: "TPO-based POC/HVN/LVN" },
  { key: "dailyBias", name: "Daily Bias", defaultWeight: 1.5, group: "Daily Bias", description: "HTF daily trend alignment" },
];

const FACTOR_GROUPS = [...new Set(FACTOR_WEIGHT_DEFS.map(f => f.group))];

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

      <p className="text-[10px] text-muted-foreground">
        Weights scale each factor's score proportionally. Default values match the hardcoded scoring model.
        Increasing a weight amplifies that factor's contribution; decreasing it reduces it. Set to 0 to effectively disable a factor's score contribution.
      </p>

      {FACTOR_GROUPS.map(group => {
        const groupFactors = FACTOR_WEIGHT_DEFS.filter(f => f.group === group);
        return (
          <div key={group} className="border border-border p-4 space-y-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{group}</p>
            {groupFactors.map(factor => {
              const currentValue = fw[factor.key] ?? factor.defaultWeight;
              const isOverridden = fw[factor.key] !== undefined;
              const maxSlider = Math.max(factor.defaultWeight * 2, 3);
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
                      <span className="text-sm font-mono font-bold text-primary w-12 text-right">{currentValue.toFixed(2)}</span>
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
                  <p className="text-[10px] text-muted-foreground">{factor.description} (default: {factor.defaultWeight})</p>
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
