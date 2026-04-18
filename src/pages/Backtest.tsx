import { useState, useMemo, useCallback, useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  FlaskConical, Play, Loader2, Settings2, ChevronUp, ChevronDown,
  TrendingUp, TrendingDown, BarChart3, Zap, ShieldCheck, ListChecks,
  Trophy, Skull, AlertTriangle, Info, Target, Clock, Timer, XCircle,
  ArrowLeftRight, Layers, Box, Crosshair, Sparkles, Activity, Eye,
  Shield, Gauge, CalendarDays, Globe,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Area, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, RadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Radar,
} from "recharts";
import { INSTRUMENTS, formatMoney } from "@/lib/marketData";
import { botConfigApi, invokeFunction } from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────
interface BacktestTrade {
  id: string; symbol: string; direction: "long" | "short";
  entryTime: string; exitTime: string; entryPrice: number; exitPrice: number;
  size: number; pnl: number; pnlPips: number; confluenceScore: number;
  closeReason: string;
  factors: { name: string; present: boolean; weight: number }[];
  gatesBlocked: string[];
}
interface BacktestStats {
  totalTrades: number; wins: number; losses: number; winRate: number;
  totalPnl: number; totalPnlPips: number; profitFactor: number;
  maxDrawdown: number; maxDrawdownPct: number; sharpeRatio: number;
  avgRR: number; expectancy: number; avgWin: number; avgLoss: number;
  bestTrade: number; worstTrade: number;
  consecutiveWins: number; consecutiveLosses: number;
  longsWinRate: number; shortsWinRate: number; tradesPerMonth: number;
}
interface BacktestResponse {
  trades: BacktestTrade[];
  equityCurve: { date: string; equity: number }[];
  stats: BacktestStats;
  factorBreakdown: Record<string, { appeared: number; wonWhen: number; lostWhen: number }>;
  gateBreakdown: Record<string, { blocked: number; wouldHaveWon: number; wouldHaveLost: number }>;
}

// ── Constants ──────────────────────────────────────────────────────────
const SYMBOL_GROUPS: Record<string, string[]> = {
  "Forex Majors": ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "NZD/USD", "USD/CAD"],
  "Forex Crosses": ["EUR/GBP", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/AUD", "GBP/AUD", "EUR/NZD", "GBP/NZD", "AUD/NZD", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/CAD", "GBP/CAD", "AUD/CAD", "NZD/CAD", "EUR/CHF", "GBP/CHF", "AUD/CHF", "NZD/CHF", "CAD/CHF"],
  "Indices": ["US30", "NAS100", "SPX500", "US2000"],
  "Commodities": ["XAU/USD", "XAG/USD", "USOIL", "UKOIL"],
  "Crypto": ["BTC/USD", "ETH/USD"],
};
const ALL_SYMBOLS = Object.values(SYMBOL_GROUPS).flat();

const TRADING_STYLES = [
  { value: "scalper", label: "Scalper" },
  { value: "day_trader", label: "Day Trader" },
  { value: "swing_trader", label: "Swing Trader" },
];

const SL_METHODS = [
  { value: "structure", label: "Structure (Swing)" },
  { value: "atr_based", label: "ATR Based" },
  { value: "fixed_pips", label: "Fixed Pips" },
  { value: "below_ob", label: "Below/Above OB" },
];

const TP_METHODS = [
  { value: "rr_ratio", label: "R:R Ratio" },
  { value: "fixed_pips", label: "Fixed Pips" },
  { value: "next_level", label: "Next Structure Level" },
  { value: "atr_multiple", label: "ATR Multiple" },
];

const CLOSE_REASONS: Record<string, { label: string; color: string; icon: any }> = {
  tp_hit: { label: "Take Profit", color: "text-success", icon: Target },
  sl_hit: { label: "Stop Loss", color: "text-destructive", icon: XCircle },
  time_exit: { label: "Time Exit", color: "text-warning", icon: Clock },
  trailing_stop: { label: "Trailing Stop", color: "text-cyan", icon: TrendingUp },
  reverse_signal: { label: "Reverse Signal", color: "text-purple-400", icon: ArrowLeftRight },
  partial_tp: { label: "Partial TP", color: "text-blue-400", icon: Layers },
  max_dd: { label: "Max Drawdown", color: "text-destructive", icon: AlertTriangle },
  circuit_breaker: { label: "Circuit Breaker", color: "text-destructive", icon: Shield },
};

// ── Default nested config (matches BotConfigModal) ─────────────────────
function getDefaultConfig() {
  return {
    strategy: {
      useOrderBlocks: true, useFVG: true, useLiquiditySweep: true,
      useStructureBreak: true, useDisplacement: true, useBreakerBlocks: true,
      useUnicornModel: true, useSilverBullet: true, useMacroWindows: true,
      useSMT: true, useVWAP: true, useAMD: true,
      requireHTFBias: true, htfBiasHardVeto: false,
      onlyBuyInDiscount: true, onlySellInPremium: true,
      confluenceThreshold: 3.5,
    },
    risk: {
      riskPerTrade: 1, maxDailyDrawdown: 3, maxConcurrentTrades: 5,
      minRR: 1.5, maxPortfolioHeat: 10, maxPositionsPerSymbol: 2, maxDrawdown: 15,
    },
    entry: {
      cooldownMinutes: 30, slBufferPips: 2, closeOnReverse: false,
    },
    exit: {
      stopLossMethod: "structure", fixedSLPips: 25, slATRMultiple: 1.5, slATRPeriod: 14,
      takeProfitMethod: "rr_ratio", fixedTPPips: 50, tpRRRatio: 2.0, tpATRMultiple: 2.0,
      trailingStop: false, trailingStopPips: 15, trailingStopActivation: "after_1r",
      breakEven: false, breakEvenTriggerPips: 10,
      partialTP: false, partialTPPercent: 50, partialTPLevel: 1.0,
      timeExitHours: 0,
    },
    sessions: {
      filter: ["asian", "london", "newyork", "sydney"],
      killZoneOnly: false,
    },
    protection: {
      maxDailyLoss: 500, maxConsecutiveLosses: 3, circuitBreakerPct: 20,
    },
    openingRange: {
      enabled: false, candleCount: 24, useBias: true, useJudasSwing: true,
      useKeyLevels: true, usePremiumDiscount: false, waitForCompletion: true,
    },
  };
}

// ── Helper components ──────────────────────────────────────────────────
function SectionHeader({ title, description, icon: Icon }: { title: string; description: string; icon?: any }) {
  return (
    <div className="mb-2">
      <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 text-cyan" />} {title}
      </h3>
      <p className="text-[10px] text-muted-foreground">{description}</p>
    </div>
  );
}

function FieldRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-[10px] font-medium uppercase tracking-wider">{label}</span>
          {description && <p className="text-[9px] text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-2 px-2.5 py-2 border border-border/40 hover:border-border/80 transition-colors">
      <div className="min-w-0">
        <p className="text-[10px] font-medium">{label}</p>
        {description && <p className="text-[9px] text-muted-foreground mt-0.5 leading-tight">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="shrink-0 mt-0.5 scale-90" />
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────
export default function Backtest() {
  // Config state
  const [config, setConfig] = useState(getDefaultConfig);
  const [useCurrentConfig, setUseCurrentConfig] = useState(false);
  const [botConfig, setBotConfig] = useState<any>(null);

  // Simulation params
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2026-04-01");
  const [startingBalance, setStartingBalance] = useState(10000);
  const [tradingStyle, setTradingStyle] = useState("day_trader");
  const [slippagePips, setSlippagePips] = useState(0.5);
  const [spreadPips, setSpreadPips] = useState(1.0);
  const [selectedSymbols, setSelectedSymbols] = useState(["EUR/USD", "GBP/USD", "XAU/USD"]);

  // UI state
  const [showConfig, setShowConfig] = useState(true);
  const [configTab, setConfigTab] = useState("strategy");
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<BacktestResponse | null>(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);

  // Load bot config
  useEffect(() => {
    botConfigApi.get().then(data => {
      if (data?.config_json) setBotConfig(data.config_json);
    }).catch(() => {});
  }, []);

  // Sync with current bot config
  useEffect(() => {
    if (useCurrentConfig && botConfig) {
      setConfig(prev => ({
        strategy: { ...prev.strategy, ...botConfig.strategy },
        risk: { ...prev.risk, ...botConfig.risk },
        entry: { ...prev.entry, ...botConfig.entry },
        exit: { ...prev.exit, ...botConfig.exit },
        sessions: { ...prev.sessions, ...botConfig.sessions },
        protection: { ...prev.protection, ...botConfig.protection },
        openingRange: { ...prev.openingRange, ...botConfig.openingRange },
      }));
      if (botConfig.instruments?.enabled) setSelectedSymbols(botConfig.instruments.enabled);
    }
  }, [useCurrentConfig, botConfig]);

  // Config update helper
  const updateConfig = useCallback((section: string, field: string, value: any) => {
    setConfig(prev => ({
      ...prev,
      [section]: { ...(prev as any)[section], [field]: value },
    }));
  }, []);

  const toggleSymbol = useCallback((sym: string) => {
    setSelectedSymbols(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]);
  }, []);

  const toggleSession = useCallback((session: string) => {
    setConfig(prev => {
      const current = prev.sessions.filter || [];
      const updated = current.includes(session) ? current.filter((s: string) => s !== session) : [...current, session];
      return { ...prev, sessions: { ...prev.sessions, filter: updated } };
    });
  }, []);

  // Run backtest
  const runBacktest = useCallback(async () => {
    if (selectedSymbols.length === 0) { setError("Select at least one instrument."); return; }
    setIsRunning(true); setError(""); setResults(null);
    setProgress(`Running backtest on ${selectedSymbols.length} instruments...`);
    try {
      const response = await invokeFunction<BacktestResponse>("backtest-engine", {
        instruments: selectedSymbols, startDate, endDate, startingBalance,
        config, tradingStyle, slippagePips, spreadPips,
      });
      if ((response as any)?.error) throw new Error((response as any).error);
      setResults(response);
      setActiveTab("overview");
      setProgress("");
    } catch (e: any) {
      console.error("Backtest error:", e);
      setError(e?.message || "Backtest failed. Check console for details.");
      setProgress("");
    } finally { setIsRunning(false); }
  }, [selectedSymbols, startDate, endDate, startingBalance, tradingStyle, slippagePips, spreadPips, config]);

  // ── Derived Data ──
  const monthlyPnl = useMemo(() => {
    if (!results) return [];
    const groups: Record<string, number> = {};
    results.trades.filter(t => !t.id.includes("_partial")).forEach(t => {
      const month = t.exitTime.slice(0, 7);
      groups[month] = (groups[month] || 0) + t.pnl;
    });
    return Object.entries(groups).sort().map(([month, pnl]) => ({ month, pnl }));
  }, [results]);

  const factorRadar = useMemo(() => {
    if (!results?.factorBreakdown) return [];
    return Object.entries(results.factorBreakdown)
      .filter(([, v]) => v.appeared > 0)
      .map(([name, v]) => ({
        name: name.length > 15 ? name.slice(0, 14) + "…" : name,
        fullName: name, winRate: v.appeared > 0 ? (v.wonWhen / v.appeared) * 100 : 0,
        appearances: v.appeared,
      }))
      .sort((a, b) => b.appearances - a.appearances).slice(0, 12);
  }, [results]);

  const equityCurveWithDD = useMemo(() => {
    if (!results?.equityCurve) return [];
    let peak = startingBalance;
    return results.equityCurve.map(pt => {
      if (pt.equity > peak) peak = pt.equity;
      const drawdown = peak > 0 ? ((peak - pt.equity) / peak) * 100 : 0;
      return { ...pt, drawdown: -drawdown, date: pt.date.slice(0, 10) };
    });
  }, [results, startingBalance]);

  const closeReasonBreakdown = useMemo(() => {
    if (!results) return [];
    const counts: Record<string, { count: number; totalPnl: number }> = {};
    results.trades.filter(t => !t.id.includes("_partial")).forEach(t => {
      if (!counts[t.closeReason]) counts[t.closeReason] = { count: 0, totalPnl: 0 };
      counts[t.closeReason].count++;
      counts[t.closeReason].totalPnl += t.pnl;
    });
    return Object.entries(counts).map(([reason, v]) => ({
      reason,
      ...CLOSE_REASONS[reason] || { label: reason, color: "text-muted-foreground", icon: Info },
      ...v,
    }));
  }, [results]);

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <AppShell>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2 font-mono">
            <FlaskConical className="h-6 w-6 text-cyan" /> BACKTEST ENGINE
          </h1>
          {results && (
            <Badge variant={results.stats.totalPnl >= 0 ? "default" : "destructive"} className="text-sm px-3 py-1">
              {results.stats.totalTrades} trades | {results.stats.winRate.toFixed(1)}% WR | {formatMoney(results.stats.totalPnl, true)}
            </Badge>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            CONFIGURATION PANEL — Full Bot Config Surface
            ═══════════════════════════════════════════════════════════════ */}
        <Card className="border-border/50">
          <CardHeader className="pb-2 cursor-pointer" onClick={() => setShowConfig(!showConfig)}>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-cyan" /> Configuration
                <span className="text-[10px] text-muted-foreground font-normal ml-2">
                  {useCurrentConfig ? "(using live bot config)" : "(custom)"}
                </span>
              </CardTitle>
              {showConfig ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </div>
          </CardHeader>
          {showConfig && (
            <CardContent className="space-y-4">
              {/* Row 1: Date Range + Balance + Style + Run */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Start Date</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                    className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">End Date</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                    className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Starting Balance</label>
                  <input type="number" value={startingBalance} onChange={e => setStartingBalance(Number(e.target.value) || 10000)}
                    min={100} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Trading Style</label>
                  <select value={tradingStyle} onChange={e => setTradingStyle(e.target.value)}
                    className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                    {TRADING_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="flex items-end">
                  <Button onClick={runBacktest} disabled={isRunning} className="w-full" size="sm">
                    {isRunning ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Running...</> : <><Play className="h-3 w-3 mr-1" /> Run Backtest</>}
                  </Button>
                </div>
              </div>

              {/* Row 2: Simulation + Use config toggle */}
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-muted-foreground uppercase">Slippage</label>
                  <input type="number" value={slippagePips} onChange={e => setSlippagePips(Number(e.target.value))}
                    min={0} max={5} step={0.1} className="w-16 bg-secondary border border-border rounded px-2 py-1 text-xs" />
                  <span className="text-[9px] text-muted-foreground">pips</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-muted-foreground uppercase">Spread</label>
                  <input type="number" value={spreadPips} onChange={e => setSpreadPips(Number(e.target.value))}
                    min={0} max={10} step={0.1} className="w-16 bg-secondary border border-border rounded px-2 py-1 text-xs" />
                  <span className="text-[9px] text-muted-foreground">pips</span>
                </div>
                <Separator orientation="vertical" className="h-5" />
                <div className="flex items-center gap-2">
                  <Switch checked={useCurrentConfig} onCheckedChange={setUseCurrentConfig} className="scale-90" />
                  <span className="text-[10px] text-muted-foreground">Use live bot config</span>
                </div>
              </div>

              <Separator />

              {/* Config Tabs */}
              <Tabs value={configTab} onValueChange={setConfigTab}>
                <TabsList className="bg-secondary/50 border border-border flex-wrap h-auto gap-0.5 p-1">
                  <TabsTrigger value="strategy" className="text-[10px] gap-1 h-7"><Crosshair className="h-3 w-3" /> Strategy</TabsTrigger>
                  <TabsTrigger value="risk" className="text-[10px] gap-1 h-7"><Shield className="h-3 w-3" /> Risk</TabsTrigger>
                  <TabsTrigger value="entry_exit" className="text-[10px] gap-1 h-7"><Target className="h-3 w-3" /> Entry/Exit</TabsTrigger>
                  <TabsTrigger value="sessions" className="text-[10px] gap-1 h-7"><Clock className="h-3 w-3" /> Sessions</TabsTrigger>
                  <TabsTrigger value="protection" className="text-[10px] gap-1 h-7"><Shield className="h-3 w-3" /> Protection</TabsTrigger>
                  <TabsTrigger value="opening_range" className="text-[10px] gap-1 h-7"><Activity className="h-3 w-3" /> Opening Range</TabsTrigger>
                  <TabsTrigger value="instruments" className="text-[10px] gap-1 h-7"><Globe className="h-3 w-3" /> Instruments</TabsTrigger>
                </TabsList>

                {/* ── Strategy Tab ── */}
                <TabsContent value="strategy" className="mt-3 space-y-3">
                  <SectionHeader title="Confluence Factors" description="Toggle each SMC factor on/off to test its impact on performance" icon={Crosshair} />
                  <FieldRow label="Min Confluence Score" description="Minimum total score to trigger a trade">
                    <div className="flex items-center gap-3">
                      <Slider value={[config.strategy.confluenceThreshold]} onValueChange={v => updateConfig("strategy", "confluenceThreshold", v[0])}
                        min={0} max={10} step={0.5} className="flex-1" />
                      <span className="text-xs font-mono font-bold w-8 text-right">{config.strategy.confluenceThreshold}</span>
                    </div>
                  </FieldRow>
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                    <Toggle label="Order Blocks" description="Institutional OB detection" checked={config.strategy.useOrderBlocks} onChange={v => updateConfig("strategy", "useOrderBlocks", v)} />
                    <Toggle label="Fair Value Gaps" description="FVG imbalance zones" checked={config.strategy.useFVG} onChange={v => updateConfig("strategy", "useFVG", v)} />
                    <Toggle label="Liquidity Sweeps" description="Liquidity pool sweep detection" checked={config.strategy.useLiquiditySweep} onChange={v => updateConfig("strategy", "useLiquiditySweep", v)} />
                    <Toggle label="Structure Breaks" description="BOS / CHoCH detection" checked={config.strategy.useStructureBreak} onChange={v => updateConfig("strategy", "useStructureBreak", v)} />
                    <Toggle label="Displacement" description="Strong momentum candle scoring" checked={config.strategy.useDisplacement} onChange={v => updateConfig("strategy", "useDisplacement", v)} />
                    <Toggle label="Breaker Blocks" description="Failed OBs that flip S/R" checked={config.strategy.useBreakerBlocks} onChange={v => updateConfig("strategy", "useBreakerBlocks", v)} />
                    <Toggle label="Unicorn Model" description="Breaker + FVG overlap (1.5 pts)" checked={config.strategy.useUnicornModel} onChange={v => updateConfig("strategy", "useUnicornModel", v)} />
                    <Toggle label="Silver Bullet" description="ICT Silver Bullet windows" checked={config.strategy.useSilverBullet} onChange={v => updateConfig("strategy", "useSilverBullet", v)} />
                    <Toggle label="Macro Windows" description="8 institutional reprice windows" checked={config.strategy.useMacroWindows} onChange={v => updateConfig("strategy", "useMacroWindows", v)} />
                    <Toggle label="SMT Divergence" description="Smart Money divergence vs correlated pair" checked={config.strategy.useSMT} onChange={v => updateConfig("strategy", "useSMT", v)} />
                    <Toggle label="VWAP Confluence" description="Session-anchored VWAP alignment" checked={config.strategy.useVWAP} onChange={v => updateConfig("strategy", "useVWAP", v)} />
                    <Toggle label="AMD Phase" description="Accumulation→Manipulation→Distribution" checked={config.strategy.useAMD} onChange={v => updateConfig("strategy", "useAMD", v)} />
                  </div>
                  <Separator />
                  <SectionHeader title="Bias & Filters" description="Higher timeframe bias and premium/discount zone filters" icon={Eye} />
                  <div className="grid grid-cols-2 gap-2">
                    <Toggle label="Require HTF Bias" description="Only trade in direction of daily bias" checked={config.strategy.requireHTFBias} onChange={v => updateConfig("strategy", "requireHTFBias", v)} />
                    <Toggle label="HTF Bias Hard Veto" description="Hard block: no ranging exception" checked={config.strategy.htfBiasHardVeto} onChange={v => updateConfig("strategy", "htfBiasHardVeto", v)} />
                    <Toggle label="Only Buy in Discount" description="Longs only in discount zone" checked={config.strategy.onlyBuyInDiscount} onChange={v => updateConfig("strategy", "onlyBuyInDiscount", v)} />
                    <Toggle label="Only Sell in Premium" description="Shorts only in premium zone" checked={config.strategy.onlySellInPremium} onChange={v => updateConfig("strategy", "onlySellInPremium", v)} />
                  </div>
                </TabsContent>

                {/* ── Risk Tab ── */}
                <TabsContent value="risk" className="mt-3 space-y-3">
                  <SectionHeader title="Risk Management" description="Position sizing, drawdown limits, and portfolio heat" icon={Shield} />
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <FieldRow label="Risk per Trade (%)" description="% of balance risked per trade">
                      <input type="number" value={config.risk.riskPerTrade} onChange={e => updateConfig("risk", "riskPerTrade", parseFloat(e.target.value) || 1)}
                        step={0.1} min={0.1} max={10} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <FieldRow label="Min R:R Ratio" description="Minimum risk-to-reward">
                      <input type="number" value={config.risk.minRR} onChange={e => updateConfig("risk", "minRR", parseFloat(e.target.value) || 1.5)}
                        step={0.5} min={0.5} max={10} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <FieldRow label="Max Concurrent Trades" description="Max open positions at once">
                      <input type="number" value={config.risk.maxConcurrentTrades} onChange={e => updateConfig("risk", "maxConcurrentTrades", parseInt(e.target.value) || 5)}
                        min={1} max={20} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <FieldRow label="Max Daily DD (%)" description="Halt trading if daily loss exceeds">
                      <input type="number" value={config.risk.maxDailyDrawdown} onChange={e => updateConfig("risk", "maxDailyDrawdown", parseFloat(e.target.value) || 3)}
                        step={0.5} min={0.5} max={20} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <FieldRow label="Portfolio Heat (%)" description="Max total risk across all positions">
                      <input type="number" value={config.risk.maxPortfolioHeat} onChange={e => updateConfig("risk", "maxPortfolioHeat", parseFloat(e.target.value) || 10)}
                        step={1} min={1} max={100} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <FieldRow label="Max Per Symbol" description="Max positions per instrument">
                      <input type="number" value={config.risk.maxPositionsPerSymbol} onChange={e => updateConfig("risk", "maxPositionsPerSymbol", parseInt(e.target.value) || 2)}
                        min={1} max={10} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                  </div>
                  <FieldRow label="Max Total Drawdown (%)" description="Kill switch if total drawdown exceeds this">
                    <div className="flex items-center gap-3">
                      <Slider value={[config.risk.maxDrawdown]} onValueChange={v => updateConfig("risk", "maxDrawdown", v[0])}
                        min={5} max={50} step={1} className="flex-1" />
                      <span className="text-xs font-mono font-bold text-destructive w-10 text-right">{config.risk.maxDrawdown}%</span>
                    </div>
                  </FieldRow>
                </TabsContent>

                {/* ── Entry/Exit Tab ── */}
                <TabsContent value="entry_exit" className="mt-3 space-y-4">
                  {/* Entry */}
                  <SectionHeader title="Entry Rules" description="Cooldown, buffer, and reverse signal handling" icon={Crosshair} />
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <FieldRow label="Cooldown (minutes)" description="Wait between consecutive trades">
                      <input type="number" value={config.entry.cooldownMinutes} onChange={e => updateConfig("entry", "cooldownMinutes", parseInt(e.target.value) || 0)}
                        min={0} max={480} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <FieldRow label="SL Buffer (pips)" description="Extra pips beyond structure for SL">
                      <input type="number" value={config.entry.slBufferPips} onChange={e => updateConfig("entry", "slBufferPips", parseFloat(e.target.value) || 2)}
                        step={0.5} min={0} max={20} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <div className="flex items-end">
                      <Toggle label="Close on Reverse" description="Auto-close on opposite signal" checked={config.entry.closeOnReverse} onChange={v => updateConfig("entry", "closeOnReverse", v)} />
                    </div>
                  </div>

                  <Separator />

                  {/* Stop Loss */}
                  <SectionHeader title="Stop Loss Method" description="How the stop loss price is calculated" icon={XCircle} />
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="SL Method">
                      <select value={config.exit.stopLossMethod} onChange={e => updateConfig("exit", "stopLossMethod", e.target.value)}
                        className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                        {SL_METHODS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </FieldRow>
                    {config.exit.stopLossMethod === "fixed_pips" && (
                      <FieldRow label="Fixed SL Pips">
                        <input type="number" value={config.exit.fixedSLPips} onChange={e => updateConfig("exit", "fixedSLPips", parseFloat(e.target.value) || 25)}
                          step={1} min={1} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                    )}
                    {config.exit.stopLossMethod === "atr_based" && (
                      <>
                        <FieldRow label="ATR Multiple">
                          <input type="number" value={config.exit.slATRMultiple} onChange={e => updateConfig("exit", "slATRMultiple", parseFloat(e.target.value) || 1.5)}
                            step={0.1} min={0.5} max={5} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                        </FieldRow>
                        <FieldRow label="ATR Period">
                          <input type="number" value={config.exit.slATRPeriod} onChange={e => updateConfig("exit", "slATRPeriod", parseInt(e.target.value) || 14)}
                            min={5} max={50} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                        </FieldRow>
                      </>
                    )}
                  </div>

                  <Separator />

                  {/* Take Profit */}
                  <SectionHeader title="Take Profit Method" description="How the take profit price is calculated" icon={Target} />
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="TP Method">
                      <select value={config.exit.takeProfitMethod} onChange={e => updateConfig("exit", "takeProfitMethod", e.target.value)}
                        className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                        {TP_METHODS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </FieldRow>
                    {config.exit.takeProfitMethod === "fixed_pips" && (
                      <FieldRow label="Fixed TP Pips">
                        <input type="number" value={config.exit.fixedTPPips} onChange={e => updateConfig("exit", "fixedTPPips", parseFloat(e.target.value) || 50)}
                          step={1} min={1} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                    )}
                    {(config.exit.takeProfitMethod === "rr_ratio" || !config.exit.takeProfitMethod) && (
                      <FieldRow label="R:R Ratio" description="TP = SL × this ratio">
                        <input type="number" value={config.exit.tpRRRatio} onChange={e => updateConfig("exit", "tpRRRatio", parseFloat(e.target.value) || 2)}
                          step={0.5} min={1} max={10} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                    )}
                    {config.exit.takeProfitMethod === "atr_multiple" && (
                      <FieldRow label="TP ATR Multiple">
                        <input type="number" value={config.exit.tpATRMultiple} onChange={e => updateConfig("exit", "tpATRMultiple", parseFloat(e.target.value) || 2)}
                          step={0.1} min={1} max={10} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                    )}
                  </div>

                  <Separator />

                  {/* Exit Management */}
                  <SectionHeader title="Exit Management" description="Trailing stop, break-even, partial TP, and time exit" icon={Timer} />
                  <div className="grid grid-cols-2 gap-2">
                    <Toggle label="Trailing Stop" description="Move SL as price moves in favor" checked={config.exit.trailingStop} onChange={v => updateConfig("exit", "trailingStop", v)} />
                    <Toggle label="Break Even" description="Move SL to entry once in profit" checked={config.exit.breakEven} onChange={v => updateConfig("exit", "breakEven", v)} />
                    <Toggle label="Partial Take Profit" description="Close portion at first TP level" checked={config.exit.partialTP} onChange={v => updateConfig("exit", "partialTP", v)} />
                  </div>
                  {config.exit.trailingStop && (
                    <div className="grid grid-cols-2 gap-3 pl-3 border-l-2 border-cyan/30">
                      <FieldRow label="Trail Distance (pips)">
                        <input type="number" value={config.exit.trailingStopPips} onChange={e => updateConfig("exit", "trailingStopPips", parseFloat(e.target.value) || 15)}
                          step={1} min={1} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                      <FieldRow label="Activation">
                        <select value={config.exit.trailingStopActivation} onChange={e => updateConfig("exit", "trailingStopActivation", e.target.value)}
                          className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                          <option value="after_1r">After 1R profit</option>
                          <option value="after_2r">After 2R profit</option>
                          <option value="immediate">Immediate</option>
                        </select>
                      </FieldRow>
                    </div>
                  )}
                  {config.exit.breakEven && (
                    <div className="pl-3 border-l-2 border-cyan/30">
                      <FieldRow label="Break-Even Trigger (pips)" description="Move SL to entry after this many pips profit">
                        <input type="number" value={config.exit.breakEvenTriggerPips} onChange={e => updateConfig("exit", "breakEvenTriggerPips", parseFloat(e.target.value) || 10)}
                          step={1} min={1} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                    </div>
                  )}
                  {config.exit.partialTP && (
                    <div className="grid grid-cols-2 gap-3 pl-3 border-l-2 border-cyan/30">
                      <FieldRow label="Partial Close (%)" description="Percentage to close at first level">
                        <input type="number" value={config.exit.partialTPPercent} onChange={e => updateConfig("exit", "partialTPPercent", parseInt(e.target.value) || 50)}
                          min={10} max={90} step={10} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                      <FieldRow label="Partial TP Level (×R)" description="Close at this R-multiple">
                        <input type="number" value={config.exit.partialTPLevel} onChange={e => updateConfig("exit", "partialTPLevel", parseFloat(e.target.value) || 1)}
                          step={0.5} min={0.5} max={5} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                    </div>
                  )}
                  <FieldRow label="Time-Based Exit (hours)" description="Auto-close after N hours (0 = disabled)">
                    <input type="number" value={config.exit.timeExitHours} onChange={e => updateConfig("exit", "timeExitHours", parseInt(e.target.value) || 0)}
                      min={0} max={168} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                  </FieldRow>
                </TabsContent>

                {/* ── Sessions Tab ── */}
                <TabsContent value="sessions" className="mt-3 space-y-3">
                  <SectionHeader title="Trading Sessions" description="Control which market sessions the bot trades during" icon={Clock} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { id: "asian", label: "Asian", time: "00:00–09:00 UTC" },
                      { id: "london", label: "London", time: "07:00–16:00 UTC" },
                      { id: "newyork", label: "New York", time: "12:00–21:00 UTC" },
                      { id: "sydney", label: "Sydney", time: "21:00–06:00 UTC" },
                    ].map(session => {
                      const enabled = config.sessions.filter?.includes(session.id) ?? true;
                      return (
                        <button key={session.id} onClick={() => toggleSession(session.id)}
                          className={`flex items-center justify-between px-3 py-2.5 border text-left transition-colors ${enabled ? "border-cyan/40 bg-cyan/5" : "border-border text-muted-foreground"}`}>
                          <div>
                            <p className="text-[10px] font-medium">{session.label}</p>
                            <p className="text-[9px] text-muted-foreground">{session.time}</p>
                          </div>
                          <span className={`w-2 h-2 rounded-full ${enabled ? "bg-cyan" : "bg-muted-foreground/30"}`} />
                        </button>
                      );
                    })}
                  </div>
                  <Toggle label="Kill Zone Only" description="Only trade during high-volume kill zone windows" checked={config.sessions.killZoneOnly} onChange={v => updateConfig("sessions", "killZoneOnly", v)} />
                </TabsContent>

                {/* ── Protection Tab ── */}
                <TabsContent value="protection" className="mt-3 space-y-3">
                  <SectionHeader title="Protection & Circuit Breakers" description="Safety limits that halt trading" icon={Shield} />
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Max Daily Loss ($)" description="Hard dollar limit — triggers kill switch">
                      <input type="number" value={config.protection.maxDailyLoss} onChange={e => updateConfig("protection", "maxDailyLoss", parseFloat(e.target.value) || 500)}
                        min={0} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                    <FieldRow label="Max Consecutive Losses" description="Pause after N consecutive losing trades">
                      <input type="number" value={config.protection.maxConsecutiveLosses} onChange={e => updateConfig("protection", "maxConsecutiveLosses", parseInt(e.target.value) || 3)}
                        min={0} max={10} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                    </FieldRow>
                  </div>
                  <FieldRow label="Equity Circuit Breaker (%)" description="Emergency stop if equity drops below this % of peak">
                    <div className="flex items-center gap-3">
                      <Slider value={[config.protection.circuitBreakerPct]} onValueChange={v => updateConfig("protection", "circuitBreakerPct", v[0])}
                        min={5} max={50} step={1} className="flex-1" />
                      <span className="text-xs font-mono font-bold text-destructive w-10 text-right">{config.protection.circuitBreakerPct}%</span>
                    </div>
                  </FieldRow>
                </TabsContent>

                {/* ── Opening Range Tab ── */}
                <TabsContent value="opening_range" className="mt-3 space-y-3">
                  <SectionHeader title="Opening Range" description="Use the first N hourly candles to derive bias, levels, and filters" icon={Activity} />
                  <Toggle label="Enable Opening Range" description="Master toggle — all sub-features require this" checked={config.openingRange.enabled} onChange={v => updateConfig("openingRange", "enabled", v)} />
                  {config.openingRange.enabled && (
                    <>
                      <FieldRow label="Candle Count" description="Number of 1h candles defining the opening range">
                        <input type="number" value={config.openingRange.candleCount} onChange={e => updateConfig("openingRange", "candleCount", Math.max(1, parseInt(e.target.value) || 24))}
                          min={1} max={48} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                      </FieldRow>
                      <div className="grid grid-cols-2 gap-2">
                        <Toggle label="Daily Bias from OR" description="Bullish/bearish bias from OR range" checked={config.openingRange.useBias} onChange={v => updateConfig("openingRange", "useBias", v)} />
                        <Toggle label="Judas Swing Detection" description="Detect fake breakouts of OR" checked={config.openingRange.useJudasSwing} onChange={v => updateConfig("openingRange", "useJudasSwing", v)} />
                        <Toggle label="OR Key Levels" description="Use OR high/low/mid as S/R" checked={config.openingRange.useKeyLevels} onChange={v => updateConfig("openingRange", "useKeyLevels", v)} />
                        <Toggle label="Premium/Discount from OR" description="Use OR range for P/D zones" checked={config.openingRange.usePremiumDiscount} onChange={v => updateConfig("openingRange", "usePremiumDiscount", v)} />
                      </div>
                      <Toggle label="Wait for OR Completion" description="Don't trade until OR is fully formed" checked={config.openingRange.waitForCompletion} onChange={v => updateConfig("openingRange", "waitForCompletion", v)} />
                    </>
                  )}
                  {!config.openingRange.enabled && (
                    <p className="text-[10px] text-muted-foreground italic">Enable the master toggle to activate sub-features.</p>
                  )}
                </TabsContent>

                {/* ── Instruments Tab ── */}
                <TabsContent value="instruments" className="mt-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <SectionHeader title="Instruments" description={`${selectedSymbols.length} of ${ALL_SYMBOLS.length} selected`} icon={Globe} />
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="text-[10px] h-6" onClick={() => setSelectedSymbols([...ALL_SYMBOLS])}>All</Button>
                      <Button variant="ghost" size="sm" className="text-[10px] h-6" onClick={() => setSelectedSymbols([])}>None</Button>
                    </div>
                  </div>
                  {Object.entries(SYMBOL_GROUPS).map(([group, syms]) => (
                    <div key={group}>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-widest">{group}</p>
                        <div className="flex gap-1">
                          <button className="text-[8px] text-muted-foreground hover:text-foreground" onClick={() => setSelectedSymbols(prev => [...new Set([...prev, ...syms])])}>All</button>
                          <button className="text-[8px] text-muted-foreground hover:text-foreground" onClick={() => setSelectedSymbols(prev => prev.filter(s => !syms.includes(s)))}>None</button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {syms.map(sym => (
                          <button key={sym} onClick={() => toggleSymbol(sym)}
                            className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                              selectedSymbols.includes(sym) ? "bg-cyan/20 border-cyan/50 text-cyan" : "bg-secondary border-border text-muted-foreground hover:border-border/80"
                            }`}>
                            {sym}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </TabsContent>
              </Tabs>
            </CardContent>
          )}
        </Card>

        {/* Progress / Error */}
        {isRunning && (
          <Card className="border-cyan/30 bg-cyan/5">
            <CardContent className="py-4 flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-cyan" />
              <div>
                <p className="text-sm font-medium">{progress || "Processing..."}</p>
                <p className="text-xs text-muted-foreground mt-0.5">This may take 30-120 seconds depending on instruments and date range.</p>
              </div>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="py-4 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">{error}</p>
                <p className="text-xs text-muted-foreground mt-0.5">Make sure the backtest-engine Edge Function is deployed.</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            RESULTS DASHBOARD
            ═══════════════════════════════════════════════════════════════ */}
        {results && (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-secondary/50 border border-border">
              <TabsTrigger value="overview" className="text-xs gap-1"><BarChart3 className="h-3 w-3" /> Overview</TabsTrigger>
              <TabsTrigger value="trades" className="text-xs gap-1"><ListChecks className="h-3 w-3" /> Trades</TabsTrigger>
              <TabsTrigger value="factors" className="text-xs gap-1"><Zap className="h-3 w-3" /> Factors</TabsTrigger>
              <TabsTrigger value="gates" className="text-xs gap-1"><ShieldCheck className="h-3 w-3" /> Gates</TabsTrigger>
            </TabsList>

            {/* ── Overview Tab ── */}
            <TabsContent value="overview" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {[
                  { label: "Total Trades", value: results.stats.totalTrades, sub: `${results.stats.tradesPerMonth.toFixed(1)}/mo` },
                  { label: "Win Rate", value: `${results.stats.winRate.toFixed(1)}%`, color: results.stats.winRate >= 50 ? "text-success" : "text-destructive", sub: `${results.stats.wins}W / ${results.stats.losses}L` },
                  { label: "Net P&L", value: formatMoney(results.stats.totalPnl, true), color: results.stats.totalPnl >= 0 ? "text-success" : "text-destructive", sub: `${results.stats.totalPnlPips.toFixed(0)} pips` },
                  { label: "Profit Factor", value: results.stats.profitFactor === Infinity ? "∞" : results.stats.profitFactor.toFixed(2), color: results.stats.profitFactor >= 1.5 ? "text-success" : results.stats.profitFactor >= 1 ? "text-warning" : "text-destructive" },
                  { label: "Max Drawdown", value: `${results.stats.maxDrawdownPct.toFixed(1)}%`, color: "text-destructive", sub: formatMoney(-results.stats.maxDrawdown) },
                  { label: "Sharpe Ratio", value: results.stats.sharpeRatio.toFixed(2), color: results.stats.sharpeRatio >= 1 ? "text-success" : "text-muted-foreground" },
                  { label: "Avg RR", value: results.stats.avgRR.toFixed(2), color: results.stats.avgRR >= 1.5 ? "text-success" : "text-muted-foreground" },
                  { label: "Expectancy", value: formatMoney(results.stats.expectancy, true), color: results.stats.expectancy >= 0 ? "text-success" : "text-destructive" },
                  { label: "Avg Win", value: formatMoney(results.stats.avgWin), color: "text-success" },
                  { label: "Avg Loss", value: formatMoney(-results.stats.avgLoss), color: "text-destructive" },
                  { label: "Longs WR", value: `${results.stats.longsWinRate.toFixed(1)}%`, color: results.stats.longsWinRate >= 50 ? "text-success" : "text-muted-foreground" },
                  { label: "Shorts WR", value: `${results.stats.shortsWinRate.toFixed(1)}%`, color: results.stats.shortsWinRate >= 50 ? "text-success" : "text-muted-foreground" },
                ].map(s => (
                  <Card key={s.label} className="border-border/30">
                    <CardContent className="pt-2.5 pb-2">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.label}</p>
                      <p className={`text-base font-bold font-mono ${s.color || ''}`}>{s.value}</p>
                      {s.sub && <p className="text-[9px] text-muted-foreground">{s.sub}</p>}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Equity Curve + Monthly P&L */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="h-4 w-4 text-cyan" /> Equity Curve</CardTitle></CardHeader>
                  <CardContent>
                    <div className="h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={equityCurveWithDD}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                          <XAxis dataKey="date" tick={{ fontSize: 8 }} stroke="hsl(215, 15%, 55%)" />
                          <YAxis yAxisId="equity" tick={{ fontSize: 9 }} stroke="hsl(215, 15%, 55%)" tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
                          <YAxis yAxisId="dd" orientation="right" tick={{ fontSize: 9 }} stroke="hsl(0, 72%, 51%)" tickFormatter={v => `${v.toFixed(0)}%`} />
                          <Tooltip contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px', fontSize: '11px' }}
                            formatter={(value: number, name: string) => name === "equity" ? [`$${value.toFixed(2)}`, "Equity"] : [`${value.toFixed(1)}%`, "Drawdown"]} />
                          <Area yAxisId="equity" type="monotone" dataKey="equity" stroke="hsl(185, 80%, 55%)" fill="hsl(185, 80%, 55%)" fillOpacity={0.08} strokeWidth={2} />
                          <Line yAxisId="dd" type="monotone" dataKey="drawdown" stroke="hsl(0, 72%, 51%)" strokeWidth={1} dot={false} strokeDasharray="3 3" />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><BarChart3 className="h-4 w-4 text-cyan" /> Monthly P&L</CardTitle></CardHeader>
                  <CardContent>
                    <div className="h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={monthlyPnl}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                          <XAxis dataKey="month" tick={{ fontSize: 8 }} stroke="hsl(215, 15%, 55%)" />
                          <YAxis tick={{ fontSize: 9 }} stroke="hsl(215, 15%, 55%)" tickFormatter={v => `$${v.toFixed(0)}`} />
                          <Tooltip contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px', fontSize: '11px' }}
                            formatter={(value: number) => [formatMoney(value, true), "P&L"]} />
                          <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                            {monthlyPnl.map((entry, i) => (
                              <Cell key={i} fill={entry.pnl >= 0 ? 'hsl(155, 70%, 45%)' : 'hsl(0, 72%, 51%)'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Best/Worst + Close Reasons */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <Card><CardContent className="pt-4 text-center"><Trophy className="h-6 w-6 text-success mx-auto mb-1" /><p className="text-[9px] text-muted-foreground uppercase">Best Trade</p><p className="text-lg font-bold text-success font-mono">{formatMoney(results.stats.bestTrade, true)}</p></CardContent></Card>
                  <Card><CardContent className="pt-4 text-center"><Skull className="h-6 w-6 text-destructive mx-auto mb-1" /><p className="text-[9px] text-muted-foreground uppercase">Worst Trade</p><p className="text-lg font-bold text-destructive font-mono">{formatMoney(results.stats.worstTrade, true)}</p></CardContent></Card>
                  <Card><CardContent className="pt-4 text-center"><TrendingUp className="h-5 w-5 text-success mx-auto mb-1" /><p className="text-[9px] text-muted-foreground uppercase">Max Consec. Wins</p><p className="text-lg font-bold font-mono">{results.stats.consecutiveWins}</p></CardContent></Card>
                  <Card><CardContent className="pt-4 text-center"><TrendingDown className="h-5 w-5 text-destructive mx-auto mb-1" /><p className="text-[9px] text-muted-foreground uppercase">Max Consec. Losses</p><p className="text-lg font-bold font-mono">{results.stats.consecutiveLosses}</p></CardContent></Card>
                </div>

                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Close Reasons</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {closeReasonBreakdown.map(cr => {
                        const Icon = cr.icon;
                        return (
                          <div key={cr.reason} className="flex items-center justify-between">
                            <div className="flex items-center gap-2"><Icon className={`h-3.5 w-3.5 ${cr.color}`} /><span className="text-xs">{cr.label}</span></div>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-muted-foreground">{cr.count} trades</span>
                              <span className={`text-xs font-mono ${cr.totalPnl >= 0 ? 'text-success' : 'text-destructive'}`}>{formatMoney(cr.totalPnl, true)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* ── Trades Tab ── */}
            <TabsContent value="trades" className="mt-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <ListChecks className="h-4 w-4 text-cyan" /> Trade History ({results.trades.filter(t => !t.id.includes("_partial")).length} trades)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card z-10">
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-left py-2 px-1.5">#</th>
                          <th className="text-left py-2 px-1.5">Symbol</th>
                          <th className="text-left py-2 px-1.5">Dir</th>
                          <th className="text-left py-2 px-1.5">Entry</th>
                          <th className="text-left py-2 px-1.5">Exit</th>
                          <th className="text-right py-2 px-1.5">Score</th>
                          <th className="text-right py-2 px-1.5">P&L</th>
                          <th className="text-right py-2 px-1.5">Pips</th>
                          <th className="text-left py-2 px-1.5">Close</th>
                          <th className="text-center py-2 px-1.5"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.trades.filter(t => !t.id.includes("_partial")).reverse().map((t, idx) => (
                          <>
                            <tr key={t.id}
                              className={`border-b border-border/20 hover:bg-secondary/30 cursor-pointer ${expandedTrade === t.id ? 'bg-secondary/20' : ''}`}
                              onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}>
                              <td className="py-1.5 px-1.5 text-muted-foreground">{results.trades.filter(t => !t.id.includes("_partial")).length - idx}</td>
                              <td className="py-1.5 px-1.5 font-mono">{t.symbol}</td>
                              <td className={`py-1.5 px-1.5 font-medium ${t.direction === 'long' ? 'text-success' : 'text-destructive'}`}>
                                {t.direction === 'long' ? '▲ LONG' : '▼ SHORT'}
                              </td>
                              <td className="py-1.5 px-1.5 text-muted-foreground">{t.entryTime.slice(0, 16).replace('T', ' ')}</td>
                              <td className="py-1.5 px-1.5 text-muted-foreground">{t.exitTime.slice(0, 16).replace('T', ' ')}</td>
                              <td className="py-1.5 px-1.5 text-right"><Badge variant="outline" className="text-[9px] px-1.5">{t.confluenceScore.toFixed(1)}</Badge></td>
                              <td className={`py-1.5 px-1.5 text-right font-mono font-medium ${t.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>{formatMoney(t.pnl, true)}</td>
                              <td className={`py-1.5 px-1.5 text-right font-mono ${t.pnlPips >= 0 ? 'text-success' : 'text-destructive'}`}>{t.pnlPips >= 0 ? '+' : ''}{t.pnlPips.toFixed(1)}</td>
                              <td className="py-1.5 px-1.5"><span className={`text-[10px] ${CLOSE_REASONS[t.closeReason]?.color || 'text-muted-foreground'}`}>{CLOSE_REASONS[t.closeReason]?.label || t.closeReason}</span></td>
                              <td className="py-1.5 px-1.5 text-center">{expandedTrade === t.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}</td>
                            </tr>
                            {expandedTrade === t.id && (
                              <tr key={`${t.id}-detail`}>
                                <td colSpan={10} className="py-2 px-3 bg-secondary/10">
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
                                    <div><span className="text-[9px] text-muted-foreground">Entry Price</span><p className="text-xs font-mono">{t.entryPrice.toFixed(5)}</p></div>
                                    <div><span className="text-[9px] text-muted-foreground">Exit Price</span><p className="text-xs font-mono">{t.exitPrice.toFixed(5)}</p></div>
                                    <div><span className="text-[9px] text-muted-foreground">Size</span><p className="text-xs font-mono">{t.size.toFixed(2)} lots</p></div>
                                    <div><span className="text-[9px] text-muted-foreground">Hold Time</span><p className="text-xs font-mono">{((new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime()) / 3600000).toFixed(1)}h</p></div>
                                  </div>
                                  <div>
                                    <span className="text-[9px] text-muted-foreground uppercase">Confluence Factors</span>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      {t.factors.map((f, fi) => (
                                        <Badge key={fi} variant={f.present ? "default" : "outline"} className={`text-[9px] ${f.present ? '' : 'opacity-40'}`}>
                                          {f.name} {f.present ? `+${f.weight.toFixed(1)}` : ''}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                  {t.gatesBlocked.length > 0 && (
                                    <div className="mt-2">
                                      <span className="text-[9px] text-destructive uppercase">Gates Blocked</span>
                                      <div className="flex flex-wrap gap-1 mt-1">
                                        {t.gatesBlocked.map((g, gi) => (
                                          <Badge key={gi} variant="destructive" className="text-[9px]">{g}</Badge>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Factors Tab ── */}
            <TabsContent value="factors" className="space-y-4 mt-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {factorRadar.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4 text-cyan" /> Factor Win Rate Radar</CardTitle></CardHeader>
                    <CardContent>
                      <div className="h-[350px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <RadarChart data={factorRadar}>
                            <PolarGrid stroke="hsl(220, 16%, 18%)" />
                            <PolarAngleAxis dataKey="name" tick={{ fontSize: 8, fill: "hsl(215, 15%, 55%)" }} />
                            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 8 }} />
                            <Radar name="Win Rate %" dataKey="winRate" stroke="hsl(185, 80%, 55%)" fill="hsl(185, 80%, 55%)" fillOpacity={0.2} />
                          </RadarChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                )}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Factor Breakdown</CardTitle></CardHeader>
                  <CardContent>
                    <div className="overflow-y-auto max-h-[350px]">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-card">
                          <tr className="border-b border-border text-muted-foreground">
                            <th className="text-left py-2 px-1">Factor</th>
                            <th className="text-right py-2 px-1">Appeared</th>
                            <th className="text-right py-2 px-1">Won</th>
                            <th className="text-right py-2 px-1">Lost</th>
                            <th className="text-right py-2 px-1">Win %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(results.factorBreakdown).sort(([, a], [, b]) => b.appeared - a.appeared).map(([name, v]) => {
                            const wr = v.appeared > 0 ? (v.wonWhen / v.appeared) * 100 : 0;
                            return (
                              <tr key={name} className="border-b border-border/20 hover:bg-secondary/20">
                                <td className="py-1.5 px-1">{name}</td>
                                <td className="py-1.5 px-1 text-right font-mono">{v.appeared}</td>
                                <td className="py-1.5 px-1 text-right font-mono text-success">{v.wonWhen}</td>
                                <td className="py-1.5 px-1 text-right font-mono text-destructive">{v.lostWhen}</td>
                                <td className={`py-1.5 px-1 text-right font-mono font-medium ${wr >= 55 ? 'text-success' : wr >= 45 ? 'text-warning' : 'text-destructive'}`}>{wr.toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* ── Gates Tab ── */}
            <TabsContent value="gates" className="mt-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-cyan" /> Safety Gate Analytics</CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-1">Shows how many trades each gate blocked, and whether those blocked trades would have been winners or losers.</p>
                </CardHeader>
                <CardContent>
                  <div className="overflow-y-auto max-h-[400px]">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-left py-2 px-1.5">Gate</th>
                          <th className="text-right py-2 px-1.5">Blocked</th>
                          <th className="text-right py-2 px-1.5">Would Win</th>
                          <th className="text-right py-2 px-1.5">Would Lose</th>
                          <th className="text-right py-2 px-1.5">Accuracy</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(results.gateBreakdown).sort(([, a], [, b]) => b.blocked - a.blocked).map(([name, v]) => {
                          const accuracy = v.blocked > 0 ? (v.wouldHaveLost / v.blocked) * 100 : 0;
                          return (
                            <tr key={name} className="border-b border-border/20 hover:bg-secondary/20">
                              <td className="py-1.5 px-1.5">{name}</td>
                              <td className="py-1.5 px-1.5 text-right font-mono">{v.blocked}</td>
                              <td className="py-1.5 px-1.5 text-right font-mono text-warning">{v.wouldHaveWon}</td>
                              <td className="py-1.5 px-1.5 text-right font-mono text-success">{v.wouldHaveLost}</td>
                              <td className={`py-1.5 px-1.5 text-right font-mono font-medium ${accuracy >= 60 ? 'text-success' : accuracy >= 40 ? 'text-warning' : 'text-destructive'}`}>{accuracy.toFixed(1)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {Object.keys(results.gateBreakdown).length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-8">No gates were triggered during this backtest period.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}

        {/* Empty State */}
        {!results && !isRunning && !error && (
          <Card>
            <CardContent className="py-16 text-center">
              <FlaskConical className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">Configure parameters above and click <strong>Run Backtest</strong> to see results.</p>
              <p className="text-xs text-muted-foreground mt-2">
                Uses the same SMC analysis engine, 18 confluence factors, 17 safety gates, and exit logic as the live bot.
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowConfig(true)}>
                <Settings2 className="h-3 w-3 mr-1" /> Open Configuration
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
