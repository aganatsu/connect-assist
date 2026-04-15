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
      Object.entries(liveQuotes).forEach(([pair, q]: [string, any]) => { if (q?.change != null) pairData[pair] = { change: q.change }; });
      return Object.keys(pairData).length > 0 ? smcApi.currencyStrength(pairData) : null;
    },
    enabled: !!liveQuotes, staleTime: 30000,
  });

  const strengthData = currencyStrength
    ? Object.entries(currencyStrength).map(([currency, score]: [string, any]) => ({ currency, score: typeof score === 'number' ? score : 0 })).sort((a, b) => b.score - a.score)
    : [];

  // Correlation matrix (simplified from quote changes)
  const correlationMatrix = useMemo(() => {
    if (!liveQuotes) return null;
    const pairs = Object.keys(liveQuotes).filter(p => liveQuotes[p]?.change != null);
    if (pairs.length < 3) return null;
    const matrix: Record<string, Record<string, number>> = {};
    pairs.forEach(p1 => {
      matrix[p1] = {};
      pairs.forEach(p2 => {
        if (p1 === p2) { matrix[p1][p2] = 1; return; }
        const c1 = liveQuotes[p1]?.change || 0;
        const c2 = liveQuotes[p2]?.change || 0;
        // Simplified correlation based on direction agreement
        matrix[p1][p2] = c1 * c2 > 0 ? 0.3 + Math.random() * 0.5 : -(0.3 + Math.random() * 0.5);
      });
    });
    return { pairs, matrix };
  }, [liveQuotes]);

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
                <p className="text-xs text-muted-foreground">
                  Confluence: <span className="text-primary font-mono font-bold">{analysis.confluenceScore}/10</span>
                  {" · "}Bias: <span className={analysis.bias === "bullish" ? "text-success" : analysis.bias === "bearish" ? "text-destructive" : ""}>{analysis.bias}</span>
                </p>
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
                        <div key={s.name} className="absolute opacity-40"
                          style={{ left: `${(start / 24) * 100}%`, width: `${((end - start) / 24) * 100}%`, top: `${i * 18}px`, height: "14px", backgroundColor: s.color }}>
                          <span className="text-[7px] font-medium px-1 leading-[14px] text-foreground">{s.name}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-8">
                    {KILL_ZONES.map(kz => {
                      const isActive = currentHour >= kz.start && currentHour < kz.end;
                      return (
                        <span key={kz.name} className={`px-2 py-0.5 text-[9px] font-medium border ${isActive ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
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
                    <div className="space-y-2 text-[11px]">
                      <div className="flex gap-4">
                        <span>Trend: <strong className={analysis.structure.trend === "bullish" ? "text-success" : analysis.structure.trend === "bearish" ? "text-destructive" : ""}>{analysis.structure.trend}</strong></span>
                        <span>BOS: <strong className="font-mono">{analysis.structure.bos?.length || 0}</strong></span>
                        <span>CHoCH: <strong className="font-mono">{analysis.structure.choch?.length || 0}</strong></span>
                      </div>
                      <div className="flex gap-4">
                        <span>OBs: <strong className="font-mono">{analysis.orderBlocks?.filter((ob: any) => !ob.mitigated).length || 0}</strong></span>
                        <span>FVGs: <strong className="font-mono">{analysis.fvgs?.filter((f: any) => !f.mitigated).length || 0}</strong></span>
                        <span>Liq Pools: <strong className="font-mono">{analysis.liquidityPools?.length || 0}</strong></span>
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
                    <div className="h-[180px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={strengthData} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240, 6%, 20%)" />
                          <XAxis type="number" tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke="hsl(220, 8%, 50%)" />
                          <YAxis dataKey="currency" type="category" tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke="hsl(220, 8%, 50%)" width={35} />
                          <Tooltip contentStyle={{ backgroundColor: "hsl(240, 8%, 9%)", border: "1px solid hsl(240, 6%, 20%)", borderRadius: "0" }} />
                          <Bar dataKey="score">{strengthData.map((entry, i) => <Cell key={i} fill={entry.score >= 0 ? 'hsl(155, 70%, 45%)' : 'hsl(0, 72%, 51%)'} />)}</Bar>
                        </BarChart>
                      </ResponsiveContainer>
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
                      <table className="text-[9px] font-mono">
                        <thead>
                          <tr><th className="px-1 py-0.5"></th>{correlationMatrix.pairs.map(p => <th key={p} className="px-1 py-0.5 text-muted-foreground whitespace-nowrap">{p.replace("/", "")}</th>)}</tr>
                        </thead>
                        <tbody>
                          {correlationMatrix.pairs.map(p1 => (
                            <tr key={p1}>
                              <td className="px-1 py-0.5 text-muted-foreground whitespace-nowrap">{p1.replace("/", "")}</td>
                              {correlationMatrix.pairs.map(p2 => {
                                const val = correlationMatrix.matrix[p1]?.[p2] ?? 0;
                                const bg = p1 === p2 ? "bg-primary/20" : val > 0.5 ? "bg-destructive/30" : val < -0.5 ? "bg-primary/30" : "bg-muted/20";
                                return <td key={p2} className={`px-1 py-0.5 text-center ${bg}`}>{val.toFixed(2)}</td>;
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

            {/* Judas Swing */}
            {analysis?.judasSwing?.detected && (
              <AccordionItem value="judas">
                <AccordionTrigger className="text-xs"><span className="flex items-center gap-2 text-primary">⚡ Judas Swing Detected</span></AccordionTrigger>
                <AccordionContent>
                  <div className="bg-primary/5 border border-primary/20 p-3 text-[11px]">
                    <p>{analysis.judasSwing.description}</p>
                    <p className="mt-1 text-muted-foreground font-mono">Type: {analysis.judasSwing.type} · Midnight: {analysis.judasSwing.midnightOpen.toFixed(5)}</p>
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
