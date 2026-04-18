import { useState, useMemo, useCallback, useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { invokeFunction, botConfigApi } from "@/lib/api";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid, ComposedChart, Line,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from "recharts";
import {
  FlaskConical, Play, TrendingUp, TrendingDown, Trophy, Skull,
  Loader2, Settings2, BarChart3, ListChecks, ShieldCheck, Target,
  Clock, ArrowUpDown, Zap, ChevronDown, ChevronUp, AlertTriangle,
  CheckCircle2, XCircle, Info,
} from "lucide-react";

// ─── Types matching backtest-engine response ────────────────────────

interface BacktestTrade {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  size: number;
  pnl: number;
  pnlPips: number;
  closeReason: string;
  confluenceScore: number;
  factors: { name: string; present: boolean; weight: number }[];
  gatesBlocked: string[];
}

interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalPnlPips: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgRR: number;
  bestTrade: number;
  worstTrade: number;
  avgHoldBars: number;
  longsWinRate: number;
  shortsWinRate: number;
  tradesPerMonth: number;
  expectancy: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

interface FactorBreakdown {
  [name: string]: { appeared: number; wonWhen: number; lostWhen: number };
}

interface GateBreakdown {
  [name: string]: { blocked: number; wouldHaveWon: number; wouldHaveLost: number };
}

interface BacktestResponse {
  trades: BacktestTrade[];
  equityCurve: { date: string; equity: number }[];
  stats: BacktestStats;
  factorBreakdown: FactorBreakdown;
  gateBreakdown: GateBreakdown;
}

// ─── Constants ──────────────────────────────────────────────────────

const SYMBOLS = INSTRUMENTS.map(i => i.symbol);
const SYMBOL_GROUPS = {
  "Forex Majors": INSTRUMENTS.filter(i => i.type === "forex").slice(0, 7).map(i => i.symbol),
  "Forex Crosses": INSTRUMENTS.filter(i => i.type === "forex").slice(7).map(i => i.symbol),
  "Indices": INSTRUMENTS.filter(i => i.type === "index").map(i => i.symbol),
  "Commodities": INSTRUMENTS.filter(i => i.type === "commodity").map(i => i.symbol),
  "Crypto": INSTRUMENTS.filter(i => i.type === "crypto").map(i => i.symbol),
};

const TRADING_STYLES = [
  { value: "scalper", label: "Scalper" },
  { value: "day_trader", label: "Day Trader" },
  { value: "swing_trader", label: "Swing Trader" },
];

const SL_METHODS = [
  { value: "structure", label: "Structure" },
  { value: "atr_based", label: "ATR Based" },
  { value: "fixed_pips", label: "Fixed Pips" },
  { value: "below_ob", label: "Below OB" },
];

const CLOSE_REASONS: Record<string, { label: string; color: string; icon: any }> = {
  tp_hit: { label: "TP Hit", color: "text-success", icon: CheckCircle2 },
  sl_hit: { label: "SL Hit", color: "text-destructive", icon: XCircle },
  time_exit: { label: "Time Exit", color: "text-warning", icon: Clock },
  close_on_reverse: { label: "Reversed", color: "text-muted-foreground", icon: ArrowUpDown },
  partial_tp: { label: "Partial TP", color: "text-cyan", icon: Target },
};

// ─── Component ──────────────────────────────────────────────────────

export default function Backtest() {
  // ── Config State ──
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(["EUR/USD", "GBP/USD", "XAU/USD"]);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [startingBalance, setStartingBalance] = useState(10000);
  const [tradingStyle, setTradingStyle] = useState("day_trader");
  const [slippagePips, setSlippagePips] = useState(0.5);
  const [spreadPips, setSpreadPips] = useState(1.0);
  const [useCurrentConfig, setUseCurrentConfig] = useState(true);

  // ── Override config fields ──
  const [minConfluence, setMinConfluence] = useState(5.5);
  const [riskPerTrade, setRiskPerTrade] = useState(1);
  const [minRR, setMinRR] = useState(1.5);
  const [slMethod, setSlMethod] = useState("structure");
  const [maxOpenPositions, setMaxOpenPositions] = useState(5);
  const [killZoneOnly, setKillZoneOnly] = useState(false);

  // ── Run State ──
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BacktestResponse | null>(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  // ── Load bot config on mount ──
  const [botConfig, setBotConfig] = useState<any>(null);
  useEffect(() => {
    botConfigApi.get().then(cfg => {
      setBotConfig(cfg);
      if (cfg) {
        setMinConfluence(cfg.minConfluence ?? 5.5);
        setRiskPerTrade(cfg.riskPerTrade ?? 1);
        setMinRR(cfg.minRiskReward ?? 1.5);
        setSlMethod(cfg.slMethod ?? "structure");
        setMaxOpenPositions(cfg.maxOpenPositions ?? 5);
        setKillZoneOnly(cfg.killZoneOnly ?? false);
        if (cfg.instruments?.length) setSelectedSymbols(cfg.instruments.slice(0, 5));
        if (cfg.tradingStyle?.mode) setTradingStyle(cfg.tradingStyle.mode);
      }
    }).catch(() => {});
  }, []);

  // ── Toggle symbol ──
  const toggleSymbol = useCallback((sym: string) => {
    setSelectedSymbols(prev =>
      prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]
    );
  }, []);

  // ── Run Backtest ──
  const runBacktest = useCallback(async () => {
    if (selectedSymbols.length === 0) {
      setError("Select at least one instrument");
      return;
    }
    setIsRunning(true);
    setError(null);
    setResults(null);
    setProgress("Initializing backtest engine...");

    try {
      const config = useCurrentConfig && botConfig ? { ...botConfig } : {
        minConfluence,
        riskPerTrade,
        minRiskReward: minRR,
        slMethod,
        maxOpenPositions,
        killZoneOnly,
      };

      // Override with form values even when using current config
      if (useCurrentConfig && botConfig) {
        config.riskPerTrade = riskPerTrade;
        config.minConfluence = minConfluence;
        config.minRiskReward = minRR;
      }

      setProgress(`Running backtest on ${selectedSymbols.length} instruments...`);

      const response = await invokeFunction<BacktestResponse>("backtest-engine", {
        instruments: selectedSymbols,
        startDate,
        endDate,
        startingBalance,
        config,
        tradingStyle,
        slippagePips,
        spreadPips,
      });

      if ((response as any)?.error) {
        throw new Error((response as any).error);
      }

      setResults(response);
      setActiveTab("overview");
      setProgress("");
    } catch (e: any) {
      console.error("Backtest error:", e);
      setError(e?.message || "Backtest failed. Check console for details.");
      setProgress("");
    } finally {
      setIsRunning(false);
    }
  }, [selectedSymbols, startDate, endDate, startingBalance, tradingStyle, slippagePips, spreadPips, useCurrentConfig, botConfig, minConfluence, riskPerTrade, minRR, slMethod, maxOpenPositions, killZoneOnly]);

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
        fullName: name,
        winRate: v.appeared > 0 ? (v.wonWhen / v.appeared) * 100 : 0,
        appearances: v.appeared,
      }))
      .sort((a, b) => b.appearances - a.appearances)
      .slice(0, 12);
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

  // ─── Render ───────────────────────────────────────────────────────

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

        {/* Configuration Panel */}
        <Card className="border-border/50">
          <CardHeader className="pb-2 cursor-pointer" onClick={() => setShowConfig(!showConfig)}>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-cyan" /> Configuration
              </CardTitle>
              {showConfig ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </div>
          </CardHeader>
          {showConfig && (
            <CardContent className="space-y-4">
              {/* Row 1: Date Range + Balance + Style */}
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

              {/* Row 2: Simulation params */}
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Slippage (pips)</label>
                  <input type="number" value={slippagePips} onChange={e => setSlippagePips(Number(e.target.value))}
                    min={0} max={5} step={0.1} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Spread (pips)</label>
                  <input type="number" value={spreadPips} onChange={e => setSpreadPips(Number(e.target.value))}
                    min={0} max={10} step={0.1} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Min Confluence</label>
                  <input type="number" value={minConfluence} onChange={e => setMinConfluence(Number(e.target.value))}
                    min={0} max={10} step={0.5} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Risk %</label>
                  <input type="number" value={riskPerTrade} onChange={e => setRiskPerTrade(Number(e.target.value))}
                    min={0.1} max={10} step={0.1} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Min RR</label>
                  <input type="number" value={minRR} onChange={e => setMinRR(Number(e.target.value))}
                    min={0.5} max={10} step={0.5} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">SL Method</label>
                  <select value={slMethod} onChange={e => setSlMethod(e.target.value)}
                    className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                    {SL_METHODS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              </div>

              {/* Row 3: Use current config toggle + extra params */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Switch checked={useCurrentConfig} onCheckedChange={setUseCurrentConfig} />
                  <span className="text-xs text-muted-foreground">Use current bot config</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={killZoneOnly} onCheckedChange={setKillZoneOnly} />
                  <span className="text-xs text-muted-foreground">Kill Zone only</span>
                </div>
              </div>

              <Separator />

              {/* Instrument Selection */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 block">
                  Instruments ({selectedSymbols.length} selected)
                </label>
                <div className="space-y-2">
                  {Object.entries(SYMBOL_GROUPS).map(([group, syms]) => (
                    <div key={group}>
                      <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1">{group}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {syms.map(sym => (
                          <button
                            key={sym}
                            onClick={() => toggleSymbol(sym)}
                            className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                              selectedSymbols.includes(sym)
                                ? "bg-cyan/20 border-cyan/50 text-cyan"
                                : "bg-secondary border-border text-muted-foreground hover:border-border/80"
                            }`}
                          >
                            {sym}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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
                <p className="text-xs text-muted-foreground mt-0.5">
                  This may take 30-120 seconds depending on the number of instruments and date range.
                </p>
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
                <p className="text-xs text-muted-foreground mt-0.5">
                  Make sure the backtest-engine Edge Function is deployed.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results */}
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
              {/* Stats Grid */}
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
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-cyan" /> Equity Curve
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={equityCurveWithDD}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                          <XAxis dataKey="date" tick={{ fontSize: 8 }} stroke="hsl(215, 15%, 55%)" />
                          <YAxis yAxisId="equity" tick={{ fontSize: 9 }} stroke="hsl(215, 15%, 55%)" tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
                          <YAxis yAxisId="dd" orientation="right" tick={{ fontSize: 9 }} stroke="hsl(0, 72%, 51%)" tickFormatter={v => `${v.toFixed(0)}%`} />
                          <Tooltip
                            contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px', fontSize: '11px' }}
                            formatter={(value: number, name: string) => {
                              if (name === "equity") return [`$${value.toFixed(2)}`, "Equity"];
                              return [`${value.toFixed(1)}%`, "Drawdown"];
                            }}
                          />
                          <Area yAxisId="equity" type="monotone" dataKey="equity" stroke="hsl(185, 80%, 55%)" fill="hsl(185, 80%, 55%)" fillOpacity={0.08} strokeWidth={2} />
                          <Line yAxisId="dd" type="monotone" dataKey="drawdown" stroke="hsl(0, 72%, 51%)" strokeWidth={1} dot={false} strokeDasharray="3 3" />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-cyan" /> Monthly P&L
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[280px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={monthlyPnl}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                          <XAxis dataKey="month" tick={{ fontSize: 8 }} stroke="hsl(215, 15%, 55%)" />
                          <YAxis tick={{ fontSize: 9 }} stroke="hsl(215, 15%, 55%)" tickFormatter={v => `$${v.toFixed(0)}`} />
                          <Tooltip
                            contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px', fontSize: '11px' }}
                            formatter={(value: number) => [formatMoney(value, true), "P&L"]}
                          />
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
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Close Reasons</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {closeReasonBreakdown.map(cr => {
                        const Icon = cr.icon;
                        return (
                          <div key={cr.reason} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Icon className={`h-3.5 w-3.5 ${cr.color}`} />
                              <span className="text-xs">{cr.label}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-muted-foreground">{cr.count} trades</span>
                              <span className={`text-xs font-mono ${cr.totalPnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                                {formatMoney(cr.totalPnl, true)}
                              </span>
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
                    <ListChecks className="h-4 w-4 text-cyan" />
                    Trade History ({results.trades.filter(t => !t.id.includes("_partial")).length} trades)
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
                            <tr
                              key={t.id}
                              className={`border-b border-border/20 hover:bg-secondary/30 cursor-pointer ${expandedTrade === t.id ? 'bg-secondary/20' : ''}`}
                              onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}
                            >
                              <td className="py-1.5 px-1.5 text-muted-foreground">{results.trades.filter(t => !t.id.includes("_partial")).length - idx}</td>
                              <td className="py-1.5 px-1.5 font-mono">{t.symbol}</td>
                              <td className={`py-1.5 px-1.5 font-medium ${t.direction === 'long' ? 'text-success' : 'text-destructive'}`}>
                                {t.direction === 'long' ? '▲ LONG' : '▼ SHORT'}
                              </td>
                              <td className="py-1.5 px-1.5 text-muted-foreground">{t.entryTime.slice(0, 16).replace('T', ' ')}</td>
                              <td className="py-1.5 px-1.5 text-muted-foreground">{t.exitTime.slice(0, 16).replace('T', ' ')}</td>
                              <td className="py-1.5 px-1.5 text-right">
                                <Badge variant="outline" className="text-[9px] px-1.5">{t.confluenceScore.toFixed(1)}</Badge>
                              </td>
                              <td className={`py-1.5 px-1.5 text-right font-mono font-medium ${t.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                                {formatMoney(t.pnl, true)}
                              </td>
                              <td className={`py-1.5 px-1.5 text-right font-mono ${t.pnlPips >= 0 ? 'text-success' : 'text-destructive'}`}>
                                {t.pnlPips >= 0 ? '+' : ''}{t.pnlPips.toFixed(1)}
                              </td>
                              <td className="py-1.5 px-1.5">
                                <span className={`text-[10px] ${CLOSE_REASONS[t.closeReason]?.color || 'text-muted-foreground'}`}>
                                  {CLOSE_REASONS[t.closeReason]?.label || t.closeReason}
                                </span>
                              </td>
                              <td className="py-1.5 px-1.5 text-center">
                                {expandedTrade === t.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              </td>
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
                {/* Factor Radar */}
                {factorRadar.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Zap className="h-4 w-4 text-cyan" /> Factor Win Rate Radar
                      </CardTitle>
                    </CardHeader>
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

                {/* Factor Table */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Factor Breakdown</CardTitle>
                  </CardHeader>
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
                          {Object.entries(results.factorBreakdown)
                            .sort(([, a], [, b]) => b.appeared - a.appeared)
                            .map(([name, v]) => {
                              const wr = v.appeared > 0 ? (v.wonWhen / v.appeared) * 100 : 0;
                              return (
                                <tr key={name} className="border-b border-border/20 hover:bg-secondary/20">
                                  <td className="py-1.5 px-1">{name}</td>
                                  <td className="py-1.5 px-1 text-right font-mono">{v.appeared}</td>
                                  <td className="py-1.5 px-1 text-right font-mono text-success">{v.wonWhen}</td>
                                  <td className="py-1.5 px-1 text-right font-mono text-destructive">{v.lostWhen}</td>
                                  <td className={`py-1.5 px-1 text-right font-mono font-medium ${wr >= 55 ? 'text-success' : wr >= 45 ? 'text-warning' : 'text-destructive'}`}>
                                    {wr.toFixed(1)}%
                                  </td>
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
                  <CardTitle className="text-sm flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-cyan" /> Safety Gate Analytics
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Shows how many trades each gate blocked, and whether those blocked trades would have been winners or losers (hindsight analysis).
                  </p>
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
                        {Object.entries(results.gateBreakdown)
                          .sort(([, a], [, b]) => b.blocked - a.blocked)
                          .map(([name, v]) => {
                            const accuracy = v.blocked > 0 ? (v.wouldHaveLost / v.blocked) * 100 : 0;
                            return (
                              <tr key={name} className="border-b border-border/20 hover:bg-secondary/20">
                                <td className="py-1.5 px-1.5">{name}</td>
                                <td className="py-1.5 px-1.5 text-right font-mono">{v.blocked}</td>
                                <td className="py-1.5 px-1.5 text-right font-mono text-warning">{v.wouldHaveWon}</td>
                                <td className="py-1.5 px-1.5 text-right font-mono text-success">{v.wouldHaveLost}</td>
                                <td className={`py-1.5 px-1.5 text-right font-mono font-medium ${accuracy >= 60 ? 'text-success' : accuracy >= 40 ? 'text-warning' : 'text-destructive'}`}>
                                  {accuracy.toFixed(1)}%
                                </td>
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
                Uses the same SMC analysis engine, confluence scoring, safety gates, and exit logic as the live bot.
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
