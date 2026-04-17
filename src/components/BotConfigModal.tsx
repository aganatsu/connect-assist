import { useState, useEffect, useMemo, useRef } from "react";
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
import { X, Zap, Shield, TrendingUp, Clock, Globe, ShieldAlert, LogIn, LogOut, BarChart3, Gauge, Search } from "lucide-react";

// Index of every searchable setting in the modal — used by the search bar to filter
// tabs and to highlight matching fields. Keep keywords broad so users can find
// settings by intuition (e.g. "trailing", "spread", "news", "drawdown").
const SEARCH_INDEX: { tab: string; label: string; keywords: string[] }[] = [
  // Trading Style
  { tab: "tradingStyle", label: "Trading Style", keywords: ["scalper", "day trader", "swing", "auto", "style", "mode"] },
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
  { tab: "strategy", label: "VWAP Confluence", keywords: ["vwap", "anchored", "session"] },
  { tab: "strategy", label: "AMD Phase Detection", keywords: ["amd", "accumulation", "manipulation", "distribution", "phase"] },
  { tab: "strategy", label: "Require HTF Bias Alignment", keywords: ["htf", "bias", "higher timeframe", "alignment"] },
  { tab: "strategy", label: "HTF Bias Hard Veto", keywords: ["htf", "veto", "hard", "block"] },
  { tab: "strategy", label: "Only Buy in Discount", keywords: ["premium", "discount", "long", "buy"] },
  { tab: "strategy", label: "Only Sell in Premium", keywords: ["premium", "discount", "short", "sell"] },
  // Risk
  { tab: "risk", label: "Risk per Trade (%)", keywords: ["risk", "size", "percent", "percentage"] },
  { tab: "risk", label: "Max Daily Drawdown (%)", keywords: ["drawdown", "daily", "loss", "halt"] },
  { tab: "risk", label: "Max Concurrent Trades", keywords: ["concurrent", "open", "positions", "max"] },
  { tab: "risk", label: "Min R:R Ratio", keywords: ["rr", "risk reward", "ratio", "minimum"] },
  { tab: "risk", label: "Portfolio Heat (%)", keywords: ["portfolio", "heat", "exposure", "total"] },
  { tab: "risk", label: "Max Per Symbol", keywords: ["per symbol", "instrument", "max", "duplicate"] },
  { tab: "risk", label: "Max Total Drawdown (%)", keywords: ["drawdown", "kill switch", "total", "max"] },
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
  { tab: "entry_exit", label: "Trailing Stop", keywords: ["trailing", "stop", "trail"] },
  { tab: "entry_exit", label: "Break Even", keywords: ["break even", "breakeven", "be"] },
  { tab: "entry_exit", label: "Partial Take Profit", keywords: ["partial", "tp", "scale out"] },
  { tab: "entry_exit", label: "Time-Based Exit (hours)", keywords: ["time", "exit", "hours", "auto close"] },
  // Instruments
  { tab: "instruments", label: "Instruments", keywords: ["instruments", "pairs", "symbols", "forex", "crypto", "indices"] },
  { tab: "instruments", label: "Enable Spread Filter", keywords: ["spread", "filter", "broker"] },
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
  // Opening Range
  { tab: "openingRange", label: "Enable Opening Range", keywords: ["opening range", "or", "master"] },
  { tab: "openingRange", label: "Candle Count", keywords: ["candle", "count", "or", "range"] },
  { tab: "openingRange", label: "Daily Bias from OR", keywords: ["bias", "or", "daily"] },
  { tab: "openingRange", label: "Judas Swing Detection", keywords: ["judas", "swing", "fake", "sweep"] },
  { tab: "openingRange", label: "OR Key Levels", keywords: ["key levels", "or", "support", "resistance"] },
  { tab: "openingRange", label: "Premium/Discount from OR", keywords: ["premium", "discount", "or"] },
  { tab: "openingRange", label: "Wait for OR Completion", keywords: ["wait", "completion", "or"] },
];

