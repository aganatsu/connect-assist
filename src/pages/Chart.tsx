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
import { TrendingUp, TrendingDown, Target, Shield, Activity, Clock } from "lucide-react";

export default function Chart() {
  const [selectedSymbol, setSelectedSymbol] = useState('EUR/USD');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('4h');
  const [panelOpen, setPanelOpen] = useState(true);

  const instrument = useMemo(
    () => INSTRUMENTS.find(i => i.symbol === selectedSymbol) || INSTRUMENTS[0],
    [selectedSymbol]
  );

  // Live quote polling
  const { data: quote } = useQuery({
    queryKey: ['quote', selectedSymbol],
    queryFn: () => marketApi.quote(selectedSymbol),
    refetchInterval: 10000,
  });

  // Candles for SMC analysis
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

  // SMC analysis
  const { data: analysis, isLoading: analysisLoading } = useQuery({
    queryKey: ['chart-smc', selectedSymbol, candles?.length],
    queryFn: () => smcApi.fullAnalysis(candles!, dailyCandles),
    enabled: !!candles && candles.length > 0,
    staleTime: 60000,
  });

  // Paper account for risk calc
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

  // Derive bias/structure from analysis
  const bias = analysis?.bias || 'neutral';
  const structure = analysis?.structure || {};
  const orderBlocks = analysis?.orderBlocks || [];
  const fvgs = analysis?.fvgs || [];
  const activeOBs = orderBlocks.filter((ob: any) => !ob.mitigated);
  const activeFVGs = fvgs.filter((f: any) => !f.mitigated);

  // Key levels
  const pdLevels = analysis?.pdLevels;
  const nearestOB = activeOBs[0];
  const nearestFVG = activeFVGs[0];

  return (
    <AppShell>
      <div className="flex gap-4 h-[calc(100vh-7rem)]">
        {/* Chart Area */}
        <div className="flex-1 flex flex-col gap-3">
          {/* Controls */}
          <div className="flex items-center gap-3">
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              className="bg-card border border-border rounded px-3 py-1.5 text-sm"
            >
              {INSTRUMENTS.map(i => (
                <option key={i.symbol} value={i.symbol}>{i.symbol}</option>
              ))}
            </select>
            <div className="flex gap-1">
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf.value}
                  onClick={() => setSelectedTimeframe(tf.value)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    selectedTimeframe === tf.value
                      ? 'bg-primary/20 text-primary border border-primary/40'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
            {/* Live price + session */}
            <div className="ml-auto flex items-center gap-3 text-xs">
              {quote && (
                <span className="font-mono font-bold text-sm">
                  {quote.price?.toFixed(instrument.pipSize < 0.01 ? 5 : 3)}
                </span>
              )}
              {quote?.spread != null && (
                <span className="text-muted-foreground">{quote.spread.toFixed(1)} sp</span>
              )}
              <span className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-3 w-3" /> {session}
              </span>
              {kz.active && (
                <span className="text-primary font-medium">⚡ {kz.name}</span>
              )}
              <button
                onClick={() => setPanelOpen(!panelOpen)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {panelOpen ? 'Hide ▶' : '◀ Show'}
              </button>
            </div>
          </div>

          {/* TradingView Chart */}
          <div className="flex-1">
            <TradingViewChart instrument={instrument} timeframe={selectedTimeframe} />
          </div>
        </div>

        {/* Analysis Panels */}
        {panelOpen && (
          <div className="w-80 overflow-y-auto space-y-2">
            <Accordion type="multiple" defaultValue={["bias", "structure", "levels", "risk"]}>
              <AccordionItem value="bias">
                <AccordionTrigger className="text-sm px-3">
                  <span className="flex items-center gap-2">
                    {bias === 'bullish' ? <TrendingUp className="h-4 w-4 text-success" /> : bias === 'bearish' ? <TrendingDown className="h-4 w-4 text-destructive" /> : <Activity className="h-4 w-4 text-muted-foreground" />}
                    Market Bias
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3">
                  <Card className="border-0 bg-secondary/30">
                    <CardContent className="pt-3 pb-2 space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">HTF Bias</span>
                        <span className={bias === 'bullish' ? 'text-success' : bias === 'bearish' ? 'text-destructive' : ''}>{bias}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Trend</span>
                        <span className={structure.trend === 'bullish' ? 'text-success' : structure.trend === 'bearish' ? 'text-destructive' : ''}>{structure.trend || 'N/A'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Confluence</span>
                        <span className="text-primary font-bold">{analysis?.confluenceScore ?? '—'}/10</span>
                      </div>
                    </CardContent>
                  </Card>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="structure">
                <AccordionTrigger className="text-sm px-3">
                  <span className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    Market Structure
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3">
                  <Card className="border-0 bg-secondary/30">
                    <CardContent className="pt-3 pb-2 space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">BOS Count</span>
                        <span>{structure.bos?.length || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">CHoCH Count</span>
                        <span>{structure.choch?.length || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Active OBs</span>
                        <span>{activeOBs.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Unfilled FVGs</span>
                        <span>{activeFVGs.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Liquidity Pools</span>
                        <span>{analysis?.liquidityPools?.length || 0}</span>
                      </div>
                    </CardContent>
                  </Card>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="levels">
                <AccordionTrigger className="text-sm px-3">
                  <span className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-warning" />
                    Key Levels
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3">
                  <Card className="border-0 bg-secondary/30">
                    <CardContent className="pt-3 pb-2 space-y-2 text-xs">
                      {pdLevels ? (
                        <>
                          <div className="flex justify-between"><span className="text-muted-foreground">PDH</span><span>{pdLevels.pdh?.toFixed(5)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">PDL</span><span>{pdLevels.pdl?.toFixed(5)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">PWH</span><span>{pdLevels.pwh?.toFixed(5)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">PWL</span><span>{pdLevels.pwl?.toFixed(5)}</span></div>
                        </>
                      ) : <span className="text-muted-foreground">Loading levels...</span>}
                      {nearestOB && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Nearest OB</span>
                          <span>{nearestOB.low?.toFixed(5)}-{nearestOB.high?.toFixed(5)}</span>
                        </div>
                      )}
                      {nearestFVG && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Nearest FVG</span>
                          <span>{nearestFVG.low?.toFixed(5)}-{nearestFVG.high?.toFixed(5)}</span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="risk">
                <AccordionTrigger className="text-sm px-3">
                  <span className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-primary" />
                    Risk Calculator
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3">
                  <Card className="border-0 bg-secondary/30">
                    <CardContent className="pt-3 pb-2 space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span>${balance.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Risk %</span><span>{riskPct}%</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Risk $</span><span className="text-destructive">${riskAmount.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">1:2 Target</span><span className="text-success">${(riskAmount * 2).toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">1:3 Target</span><span className="text-success">${(riskAmount * 3).toFixed(2)}</span></div>
                    </CardContent>
                  </Card>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        )}
      </div>
    </AppShell>
  );
}
