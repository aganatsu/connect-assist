import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from "@/components/AppShell";
import TradingViewChart from "@/components/TradingViewChart";
import { Card, CardContent } from "@/components/ui/card";
import { INSTRUMENTS, TIMEFRAMES, getCurrentSession, isInKillzone, type Timeframe } from "@/lib/marketData";
import { marketApi, smcApi, paperApi } from "@/lib/api";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { TrendingUp, TrendingDown, Target, Shield, Activity, Clock, CheckCircle, XCircle, Zap } from "lucide-react";

export default function Chart() {
  const [selectedSymbol, setSelectedSymbol] = useState('EUR/USD');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('4h');
  const [panelOpen, setPanelOpen] = useState(true);

  // Listen for global symbol change
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.symbol) setSelectedSymbol(detail.symbol);
    };
    window.addEventListener('smc-symbol-change', handler);
    return () => window.removeEventListener('smc-symbol-change', handler);
  }, []);

  const instrument = useMemo(
    () => INSTRUMENTS.find(i => i.symbol === selectedSymbol) || INSTRUMENTS[0],
    [selectedSymbol]
  );

  const { data: quote } = useQuery({
    queryKey: ['quote', selectedSymbol],
    queryFn: () => marketApi.quote(selectedSymbol),
    refetchInterval: 10000,
  });

  const { data: candles } = useQuery({
    queryKey: ['chart-candles', selectedSymbol, selectedTimeframe],
    queryFn: () => marketApi.candles(selectedSymbol, selectedTimeframe, 200),
    staleTime: 60000,
  });

  const { data: dailyCandles } = useQuery({
    queryKey: ['chart-daily', selectedSymbol],
    queryFn: () => marketApi.candles(selectedSymbol, '1day', 30),
    staleTime: 300000,
  });

  const { data: analysis } = useQuery({
    queryKey: ['chart-smc', selectedSymbol, candles?.length],
    queryFn: () => smcApi.fullAnalysis(candles!, dailyCandles),
    enabled: !!candles && candles.length > 0,
    staleTime: 60000,
  });

  const { data: paperStatus } = useQuery({
    queryKey: ['paper-status'],
    queryFn: () => paperApi.status(),
    staleTime: 30000,
  });

  const session = getCurrentSession();
  const kz = isInKillzone();
  const balance = paperStatus?.balance ?? 10000;
  const riskPct = 1.5;
  const riskAmount = balance * (riskPct / 100);

  const bias = analysis?.bias || 'neutral';
  const structure = analysis?.structure || {};
  const orderBlocks = analysis?.orderBlocks || [];
  const fvgs = analysis?.fvgs || [];
  const activeOBs = orderBlocks.filter((ob: any) => !ob.mitigated);
  const activeFVGs = fvgs.filter((f: any) => !f.mitigated);
  const pdLevels = analysis?.pdLevels;
  const confluenceScore = analysis?.confluenceScore ?? 0;

  // Entry checklist
  const checklist = useMemo(() => {
    const items = [
      { name: "HTF Bias Confirmed", pass: bias !== 'neutral' },
      { name: "Structure Break (BOS/CHoCH)", pass: (structure.bos?.length || 0) + (structure.choch?.length || 0) > 0 },
      { name: "Order Block Present", pass: activeOBs.length > 0 },
      { name: "FVG Alignment", pass: activeFVGs.length > 0 },
      { name: "Premium/Discount Zone", pass: !!analysis?.premiumDiscount?.currentZone && analysis.premiumDiscount.currentZone !== 'equilibrium' },
      { name: "Kill Zone Active", pass: kz.active },
      { name: "PD/PW Levels Available", pass: !!pdLevels },
    ];
    const passCount = items.filter(i => i.pass).length;
    const rating = passCount >= 6 ? "A+" : passCount >= 5 ? "Strong" : passCount >= 3 ? "Moderate" : "Weak";
    return { items, passCount, total: items.length, rating };
  }, [bias, structure, activeOBs, activeFVGs, analysis, kz, pdLevels]);

  return (
    <AppShell>
      <div className="flex gap-3 h-[calc(100vh-4.5rem)]">
        {/* Chart Area */}
        <div className="flex-1 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <select value={selectedSymbol} onChange={(e) => setSelectedSymbol(e.target.value)}
              className="bg-card border border-border px-2 py-1 text-xs">
              {INSTRUMENTS.map(i => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
            </select>
            <div className="flex gap-0.5">
              {TIMEFRAMES.map(tf => (
                <button key={tf.value} onClick={() => setSelectedTimeframe(tf.value)}
                  className={`px-2 py-1 text-[10px] font-medium transition-colors ${
                    selectedTimeframe === tf.value ? 'bg-primary/20 text-primary border border-primary/40' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}>{tf.label}</button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2 text-[10px]">
              {quote && <span className="font-mono font-bold text-sm">{quote.price?.toFixed(instrument.pipSize < 0.01 ? 5 : 3)}</span>}
              {quote?.spread != null && <span className="text-muted-foreground">{quote.spread.toFixed(1)} sp</span>}
              <span className="flex items-center gap-1 text-muted-foreground"><Clock className="h-2.5 w-2.5" /> {session}</span>
              {kz.active && <span className="text-primary font-medium">⚡ {kz.name}</span>}
              <button onClick={() => setPanelOpen(!panelOpen)} className="text-muted-foreground hover:text-foreground">
                {panelOpen ? 'Hide ▶' : '◀ Show'}
              </button>
            </div>
          </div>
          <div className="flex-1"><TradingViewChart instrument={instrument} timeframe={selectedTimeframe} /></div>
        </div>

        {/* Analysis Panels */}
        {panelOpen && (
          <div className="w-60 overflow-y-auto space-y-0">
            <Accordion type="multiple" defaultValue={["confluence", "structure", "checklist", "levels", "session", "premium", "risk"]}>
              {/* Confluence Score */}
              <AccordionItem value="confluence">
                <AccordionTrigger className="text-[11px] px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <Zap className="h-3 w-3 text-primary" />
                    Confluence Score
                    <span className={`font-mono font-bold ml-auto ${confluenceScore >= 6 ? 'text-success' : confluenceScore >= 4 ? 'text-warning' : 'text-muted-foreground'}`}>
                      {confluenceScore}/10
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-2 pb-1">
                  <div className="bg-secondary/30 border border-border p-1.5 space-y-0.5 text-[10px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">HTF Bias</span>
                      <span className={bias === 'bullish' ? 'text-success' : bias === 'bearish' ? 'text-destructive' : ''}>{bias}</span>
                    </div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Trend</span>
                      <span className={structure.trend === 'bullish' ? 'text-success' : structure.trend === 'bearish' ? 'text-destructive' : ''}>{structure.trend || 'N/A'}</span>
                    </div>
                    {analysis?.reasoning?.slice(0, 3).map((r: string, i: number) => (
                      <p key={i} className="text-[9px] text-muted-foreground">• {r}</p>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Market Structure */}
              <AccordionItem value="structure">
                <AccordionTrigger className="text-[11px] px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <Activity className="h-3 w-3 text-primary" />
                    Market Structure
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-2 pb-1">
                  <div className="bg-secondary/30 border border-border p-1.5 space-y-0.5 text-[10px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">BOS</span><span className="font-mono">{structure.bos?.length || 0}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">CHoCH</span><span className="font-mono">{structure.choch?.length || 0}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Active OBs</span><span className="font-mono">{activeOBs.length}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Unfilled FVGs</span><span className="font-mono">{activeFVGs.length}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Liquidity Pools</span><span className="font-mono">{analysis?.liquidityPools?.length || 0}</span></div>
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Entry Checklist */}
              <AccordionItem value="checklist">
                <AccordionTrigger className="text-[11px] px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle className="h-3 w-3 text-primary" />
                    Entry Checklist
                    <span className={`text-[9px] font-bold ml-auto ${
                      checklist.rating === 'A+' ? 'text-success' : checklist.rating === 'Strong' ? 'text-success' : checklist.rating === 'Moderate' ? 'text-warning' : 'text-destructive'
                    }`}>{checklist.passCount}/{checklist.total} — {checklist.rating}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-2 pb-1">
                  <div className="bg-secondary/30 border border-border p-1.5 space-y-0.5">
                    {checklist.items.map((item, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[10px]">
                        {item.pass ? <CheckCircle className="h-2.5 w-2.5 text-success shrink-0" /> : <XCircle className="h-2.5 w-2.5 text-destructive shrink-0" />}
                        <span className={item.pass ? "text-foreground" : "text-muted-foreground"}>{item.name}</span>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Session / Kill Zone */}
              <AccordionItem value="session">
                <AccordionTrigger className="text-[11px] px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3 w-3 text-primary" />
                    Session / Kill Zone
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-2 pb-1">
                  <div className="bg-secondary/30 border border-border p-1.5 space-y-0.5 text-[10px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">Current Session</span><span>{session}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Kill Zone</span>
                      <span className={kz.active ? 'text-primary font-medium' : 'text-muted-foreground'}>{kz.active ? kz.name : 'None'}</span>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Premium / Discount */}
              {analysis?.premiumDiscount && (
                <AccordionItem value="premium">
                  <AccordionTrigger className="text-[11px] px-2 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <Target className="h-3 w-3 text-primary" />
                      Premium / Discount
                      <span className="text-[9px] font-medium ml-auto">{analysis.premiumDiscount.currentZone}</span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="px-2 pb-1">
                    <div className="bg-secondary/30 border border-border p-1.5 space-y-1.5">
                      <div className="relative h-16 border border-border overflow-hidden">
                        <div className="absolute top-0 left-0 right-0 h-1/3 bg-destructive/10 flex items-center px-1.5">
                          <span className="text-[8px] text-destructive font-medium">PREMIUM</span>
                        </div>
                        <div className="absolute top-1/3 left-0 right-0 h-1/3 bg-muted/20 flex items-center justify-center border-y border-dashed border-muted-foreground/30">
                          <span className="text-[8px] text-muted-foreground font-mono">{analysis.premiumDiscount.equilibrium.toFixed(5)}</span>
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-success/10 flex items-center px-1.5">
                          <span className="text-[8px] text-success font-medium">DISCOUNT</span>
                        </div>
                        <div className="absolute left-1/2 w-2 h-2 bg-primary -translate-x-1/2 -translate-y-1/2 z-10"
                          style={{ top: `${100 - analysis.premiumDiscount.zonePercent}%` }} />
                      </div>
                      <div className="flex justify-between text-[9px] text-muted-foreground font-mono">
                        <span>H: {analysis.premiumDiscount.swingHigh.toFixed(5)}</span>
                        <span className="text-primary">{analysis.premiumDiscount.zonePercent.toFixed(0)}%</span>
                        <span>L: {analysis.premiumDiscount.swingLow.toFixed(5)}</span>
                      </div>
                      {analysis.premiumDiscount.oteZone && <p className="text-[9px] text-primary font-medium">✦ OTE Zone Active</p>}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* Judas Swing */}
              {analysis?.judasSwing?.detected && (
                <AccordionItem value="judas">
                  <AccordionTrigger className="text-[11px] px-2 py-1.5">
                    <span className="flex items-center gap-1.5 text-primary">
                      ⚡ Judas Swing
                      <span className="text-[9px] ml-auto">{analysis.judasSwing.type}</span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="px-2 pb-1">
                    <div className="bg-primary/5 border border-primary/20 p-1.5 text-[10px]">
                      <p>{analysis.judasSwing.description}</p>
                      <p className="mt-0.5 text-muted-foreground font-mono">Midnight Open: {analysis.judasSwing.midnightOpen.toFixed(5)}</p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* Key Levels */}
              <AccordionItem value="levels">
                <AccordionTrigger className="text-[11px] px-2 py-1.5">
                  <span className="flex items-center gap-1.5"><Target className="h-3 w-3 text-warning" /> Key Levels</span>
                </AccordionTrigger>
                <AccordionContent className="px-2 pb-1">
                  <div className="bg-secondary/30 border border-border p-1.5 space-y-0.5 text-[10px]">
                    {pdLevels ? (
                      <>
                        <div className="flex justify-between"><span className="text-muted-foreground">PDH</span><span className="font-mono">{pdLevels.pdh?.toFixed(5)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">PDL</span><span className="font-mono">{pdLevels.pdl?.toFixed(5)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">PWH</span><span className="font-mono">{pdLevels.pwh?.toFixed(5)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">PWL</span><span className="font-mono">{pdLevels.pwl?.toFixed(5)}</span></div>
                      </>
                    ) : <span className="text-muted-foreground">Loading...</span>}
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Risk Calculator */}
              <AccordionItem value="risk">
                <AccordionTrigger className="text-[11px] px-2 py-1.5">
                  <span className="flex items-center gap-1.5"><Shield className="h-3 w-3 text-primary" /> Risk Calculator</span>
                </AccordionTrigger>
                <AccordionContent className="px-2 pb-1">
                  <div className="bg-secondary/30 border border-border p-1.5 space-y-0.5 text-[10px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span className="font-mono">${balance.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Risk %</span><span className="font-mono">{riskPct}%</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Risk $</span><span className="font-mono text-destructive">${riskAmount.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">1:2 Target</span><span className="font-mono text-success">${(riskAmount * 2).toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">1:3 Target</span><span className="font-mono text-success">${(riskAmount * 3).toFixed(2)}</span></div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        )}
      </div>
    </AppShell>
  );
}
