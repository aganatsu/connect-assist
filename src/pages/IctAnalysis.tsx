import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Clock, Target, Calendar, BarChart3, Grid3X3 } from "lucide-react";
import { smcApi, marketApi } from "@/lib/api";
import { INSTRUMENTS, SESSIONS, KILL_ZONES } from "@/lib/marketData";
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

const SYMBOLS = INSTRUMENTS.map(i => i.symbol);
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "NZD", "CHF"];

// Safe formatter — guards against undefined/null/NaN
const fx = (n: any, d = 5) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—");

export default function IctAnalysis() {
  const [selectedSymbol, setSelectedSymbol] = useState("EUR/USD");
  const currentHour = new Date().getUTCHours();

  // Listen for global symbol change
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.symbol) setSelectedSymbol(detail.symbol);
    };
    window.addEventListener('smc-symbol-change', handler);
    return () => window.removeEventListener('smc-symbol-change', handler);
  }, []);

  const { data: candles } = useQuery({ queryKey: ["candles", selectedSymbol], queryFn: () => marketApi.candles(selectedSymbol, "1h", 200), staleTime: 60000 });
  const { data: dailyCandles } = useQuery({ queryKey: ["daily-candles", selectedSymbol], queryFn: () => marketApi.candles(selectedSymbol, "1day", 30), staleTime: 300000 });
  const { data: analysis, isLoading: analysisLoading } = useQuery({
    queryKey: ["smc-analysis", selectedSymbol, candles?.length],
    queryFn: () => smcApi.fullAnalysis(candles!, dailyCandles),
    enabled: !!candles && candles.length > 0, staleTime: 60000,
  });
  const { data: sessionInfo } = useQuery({ queryKey: ["session-info"], queryFn: () => smcApi.session(), refetchInterval: 60000 });

  const { data: liveQuotes } = useQuery({
    queryKey: ["ict-live-quotes"],
    queryFn: async () => {
      const results: Record<string, any> = {};
      const pairs = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD", "USD/CHF"];
      await Promise.all(pairs.map(async (pair) => { try { results[pair] = await marketApi.quote(pair); } catch { results[pair] = null; } }));
      return results;
    },
    staleTime: 30000,
  });

  const { data: currencyStrength } = useQuery({
    queryKey: ["ict-currency-strength", liveQuotes],
    queryFn: () => {
      if (!liveQuotes) return null;
      const pairData: Record<string, { change: number }> = {};
      Object.entries(liveQuotes).forEach(([pair, q]: [string, any]) => { const pct = q?.percentChange ?? q?.change; if (pct != null) pairData[pair] = { change: pct }; });
      return Object.keys(pairData).length > 0 ? smcApi.currencyStrength(pairData) : null;
    },
    enabled: !!liveQuotes, staleTime: 30000,
  });

  const strengthData = useMemo(() => {
    if (!currencyStrength) return [];
    const arr = Array.isArray(currencyStrength) ? currencyStrength : Object.values(currencyStrength);
    return arr
      .filter((item: any) => item.currency && typeof item.currency === 'string' && item.currency.length <= 4)
      .map((item: any) => ({ currency: item.currency, score: Math.round(((item.strength ?? item.score ?? 0) + Number.EPSILON) * 100) / 100 }))
      .sort((a: any, b: any) => b.score - a.score);
  }, [currencyStrength]);

  // Correlation matrix from real candle close % changes
  const { data: correlationCandles } = useQuery({
    queryKey: ["correlation-candles"],
    queryFn: async () => {
      const pairs = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD", "USD/CHF"];
      const results: Record<string, number[]> = {};
      await Promise.all(pairs.map(async (pair) => {
        try {
          const candles = await marketApi.candles(pair, "1day", 60);
          if (candles && candles.length > 1) {
            // Compute daily returns
            results[pair] = candles.slice(1).map((c: any, i: number) => {
              const prev = candles[i];
              return prev.close > 0 ? ((c.close - prev.close) / prev.close) * 100 : 0;
            });
          }
        } catch { /* skip pair */ }
      }));
      return results;
    },
    staleTime: 300000,
  });

  const correlationMatrix = useMemo(() => {
    if (!correlationCandles) return null;
    const pairs = Object.keys(correlationCandles).filter(p => correlationCandles[p]?.length > 5);
    if (pairs.length < 3) return null;

    // Pearson correlation
    function pearson(a: number[], b: number[]): number {
      const n = Math.min(a.length, b.length);
      if (n < 5) return 0;
      const x = a.slice(0, n), y = b.slice(0, n);
      const mx = x.reduce((s, v) => s + v, 0) / n;
      const my = y.reduce((s, v) => s + v, 0) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        const xi = x[i] - mx, yi = y[i] - my;
        num += xi * yi; dx += xi * xi; dy += yi * yi;
      }
      const denom = Math.sqrt(dx * dy);
      return denom > 0 ? num / denom : 0;
    }

    const matrix: Record<string, Record<string, number>> = {};
    pairs.forEach(p1 => {
      matrix[p1] = {};
      pairs.forEach(p2 => {
        if (p1 === p2) { matrix[p1][p2] = 1; return; }
        matrix[p1][p2] = pearson(correlationCandles[p1], correlationCandles[p2]);
      });
    });
    return { pairs, matrix };
  }, [correlationCandles]);

  return (
    <AppShell>
      <div className="flex h-[calc(100vh-4.5rem)]">
        {/* Instrument sidebar */}
        <div className="w-36 shrink-0 border-r border-border pr-2 space-y-0.5 overflow-y-auto">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Instruments</p>
          {SYMBOLS.map(s => (
            <button key={s} onClick={() => setSelectedSymbol(s)}
              className={`w-full text-left px-2 py-1.5 text-xs transition-colors ${selectedSymbol === s ? "text-primary bg-primary/10 glow-border-left" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}`}>
              {s}
            </button>
          ))}
        </div>

        {/* Analysis content */}
        <div className="flex-1 overflow-y-auto pl-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold">ICT Analysis — {selectedSymbol}</h1>
              {analysis && (
                <div>
                  <p className="text-xs text-muted-foreground">
                    Confluence: <span className="text-primary font-mono font-bold">{analysis.confluenceScore}/10</span>
                    {" · "}Bias: <span className={analysis.bias === "bullish" ? "text-success" : analysis.bias === "bearish" ? "text-destructive" : ""}>{analysis.bias}</span>
                    {analysis.direction && <span className="ml-2 text-[10px] font-bold uppercase px-1.5 py-0.5 border border-primary/30 bg-primary/10 text-primary">{analysis.direction === "long" ? "BUY" : "SELL"}</span>}
                  </p>
                  {analysis.summary && <p className="text-[10px] text-muted-foreground mt-0.5">{analysis.summary}</p>}
                </div>
              )}
            </div>
          </div>

          <Accordion type="multiple" defaultValue={["session", "structure", "strength", "premium", "pdpw", "correlation"]}>
            {/* Session Map */}
            <AccordionItem value="session">
              <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Session Map & Kill Zones</span></AccordionTrigger>
              <AccordionContent>
                <div className="bg-secondary/30 border border-border p-3 space-y-3">
                  <div className="relative h-20">
                    <div className="absolute inset-0 flex">
                      {Array.from({ length: 24 }, (_, h) => (
                        <div key={h} className="flex-1 border-r border-border/30 relative">
                          {h % 3 === 0 && <span className="absolute -bottom-5 left-0 text-[8px] text-muted-foreground font-mono">{h}:00</span>}
                        </div>
                      ))}
                    </div>
                    <div className="absolute top-0 bottom-0 w-0.5 bg-destructive z-10" style={{ left: `${(currentHour / 24) * 100}%` }} />
                    {SESSIONS.map((s, i) => {
                      const start = s.start < s.end ? s.start : 0;
                      const end = s.start < s.end ? s.end : s.end;
                      return (
                        <div key={s.name} className="absolute opacity-70"
                          style={{ left: `${(start / 24) * 100}%`, width: `${((end - start) / 24) * 100}%`, top: `${i * 18}px`, height: "16px", backgroundColor: s.color }}>
                          <span className="text-[9px] font-semibold px-1 leading-[16px] text-foreground drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">{s.name}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-8">
                    {KILL_ZONES.map(kz => {
                      const isActive = currentHour >= kz.start && currentHour < kz.end;
                      return (
                        <span key={kz.name} className={`px-2 py-1 text-[10px] font-semibold border ${isActive ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground/70"}`}>
                          {kz.name} ({kz.start}:00-{kz.end}:00)
                          {isActive && <span className="ml-1 text-success">● Active</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Market Structure */}
            <AccordionItem value="structure">
              <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Target className="h-3.5 w-3.5" /> Market Structure</span></AccordionTrigger>
              <AccordionContent>
                <div className="bg-secondary/30 border border-border p-3">
                  {analysisLoading ? <p className="text-xs text-muted-foreground">Analyzing...</p> : analysis ? (
                    <div className="space-y-3 text-[11px]">
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground">Trend:</span>
                        <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          analysis.structure.trend === "bullish" ? "bg-success/15 text-success border border-success/30" :
                          analysis.structure.trend === "bearish" ? "bg-destructive/15 text-destructive border border-destructive/30" :
                          "bg-muted/30 text-muted-foreground border border-border"
                        }`}>{analysis.structure.trend}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex items-center justify-between p-2 bg-card/50 border border-border">
                          <span className="text-muted-foreground">BOS</span>
                          <span className="font-mono font-bold text-foreground">{analysis.structure.bos?.length || 0}</span>
                        </div>
                        <div className="flex items-center justify-between p-2 bg-card/50 border border-border">
                          <span className="text-muted-foreground">CHoCH</span>
                          <span className="font-mono font-bold text-primary">{analysis.structure.choch?.length || 0}</span>
                        </div>
                        <div className="flex items-center justify-between p-2 bg-card/50 border border-border">
                          <span className="text-muted-foreground">Active OBs</span>
                          <span className="font-mono font-bold text-warning">{analysis.orderBlocks?.filter((ob: any) => !ob.mitigated).length || 0}</span>
                        </div>
                        <div className="flex items-center justify-between p-2 bg-card/50 border border-border">
                          <span className="text-muted-foreground">Unfilled FVGs</span>
                          <span className="font-mono font-bold text-primary">{analysis.fvgs?.filter((f: any) => !f.mitigated).length || 0}</span>
                        </div>
                        <div className="flex items-center justify-between p-2 bg-card/50 border border-border col-span-2">
                          <span className="text-muted-foreground">Liquidity Pools</span>
                          <span className="font-mono font-bold text-foreground">{analysis.liquidityPools?.length || 0}</span>
                        </div>
                      </div>
                    </div>
                  ) : <p className="text-xs text-muted-foreground">No data</p>}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Currency Strength */}
            <AccordionItem value="strength">
              <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><BarChart3 className="h-3.5 w-3.5" /> Currency Strength</span></AccordionTrigger>
              <AccordionContent>
                <div className="bg-secondary/30 border border-border p-3">
                  {strengthData.length > 0 ? (
                    <div>
                      <div className="h-[220px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={strengthData} layout="vertical" barSize={16}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis type="number" tick={{ fontSize: 10, fontFamily: "'IBM Plex Mono'", fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                            <YAxis dataKey="currency" type="category" tick={{ fontSize: 11, fontFamily: "'IBM Plex Mono'", fontWeight: 600, fill: "hsl(var(--foreground))" }} stroke="hsl(var(--border))" width={40} />
                            <Tooltip
                              contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "4px", fontSize: "12px", color: "hsl(var(--foreground))" }}
                              labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600 }}
                              formatter={(value: number) => [`${value.toFixed(2)}%`, "Strength"]}
                            />
                            <Bar dataKey="score">{strengthData.map((entry, i) => <Cell key={i} fill={entry.score >= 0 ? 'hsl(155, 70%, 45%)' : 'hsl(0, 72%, 51%)'} />)}</Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1 text-center">
                        Based on % change across major pairs · <span className="text-success">Green = strong</span> · <span className="text-destructive">Red = weak</span>
                      </p>
                    </div>
                  ) : <p className="text-xs text-muted-foreground">Loading...</p>}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Correlation Matrix */}
            <AccordionItem value="correlation">
              <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Grid3X3 className="h-3.5 w-3.5" /> Correlation Matrix</span></AccordionTrigger>
              <AccordionContent>
                <div className="bg-secondary/30 border border-border p-3">
                  {correlationMatrix ? (
                    <div className="overflow-x-auto">
                      <table className="text-[11px] font-mono">
                        <thead>
                          <tr><th className="px-2 py-1.5"></th>{correlationMatrix.pairs.map(p => <th key={p} className="px-2 py-1.5 text-foreground/80 font-semibold whitespace-nowrap">{p.replace("/", "")}</th>)}</tr>
                        </thead>
                        <tbody>
                          {correlationMatrix.pairs.map(p1 => (
                            <tr key={p1}>
                              <td className="px-2 py-1.5 text-foreground/80 font-semibold whitespace-nowrap">{p1.replace("/", "")}</td>
                              {correlationMatrix.pairs.map(p2 => {
                                const val = correlationMatrix.matrix[p1]?.[p2] ?? 0;
                                const bg = p1 === p2 ? "bg-primary/25" : val > 0.5 ? "bg-destructive/40" : val < -0.5 ? "bg-primary/40" : val > 0.3 ? "bg-destructive/20" : val < -0.3 ? "bg-primary/20" : "bg-muted/15";
                                return <td key={p2} className={`px-2 py-1.5 text-center font-bold text-foreground ${bg}`}>{val.toFixed(2)}</td>;
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="text-xs text-muted-foreground">Insufficient data</p>}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Premium/Discount */}
            <AccordionItem value="premium">
              <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Target className="h-3.5 w-3.5" /> Premium / Discount Zone</span></AccordionTrigger>
              <AccordionContent>
                <div className="bg-secondary/30 border border-border p-3">
                  {analysis?.premiumDiscount ? (
                    <div className="space-y-2">
                      <div className="relative h-24 border border-border overflow-hidden">
                        <div className="absolute top-0 left-0 right-0 h-1/3 bg-destructive/10 flex items-center px-2"><span className="text-[9px] text-destructive font-medium">PREMIUM — Sell Zone</span></div>
                        <div className="absolute top-1/3 left-0 right-0 h-1/3 bg-muted/20 flex items-center justify-center border-y border-dashed border-muted-foreground/30">
                          <span className="text-[9px] text-muted-foreground font-mono">{analysis.premiumDiscount.equilibrium.toFixed(5)}</span></div>
                        <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-success/10 flex items-center px-2"><span className="text-[9px] text-success font-medium">DISCOUNT — Buy Zone</span></div>
                        <div className="absolute left-1/2 w-2.5 h-2.5 bg-primary -translate-x-1/2 -translate-y-1/2 z-10" style={{ top: `${100 - analysis.premiumDiscount.zonePercent}%` }} />
                      </div>
                      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                        <span>H: {analysis.premiumDiscount.swingHigh.toFixed(5)}</span>
                        <span className="text-primary">{analysis.premiumDiscount.currentZone} ({analysis.premiumDiscount.zonePercent.toFixed(0)}%)</span>
                        <span>L: {analysis.premiumDiscount.swingLow.toFixed(5)}</span>
                      </div>
                      {analysis.premiumDiscount.oteZone && <p className="text-[10px] text-primary font-medium">✦ OTE Zone Active</p>}
                    </div>
                  ) : <p className="text-xs text-muted-foreground">Loading...</p>}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* PD/PW Levels */}
            <AccordionItem value="pdpw">
              <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Calendar className="h-3.5 w-3.5" /> PD / PW Levels</span></AccordionTrigger>
              <AccordionContent>
                <div className="bg-secondary/30 border border-border p-3 text-[11px]">
                  {analysis?.pdLevels ? (
                    <div className="space-y-3">
                      <div><p className="text-muted-foreground mb-1 font-medium text-[10px]">Previous Day</p>
                        <div className="grid grid-cols-4 gap-2 font-mono">
                          <div><span className="text-muted-foreground text-[9px]">High:</span> <span>{analysis.pdLevels.pdh.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground text-[9px]">Low:</span> <span>{analysis.pdLevels.pdl.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground text-[9px]">Open:</span> <span>{analysis.pdLevels.pdo.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground text-[9px]">Close:</span> <span>{analysis.pdLevels.pdc.toFixed(5)}</span></div>
                        </div></div>
                      <div><p className="text-muted-foreground mb-1 font-medium text-[10px]">Previous Week</p>
                        <div className="grid grid-cols-4 gap-2 font-mono">
                          <div><span className="text-muted-foreground text-[9px]">High:</span> <span>{analysis.pdLevels.pwh.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground text-[9px]">Low:</span> <span>{analysis.pdLevels.pwl.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground text-[9px]">Open:</span> <span>{analysis.pdLevels.pwo.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground text-[9px]">Close:</span> <span>{analysis.pdLevels.pwc.toFixed(5)}</span></div>
                        </div></div>
                    </div>
                  ) : <p className="text-muted-foreground">No data</p>}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Factor Breakdown (C1: unified with scanner scoring) */}
            {analysis?.factors && analysis.factors.length > 0 && (
              <AccordionItem value="factors">
                <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Target className="h-3.5 w-3.5" /> Confluence Factors ({analysis.factors.filter((f: any) => f.present).length}/{analysis.factors.length})</span></AccordionTrigger>
                <AccordionContent>
                  <div className="bg-secondary/30 border border-border p-3 space-y-1">
                    {analysis.factors.map((f: any, i: number) => (
                      <div key={i} className={`flex items-center justify-between px-2 py-1.5 text-[11px] border-l-2 ${
                        f.present ? "border-l-primary bg-primary/5" : "border-l-border bg-card/30"
                      }`}>
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${f.present ? "bg-primary" : "bg-muted-foreground/30"}`} />
                          <span className={`font-medium ${f.present ? "text-foreground" : "text-muted-foreground"}`}>{f.name}</span>
                          {f.group && <span className="text-[9px] text-muted-foreground/60 px-1 py-0.5 bg-muted/30 rounded">{f.group}</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground max-w-[300px] truncate text-right">{f.detail}</span>
                          <span className={`font-mono text-[10px] font-bold min-w-[32px] text-right ${f.present ? "text-primary" : "text-muted-foreground/40"}`}>
                            +{typeof f.weight === "number" ? f.weight.toFixed(1) : "0.0"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}

            {/* Judas Swing */}
            {analysis?.judasSwing?.detected && (
              <AccordionItem value="judas">
                <AccordionTrigger className="text-xs"><span className="flex items-center gap-2 text-primary">⚡ Judas Swing Detected</span></AccordionTrigger>
                <AccordionContent>
                  <div className="bg-primary/5 border border-primary/20 p-3 text-[11px]">
                    <p>{analysis.judasSwing.description}</p>
                    {analysis.judasSwing.midnightOpen != null && <p className="mt-1 text-muted-foreground font-mono">Type: {analysis.judasSwing.type} · Midnight: {analysis.judasSwing.midnightOpen.toFixed(5)}</p>}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}
          </Accordion>
        </div>
      </div>
    </AppShell>
  );
}
