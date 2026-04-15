import { useState, useMemo } from 'react';
import { AppShell } from "@/components/AppShell";
import TradingViewChart from "@/components/TradingViewChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { INSTRUMENTS, TIMEFRAMES, type Instrument, type Timeframe } from "@/lib/marketData";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { TrendingUp, TrendingDown, Target, Shield, Activity } from "lucide-react";

export default function Chart() {
  const [selectedSymbol, setSelectedSymbol] = useState('EUR/USD');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('4h');
  const [panelOpen, setPanelOpen] = useState(true);

  const instrument = useMemo(
    () => INSTRUMENTS.find(i => i.symbol === selectedSymbol) || INSTRUMENTS[0],
    [selectedSymbol]
  );

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
            <button
              onClick={() => setPanelOpen(!panelOpen)}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              {panelOpen ? 'Hide Panels ▶' : '◀ Show Panels'}
            </button>
          </div>

          {/* TradingView Chart */}
          <div className="flex-1">
            <TradingViewChart instrument={instrument} timeframe={selectedTimeframe} />
          </div>
        </div>

        {/* Analysis Panels */}
        {panelOpen && (
          <div className="w-80 overflow-y-auto space-y-2">
            <Accordion type="multiple" defaultValue={["bias", "structure", "levels"]}>
              <AccordionItem value="bias">
                <AccordionTrigger className="text-sm px-3">
                  <span className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-success" />
                    Market Bias
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3">
                  <Card className="border-0 bg-secondary/30">
                    <CardContent className="pt-3 pb-2 space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-muted-foreground">HTF Bias</span><span className="text-success">Bullish</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">LTF Bias</span><span className="text-success">Bullish</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Confidence</span><span>72%</span></div>
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
                      <div className="flex justify-between"><span className="text-muted-foreground">Trend</span><span className="text-success">Uptrend</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Last BOS</span><span>1.0855</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Last CHoCH</span><span>1.0820</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Structure</span><span>HH / HL</span></div>
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
                      <div className="flex justify-between"><span className="text-muted-foreground">Resistance</span><span>1.0920</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Support</span><span>1.0780</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Order Block</span><span>1.0810-1.0825</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">FVG</span><span>1.0845-1.0860</span></div>
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
                      <div className="flex justify-between"><span className="text-muted-foreground">Account Risk</span><span>1.5%</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Position Size</span><span>0.15 lots</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Risk:Reward</span><span className="text-success">1:3.2</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Risk $</span><span className="text-destructive">$150.00</span></div>
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