const PRESETS = {
  conservative: { confluenceThreshold: 6.5, riskPerTrade: 0.5, maxDailyDrawdown: 2, maxConcurrentTrades: 2, tradingStyle: "swing_trader" as const, description: "Low risk, swing trading" },
  moderate: { confluenceThreshold: 5.5, riskPerTrade: 1, maxDailyDrawdown: 3, maxConcurrentTrades: 4, tradingStyle: "day_trader" as const, description: "Balanced day trading" },
  aggressive: { confluenceThreshold: 4, riskPerTrade: 2, maxDailyDrawdown: 5, maxConcurrentTrades: 6, tradingStyle: "scalper" as const, description: "High frequency scalping" },
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
    mutationFn: () => botConfigApi.update(config, connectionId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Config saved"); onClose(); },
    onError: (e: any) => toast.error(e.message),
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

  if (!open) return null;

  const tabs = [
    { id: "tradingStyle", label: "Trading Style", icon: Gauge },
    { id: "strategy", label: "Strategy", icon: TrendingUp },
    { id: "risk", label: "Risk", icon: Shield },
    { id: "entry_exit", label: "Entry / Exit", icon: LogIn },
    { id: "instruments", label: "Instruments", icon: Globe },
    { id: "sessions", label: "Sessions", icon: Clock },
    { id: "protection", label: "Protection", icon: ShieldAlert },
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
            <Button size="sm" className="text-xs" onClick={() => saveMut.mutate()}>Save Config</Button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground ml-2"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Presets Bar */}
        <div className="px-6 py-3 border-b border-border bg-secondary/30">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1"><Zap className="h-3 w-3 text-primary" /> Quick Presets</p>
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(PRESETS).map(([key, preset]) => (
              <button key={key} onClick={() => {
                if (!config) return;
                setConfig({
                  ...config,
                  strategy: { ...(config.strategy || {}), confluenceThreshold: preset.confluenceThreshold },
                  risk: { ...(config.risk || {}), riskPerTrade: preset.riskPerTrade, maxDailyDrawdown: preset.maxDailyDrawdown, maxConcurrentTrades: preset.maxConcurrentTrades },
                  tradingStyle: { ...(config.tradingStyle || {}), mode: preset.tradingStyle },
                });
                toast.info(`Applied ${key} preset → ${STYLE_META[preset.tradingStyle].icon} ${STYLE_META[preset.tradingStyle].label}`);
              }} className="p-3 border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors text-left">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold capitalize">{key}</p>
                  <span className="text-[10px] text-muted-foreground">{STYLE_META[preset.tradingStyle].icon} {STYLE_META[preset.tradingStyle].label}</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">{preset.description}</p>
              </button>
            ))}
          </div>
        </div>

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
                    <div className="grid grid-cols-2 gap-3">
                      {(["scalper", "day_trader", "swing_trader", "auto"] as TradingStyleMode[]).map(mode => {
                        const isActive = (config.tradingStyle?.mode || "day_trader") === mode;
                        const meta = mode !== "auto" ? STYLE_META[mode] : null;
                        const params = mode !== "auto" ? STYLE_PARAMS[mode] : null;
                        return (
                          <button
                            key={mode}
                            onClick={() => updateField("tradingStyle", "mode", mode)}
                            className={`p-4 border text-left transition-colors ${isActive ? "border-primary bg-primary/5" : "border-border hover:border-border/80"}`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-lg">{meta?.icon || "🤖"}</span>
                              <span className="text-xs font-bold">{meta?.label || "Auto-Detect"}</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              {meta?.description || "Bot analyzes volatility and trend per instrument to pick the best style automatically."}
                            </p>
                            {params && (
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-muted-foreground">
                                <span>Entry TF: <strong className="text-foreground">{params.entryTimeframe}</strong></span>
                                <span>HTF Bias: <strong className="text-foreground">{params.htfTimeframe}</strong></span>
                                <span>TP Ratio: <strong className="text-foreground">{params.tpRatio}:1</strong></span>
                                <span>SL Buffer: <strong className="text-foreground">{params.slBufferPips} pip</strong></span>
                                <span>Max Hold: <strong className="text-foreground">{params.maxHoldHours}h</strong></span>
                                <span>Min Score: <strong className="text-foreground">{params.minConfluence}</strong></span>
                              </div>
                            )}
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
                    <FieldGroup label="Auto Scan Interval" description="How often the bot scans for new trade setups (in seconds)">
                      <Select value={String(config.scanner?.intervalSeconds ?? 30)} onValueChange={v => updateField('scanner', 'intervalSeconds', parseInt(v))}>
                        <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="10">Every 10 seconds</SelectItem>
                          <SelectItem value="15">Every 15 seconds</SelectItem>
                          <SelectItem value="30">Every 30 seconds</SelectItem>
                          <SelectItem value="60">Every 1 minute</SelectItem>
                          <SelectItem value="120">Every 2 minutes</SelectItem>
                          <SelectItem value="300">Every 5 minutes</SelectItem>
                          <SelectItem value="600">Every 10 minutes</SelectItem>
                        </SelectContent>
                      </Select>
                    </FieldGroup>
                    <FieldGroup label="Confluence Threshold" description="Minimum weighted score (1-10) required to consider a trade setup valid">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.confluenceThreshold ?? 5]} onValueChange={v => updateField('strategy', 'confluenceThreshold', v[0])} min={1} max={10} step={0.5} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-10 text-right">{(config.strategy?.confluenceThreshold ?? 5).toFixed(1)}</span>
                      </div>
                    </FieldGroup>
                    <FieldGroup label="Min Factor Count" description="Require at least N of 17 factors to align (in addition to score threshold). 0 = off. Score is weighted but count enforces breadth.">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.minFactorCount ?? 0]} onValueChange={v => updateField('strategy', 'minFactorCount', v[0])} min={0} max={17} step={1} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-10 text-right">{config.strategy?.minFactorCount ?? 0}/17</span>
                      </div>
                      {(config.strategy?.minFactorCount ?? 0) > 0 && (
                        <p className="text-[10px] text-muted-foreground mt-1.5">
                          Gate: ≥ {(config.strategy?.confluenceThreshold ?? 5).toFixed(1)}/10 score AND ≥ {config.strategy?.minFactorCount}/17 factors. Tip: During kill zones, 8–10/17 factors typically score 6.0–8.5. Outside kill zones, expect 5–7 factors and 4.0–6.0 scores.
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
                      <ToggleField label="VWAP Confluence" description="Session-anchored VWAP (UTC daily). +0.5 pt when price is bias-aligned within 15 pips, +0.5 bonus on rejection wick" checked={config.strategy?.useVWAP ?? true} onChange={v => updateField('strategy', 'useVWAP', v)} />
                      <ToggleField label="AMD Phase Detection" description="Accumulation→Manipulation→Distribution. +0.5 when bias-aligned to Asian sweep, +0.5 in NY distribution phase" checked={config.strategy?.useAMD ?? true} onChange={v => updateField('strategy', 'useAMD', v)} />
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
                  </div>
                )}

                {effectiveActiveTab === "risk" && (
                  <div className="space-y-5">
                    <SectionHeader title="Risk Management" description="Control position sizing and drawdown limits" />
                    <div className="grid grid-cols-2 gap-4">
                      <FieldGroup label="Risk per Trade (%)" description="Percentage of balance risked per trade">
                        <Input type="number" value={config.risk?.riskPerTrade ?? 1} onChange={e => updateField('risk', 'riskPerTrade', parseFloat(e.target.value) || 0)} step={0.1} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="Max Daily Drawdown (%)" description="Halt trading if daily loss exceeds this">
                        <Input type="number" value={config.risk?.maxDailyDrawdown ?? 3} onChange={e => updateField('risk', 'maxDailyDrawdown', parseFloat(e.target.value) || 0)} step={0.5} className="h-9 text-sm" />
                      </FieldGroup>
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
                    <FieldGroup label="Max Total Drawdown (%)" description="Kill switch if total drawdown exceeds this">
                      <Input type="number" value={config.risk?.maxDrawdown ?? 15} onChange={e => updateField('risk', 'maxDrawdown', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                    </FieldGroup>
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

                    {/* ── Exit Management ── */}
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Exit Management</p>
                      <div className="grid grid-cols-2 gap-4">
                        <ToggleField label="Trailing Stop" description="Move SL as price moves in favor" checked={config.exit?.trailingStop ?? false} onChange={v => updateField('exit', 'trailingStop', v)} />
                        <ToggleField label="Break Even" description="Move SL to entry once in profit" checked={config.exit?.breakEven ?? false} onChange={v => updateField('exit', 'breakEven', v)} />
                        <ToggleField label="Partial Take Profit" description="Close portion of position at first TP" checked={config.exit?.partialTP ?? false} onChange={v => updateField('exit', 'partialTP', v)} />
                      </div>
                      <FieldGroup label="Time-Based Exit (hours)" description="Auto-close after N hours (0 = disabled)">
                        <Input type="number" value={config.exit?.timeExitHours ?? 0} onChange={e => updateField('exit', 'timeExitHours', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                      </FieldGroup>
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
                  </div>
                )}

                {effectiveActiveTab === "sessions" && (
                  <div className="space-y-5">
                    <SectionHeader title="Trading Sessions" description="Control which market sessions the bot is active during" />
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { id: "asian", label: "Asian", time: "00:00 – 09:00 UTC" },
                        { id: "london", label: "London", time: "07:00 – 16:00 UTC" },
                        { id: "newyork", label: "New York", time: "12:00 – 21:00 UTC" },
                        { id: "sydney", label: "Sydney", time: "21:00 – 06:00 UTC" },
                      ].map(session => {
                        const filterArr = config.sessions?.filter;
                        const boolKey = `${session.id}Enabled` as string;
                        const enabled = Array.isArray(filterArr) ? filterArr.includes(session.id) : (config.sessions?.[boolKey] ?? true);
                        return (
                          <button
                            key={session.id}
                            onClick={() => {
                              // Build current filter array from either format
                              const sessions_cfg = config.sessions || {};
                              const current = Array.isArray(sessions_cfg.filter) ? [...sessions_cfg.filter] : [
                                ...(sessions_cfg.asianEnabled !== false ? ["asian"] : []),
                                ...(sessions_cfg.londonEnabled !== false ? ["london"] : []),
                                ...(sessions_cfg.newYorkEnabled !== false || sessions_cfg.newyorkEnabled !== false ? ["newyork"] : []),
                                ...(sessions_cfg.sydneyEnabled !== false ? ["sydney"] : []),
                              ];
                              const updated = enabled ? current.filter((s: string) => s !== session.id) : [...current, session.id];
                              updateField('sessions', 'filter', updated);
                            }}
                            className={`flex items-center justify-between px-4 py-3 border text-left transition-colors ${enabled ? "border-primary/40 bg-primary/5" : "border-border text-muted-foreground"}`}
                          >
                            <div>
                              <p className="text-xs font-medium">{session.label}</p>
                              <p className="text-[10px] text-muted-foreground">{session.time}</p>
                            </div>
                            <span className={`w-2 h-2 rounded-full ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`} />
                          </button>
                        );
                      })}
                    </div>
                    <ToggleField label="Kill Zone Only Trading" description="Only trade during high-volume kill zone windows" checked={config.sessions?.killZoneOnly ?? false} onChange={v => updateField('sessions', 'killZoneOnly', v)} />
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

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-bold">{title}</h3>
      <p className="text-[11px] text-muted-foreground">{description}</p>
    </div>
  );
}

function FieldGroup({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function ToggleField({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 border border-border hover:border-border/80 transition-colors">
      <div>
        <p className="text-xs font-medium">{label}</p>
        {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="shrink-0 mt-0.5" />
    </div>
  );
}
