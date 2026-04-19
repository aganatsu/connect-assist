import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from "@/components/AppShell";
import TradingViewChart from "@/components/TradingViewChart";
import { Card, CardContent } from "@/components/ui/card";
import { INSTRUMENTS, TIMEFRAMES, getCurrentSession, isInKillzone, type Timeframe } from "@/lib/marketData";
import { marketApi, smcApi, paperApi, type CandleSource } from "@/lib/api";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { supabase } from "@/integrations/supabase/client";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { TrendingUp, TrendingDown, Target, Shield, Activity, Clock, CheckCircle, XCircle, Zap, Radio, ChevronRight } from "lucide-react";
import { unifyConfluence } from "@/lib/confluenceUnify";

const fx = (n: unknown, digits = 5) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";

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

  // Fetch candles WITH the data-source header (so we can show a badge).
  const { data: candleData } = useQuery({
    queryKey: ['chart-candles', selectedSymbol, selectedTimeframe],
    queryFn: () => marketApi.candlesWithMeta(selectedSymbol, selectedTimeframe, 200),
    staleTime: 60000,
  });
  const candles = candleData?.candles;
  const candleSource: CandleSource = candleData?.source ?? "unknown";

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

  // Latest bot scan signal for this symbol
  const { data: botScanSignal } = useQuery({
    queryKey: ['chart-bot-scan', selectedSymbol],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('scan_logs')
        .select('details_json, scanned_at')
        .order('scanned_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const details = Array.isArray(data?.details_json) ? data.details_json : [];
      const match = (details as any[]).find((d) => d?.pair === selectedSymbol);
      return match ? { signal: match, scannedAt: data?.scanned_at as string } : null;
    },
    refetchInterval: 30000,
    staleTime: 25000,
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
  const extScore = analysis?.extendedConfluenceScore ?? 0;
  const ext = analysis?.extendedFactors;
  const unified = useMemo(
    () => unifyConfluence({ ...analysis, killZone: kz }),
    [analysis, kz]
  );

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
              <DataSourceBadge source={candleSource} />
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
          <div className="w-96 overflow-y-auto space-y-0">
            <Accordion type="multiple" defaultValue={["confluence", "structure", "checklist", "levels", "session", "premium", "risk", "botscan"]}>
              {/* Unified Confluence */}
              <AccordionItem value="confluence">
                <AccordionTrigger className="text-xs px-3 py-2">
                  <span className="flex items-center gap-2 w-full">
                    <Zap className="h-3.5 w-3.5 text-primary" />
                    Confluence
                    <span className="ml-auto flex items-center gap-2">
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                        unified.direction === 'BUY' ? 'bg-success/20 text-success' :
                        unified.direction === 'SELL' ? 'bg-destructive/20 text-destructive' :
                        'bg-muted text-muted-foreground'
                      }`}>{unified.direction}</span>
                      <span className={`font-mono font-bold ${
                        unified.total >= 6.5 ? 'text-success' : unified.total >= 4 ? 'text-warning' : 'text-destructive'
                      }`}>{unified.total.toFixed(1)}/10</span>
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-2">
                  <div className="bg-secondary/30 border border-border p-2 space-y-2 text-[11px]">
                    {/* Sub-score breakdown */}
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground border-b border-border/50 pb-1.5">
                      <span>SMC <span className="font-mono text-foreground">{unified.smcScore}/10</span></span>
                      <span>·</span>
                      <span>Extended <span className="font-mono text-foreground">{unified.extScore}/10</span></span>
                      <span>·</span>
                      <span>{unified.passCount}/{unified.totalFactors} factors</span>
                    </div>

                    {/* Grouped factors */}
                    {unified.groups.map((g) => (
                      <div key={g.name} className="space-y-0.5">
                        <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1">
                          <ChevronRight className="h-2.5 w-2.5" />{g.name}
                        </p>
                        <div className="pl-3 space-y-0.5">
                          {g.items.map((it, i) => (
                            <FactorRow key={i} label={it.label} pass={it.pass} detail={it.detail} />
                          ))}
                        </div>
                      </div>
                    ))}

                    {analysis?.reasoning?.length > 0 && (
                      <div className="pt-1 border-t border-border/50 space-y-0.5">
                        {analysis.reasoning.slice(0, 3).map((r: string, i: number) => (
                          <p key={i} className="text-[10px] text-muted-foreground">• {r}</p>
                        ))}
                      </div>
                    )}
                    <p className="text-[9px] text-muted-foreground/70 italic">SMT divergence requires cross-pair data — see Bot Scan below</p>
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Bot Scan (live) */}
              <AccordionItem value="botscan">
                <AccordionTrigger className="text-xs px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Radio className="h-3.5 w-3.5 text-primary" />
                    Bot Scan (live)
                    {botScanSignal?.signal?.score != null && (
                      <span className={`font-mono font-bold ml-auto ${botScanSignal.signal.score >= 6 ? 'text-success' : botScanSignal.signal.score >= 4 ? 'text-warning' : 'text-muted-foreground'}`}>
                        {Number(botScanSignal.signal.score).toFixed(1)}/10
                      </span>
                    )}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-2">
                  <div className="bg-secondary/30 border border-border p-2 text-[11px]">
                    {botScanSignal?.signal ? (
                      <BotScanInline signal={botScanSignal.signal} scannedAt={botScanSignal.scannedAt} />
                    ) : (
                      <p className="text-[10px] text-muted-foreground">No recent bot scan for {selectedSymbol}. The scanner runs on its own cycle — check back soon.</p>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Market Structure */}
              <AccordionItem value="structure">
                <AccordionTrigger className="text-xs px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 text-primary" />
                    Market Structure
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-2">
                  <div className="bg-secondary/30 border border-border p-2 space-y-1 text-[11px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">BOS</span><span className="font-mono">{structure.bos?.length || 0}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">CHoCH</span><span className="font-mono">{structure.choch?.length || 0}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Active OBs</span><span className="font-mono">{activeOBs.length}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Unfilled FVGs</span><span className="font-mono">{activeFVGs.length}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Liquidity Pools</span><span className="font-mono">{analysis?.liquidityPools?.length || 0}</span></div>
                  </div>
                </AccordionContent>
              </AccordionItem>

              // ... keep existing code
                      <div className="relative h-20 border border-border overflow-hidden">
                        <div className="absolute top-0 left-0 right-0 h-1/3 bg-destructive/10 flex items-center px-2">
                          <span className="text-[10px] text-destructive font-medium">PREMIUM</span>
                        </div>
                        <div className="absolute top-1/3 left-0 right-0 h-1/3 bg-muted/20 flex items-center justify-center border-y border-dashed border-muted-foreground/30">
                          <span className="text-[10px] text-muted-foreground font-mono">{fx(analysis.premiumDiscount.equilibrium)}</span>
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-success/10 flex items-center px-2">
                          <span className="text-[10px] text-success font-medium">DISCOUNT</span>
                        </div>
                        <div className="absolute left-1/2 w-2.5 h-2.5 bg-primary -translate-x-1/2 -translate-y-1/2 z-10"
                          style={{ top: `${100 - (typeof analysis.premiumDiscount.zonePercent === 'number' ? analysis.premiumDiscount.zonePercent : 50)}%` }} />
                      </div>
                      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                        <span>H: {fx(analysis.premiumDiscount.swingHigh)}</span>
                        <span className="text-primary">{fx(analysis.premiumDiscount.zonePercent, 0)}%</span>
                        <span>L: {fx(analysis.premiumDiscount.swingLow)}</span>
                      </div>
                      {analysis.premiumDiscount.oteZone && <p className="text-[10px] text-primary font-medium">✦ OTE Zone Active</p>}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* Judas Swing */}
              {analysis?.judasSwing?.detected && (
                <AccordionItem value="judas">
                  <AccordionTrigger className="text-xs px-3 py-2">
                    <span className="flex items-center gap-2 text-primary">
                      ⚡ Judas Swing
                      <span className="text-[10px] ml-auto">{analysis.judasSwing.type}</span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="px-3 pb-2">
                    <div className="bg-primary/5 border border-primary/20 p-2 text-[11px]">
                      <p>{analysis.judasSwing.description}</p>
                      <p className="mt-1 text-muted-foreground font-mono">Midnight Open: {fx(analysis.judasSwing.midnightOpen)}</p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* Key Levels */}
              <AccordionItem value="levels">
                <AccordionTrigger className="text-xs px-3 py-2">
                  <span className="flex items-center gap-2"><Target className="h-3.5 w-3.5 text-warning" /> Key Levels</span>
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-2">
                  <div className="bg-secondary/30 border border-border p-2 space-y-1 text-[11px]">
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
                <AccordionTrigger className="text-xs px-3 py-2">
                  <span className="flex items-center gap-2"><Shield className="h-3.5 w-3.5 text-primary" /> Risk Calculator</span>
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-2">
                  <div className="bg-secondary/30 border border-border p-2 space-y-1 text-[11px]">
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

function FactorRow({ label, pass, detail }: { label: string; pass: boolean; detail?: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[10px]">
      {pass ? <CheckCircle className="h-3 w-3 text-success shrink-0 mt-0.5" /> : <XCircle className="h-3 w-3 text-muted-foreground/40 shrink-0 mt-0.5" />}
      <div className="flex-1">
        <span className={pass ? 'text-foreground font-medium' : 'text-muted-foreground'}>{label}</span>
        {detail && <span className="text-muted-foreground ml-1">— {detail}</span>}
      </div>
    </div>
  );
}

function BotScanInline({ signal: d, scannedAt }: { signal: any; scannedAt?: string }) {
  const status = d.status === 'trade_placed' ? 'PLACED' : d.status === 'rejected' ? 'REJECTED' : d.status === 'below_threshold' ? 'SKIP' : (d.status?.toUpperCase() || '—');
  const statusColor = d.status === 'trade_placed' ? 'text-success' : d.status === 'rejected' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {d.direction === 'long' ? <TrendingUp className="h-3 w-3 text-success" /> : d.direction === 'short' ? <TrendingDown className="h-3 w-3 text-destructive" /> : null}
        <span className="text-[10px] font-bold">{d.pair}</span>
        <span className={`text-[9px] font-bold ${statusColor}`}>{status}</span>
        {scannedAt && <span className="text-[9px] text-muted-foreground ml-auto">{new Date(scannedAt).toLocaleTimeString()}</span>}
      </div>
      {d.reason && (
        <div className="rounded border border-border bg-muted/20 px-2 py-1.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Why</p>
          <p className="mt-0.5 text-[10px]">{d.reason}</p>
        </div>
      )}
      {d.factors && (
        <div className="space-y-0.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Factors ({d.factorCount || d.factors.length})</p>
          {d.factors.map((f: any, i: number) => (
            <div key={i} className="flex items-start gap-1 text-[9px]">
              <span className={f.present ? 'text-success' : 'text-muted-foreground/50'}>{f.present ? '✓' : '✗'}</span>
              <div>
                <span className={f.present ? 'text-foreground' : 'text-muted-foreground/60'}>{f.name}</span>
                {f.detail && <span className="text-muted-foreground ml-1">— {f.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {d.rejectionReasons?.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[8px] text-destructive uppercase tracking-wider font-bold">Rejected</p>
          {d.rejectionReasons.map((r: string, i: number) => (
            <p key={i} className="text-[9px] text-destructive">⚠ {r}</p>
          ))}
        </div>
      )}
      {d.summary && <p className="text-[9px] text-muted-foreground italic">{d.summary}</p>}
    </div>
  );
}
