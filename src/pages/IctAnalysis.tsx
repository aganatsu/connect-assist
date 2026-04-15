import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Clock, BarChart3, Grid3X3, Target, Calendar } from "lucide-react";
import { smcApi, marketApi } from "@/lib/api";

const SYMBOLS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "AUD/USD", "USD/CAD", "XAU/USD", "BTC/USD"];

const SESSIONS = [
  { name: "Sydney", start: 21, end: 6, color: "hsl(270, 55%, 70%)" },
  { name: "Asian", start: 0, end: 8, color: "hsl(280, 60%, 65%)" },
  { name: "London", start: 7, end: 16, color: "hsl(210, 100%, 52%)" },
  { name: "New York", start: 12, end: 21, color: "hsl(38, 92%, 50%)" },
];

const KILL_ZONES = [
  { name: "Asian KZ", start: 0, end: 3, color: "hsl(280, 60%, 65%)" },
  { name: "London KZ", start: 7, end: 9, color: "hsl(210, 100%, 52%)" },
  { name: "NY KZ", start: 12, end: 14, color: "hsl(38, 92%, 50%)" },
  { name: "London Close KZ", start: 15, end: 16, color: "hsl(142, 72%, 45%)" },
];

export default function IctAnalysis() {
  const [selectedSymbol, setSelectedSymbol] = useState("EUR/USD");
  const currentHour = new Date().getUTCHours();

  // Fetch candles for selected symbol
  const { data: candles } = useQuery({
    queryKey: ["candles", selectedSymbol],
    queryFn: () => marketApi.candles(selectedSymbol, "1h", 200),
    staleTime: 60000,
  });

  const { data: dailyCandles } = useQuery({
    queryKey: ["daily-candles", selectedSymbol],
    queryFn: () => marketApi.candles(selectedSymbol, "1day", 30),
    staleTime: 300000,
  });

  // Run SMC analysis
  const { data: analysis, isLoading: analysisLoading } = useQuery({
    queryKey: ["smc-analysis", selectedSymbol, candles?.length],
    queryFn: () => smcApi.fullAnalysis(candles!, dailyCandles),
    enabled: !!candles && candles.length > 0,
    staleTime: 60000,
  });

  // Session info
  const { data: sessionInfo } = useQuery({
    queryKey: ["session-info"],
    queryFn: () => smcApi.session(),
    refetchInterval: 60000,
  });

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">ICT Analysis</h1>
            {analysis && (
              <p className="text-sm text-muted-foreground">
                Confluence: <span className="text-primary font-bold">{analysis.confluenceScore}/10</span>
                {" · "}Bias: <span className={analysis.bias === "bullish" ? "text-success" : analysis.bias === "bearish" ? "text-destructive" : "text-muted-foreground"}>{analysis.bias}</span>
              </p>
            )}
          </div>
          <select value={selectedSymbol} onChange={e => setSelectedSymbol(e.target.value)} className="bg-card border border-border rounded px-3 py-1.5 text-sm">
            {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Reasoning */}
        {analysis?.reasoning && analysis.reasoning.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <div className="space-y-1">
                {analysis.reasoning.map((r: string, i: number) => (
                  <p key={i} className="text-xs text-muted-foreground">• {r}</p>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Accordion type="multiple" defaultValue={["session", "structure", "strength", "premium", "pdpw"]}>
          {/* Session Map */}
          <AccordionItem value="session">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Clock className="h-4 w-4" /> Session Map & Kill Zones</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4">
                  <div className="space-y-3">
                    <div className="relative h-20">
                      <div className="absolute inset-0 flex">
                        {Array.from({ length: 24 }, (_, h) => (
                          <div key={h} className="flex-1 border-r border-border/30 relative">
                            {h % 3 === 0 && <span className="absolute -bottom-5 left-0 text-[9px] text-muted-foreground">{h}:00</span>}
                          </div>
                        ))}
                      </div>
                      <div className="absolute top-0 bottom-0 w-0.5 bg-primary z-10" style={{ left: `${(currentHour / 24) * 100}%` }} />
                      {SESSIONS.map((s, i) => {
                        const start = s.start < s.end ? s.start : 0;
                        const end = s.start < s.end ? s.end : s.end;
                        return (
                          <div key={s.name} className="absolute rounded-sm opacity-40"
                            style={{ left: `${(start / 24) * 100}%`, width: `${((end - start) / 24) * 100}%`, top: `${i * 18}px`, height: "14px", backgroundColor: s.color }}>
                            <span className="text-[8px] font-medium px-1 leading-[14px] text-foreground">{s.name}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-8">
                      {KILL_ZONES.map(kz => {
                        const isActive = currentHour >= kz.start && currentHour < kz.end;
                        return (
                          <span key={kz.name} className={`px-2 py-1 rounded text-[10px] font-medium border ${isActive ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                            {kz.name} ({kz.start}:00-{kz.end}:00)
                            {isActive && <span className="ml-1 text-success">● Active</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* Market Structure */}
          <AccordionItem value="structure">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Target className="h-4 w-4" /> Market Structure</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4">
                  {analysisLoading ? <p className="text-sm text-muted-foreground">Analyzing...</p> : analysis ? (
                    <div className="space-y-3 text-xs">
                      <div className="flex gap-4">
                        <span>Trend: <strong className={analysis.structure.trend === "bullish" ? "text-success" : analysis.structure.trend === "bearish" ? "text-destructive" : ""}>{analysis.structure.trend}</strong></span>
                        <span>BOS: <strong>{analysis.structure.bos?.length || 0}</strong></span>
                        <span>CHoCH: <strong>{analysis.structure.choch?.length || 0}</strong></span>
                        <span>Swings: <strong>{analysis.structure.swingPoints?.length || 0}</strong></span>
                      </div>
                      <div className="flex gap-4">
                        <span>Active OBs: <strong>{analysis.orderBlocks?.filter((ob: any) => !ob.mitigated).length || 0}</strong></span>
                        <span>Unfilled FVGs: <strong>{analysis.fvgs?.filter((f: any) => !f.mitigated).length || 0}</strong></span>
                        <span>Liquidity Pools: <strong>{analysis.liquidityPools?.length || 0}</strong></span>
                      </div>
                    </div>
                  ) : <p className="text-sm text-muted-foreground">No data</p>}
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* Premium/Discount */}
          <AccordionItem value="premium">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Target className="h-4 w-4" /> Premium / Discount Zone</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4">
                  {analysis?.premiumDiscount ? (
                    <div className="space-y-3">
                      <div className="relative h-32 rounded border border-border overflow-hidden">
                        <div className="absolute top-0 left-0 right-0 h-1/3 bg-destructive/10 flex items-center px-3">
                          <span className="text-[10px] text-destructive font-medium">PREMIUM — Sell Zone</span>
                        </div>
                        <div className="absolute top-1/3 left-0 right-0 h-1/3 bg-muted/20 flex items-center justify-center border-y border-dashed border-muted-foreground/30">
                          <span className="text-[10px] text-muted-foreground">EQUILIBRIUM — {analysis.premiumDiscount.equilibrium.toFixed(5)}</span>
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-success/10 flex items-center px-3">
                          <span className="text-[10px] text-success font-medium">DISCOUNT — Buy Zone</span>
                        </div>
                        <div className="absolute left-1/2 w-3 h-3 rounded-full bg-primary border-2 border-primary-foreground -translate-x-1/2 -translate-y-1/2 z-10"
                          style={{ top: `${100 - analysis.premiumDiscount.zonePercent}%` }} />
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Swing High: {analysis.premiumDiscount.swingHigh.toFixed(5)}</span>
                        <span className="text-primary font-medium">Zone: {analysis.premiumDiscount.currentZone} ({analysis.premiumDiscount.zonePercent.toFixed(0)}%)</span>
                        <span>Swing Low: {analysis.premiumDiscount.swingLow.toFixed(5)}</span>
                      </div>
                      {analysis.premiumDiscount.oteZone && <p className="text-xs text-primary font-medium">✦ OTE Zone Active (Optimal Trade Entry)</p>}
                    </div>
                  ) : <p className="text-sm text-muted-foreground">Loading...</p>}
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* PD/PW Levels */}
          <AccordionItem value="pdpw">
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-2"><Calendar className="h-4 w-4" /> PD / PW Levels</span>
            </AccordionTrigger>
            <AccordionContent>
              <Card className="border-0 bg-secondary/30">
                <CardContent className="pt-4 space-y-3 text-xs">
                  {analysis?.pdLevels ? (
                    <>
                      <div><p className="text-muted-foreground mb-1 font-medium">Previous Day</p>
                        <div className="grid grid-cols-4 gap-2">
                          <div><span className="text-muted-foreground">High:</span> <span>{analysis.pdLevels.pdh.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground">Low:</span> <span>{analysis.pdLevels.pdl.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground">Open:</span> <span>{analysis.pdLevels.pdo.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground">Close:</span> <span>{analysis.pdLevels.pdc.toFixed(5)}</span></div>
                        </div></div>
                      <div><p className="text-muted-foreground mb-1 font-medium">Previous Week</p>
                        <div className="grid grid-cols-4 gap-2">
                          <div><span className="text-muted-foreground">High:</span> <span>{analysis.pdLevels.pwh.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground">Low:</span> <span>{analysis.pdLevels.pwl.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground">Open:</span> <span>{analysis.pdLevels.pwo.toFixed(5)}</span></div>
                          <div><span className="text-muted-foreground">Close:</span> <span>{analysis.pdLevels.pwc.toFixed(5)}</span></div>
                        </div></div>
                    </>
                  ) : <p className="text-muted-foreground">No daily data available</p>}
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>

          {/* Judas Swing */}
          {analysis?.judasSwing?.detected && (
            <AccordionItem value="judas">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2 text-primary">⚡ Judas Swing Detected</span>
              </AccordionTrigger>
              <AccordionContent>
                <Card className="border-0 bg-primary/5 border-primary/20">
                  <CardContent className="pt-4 text-xs">
                    <p>{analysis.judasSwing.description}</p>
                    <p className="mt-1 text-muted-foreground">Type: {analysis.judasSwing.type} · Midnight Open: {analysis.judasSwing.midnightOpen.toFixed(5)}</p>
                  </CardContent>
                </Card>
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      </div>
    </AppShell>
  );
}
