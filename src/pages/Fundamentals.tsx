import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fundamentalsApi } from "@/lib/api";
import { Calendar, Clock, AlertTriangle, TrendingUp, TrendingDown, Minus, Brain, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const IMPACT_COLORS: Record<string, string> = {
  high: "bg-destructive/20 text-destructive border-destructive/30",
  medium: "bg-warning/20 text-warning border-warning/30",
  low: "bg-muted/20 text-muted-foreground border-muted/30",
};

const DIRECTION_COLORS: Record<string, string> = {
  bullish: "text-success",
  bearish: "text-destructive",
  neutral: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const PAIRS_FOR_CURRENCY: Record<string, string[]> = {
  USD: ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD", "USD/CHF"],
  EUR: ["EUR/USD", "EUR/GBP", "EUR/JPY"],
  GBP: ["GBP/USD", "EUR/GBP", "GBP/JPY"],
  JPY: ["USD/JPY", "EUR/JPY", "GBP/JPY"],
  AUD: ["AUD/USD"],
  CAD: ["USD/CAD"],
  NZD: ["NZD/USD"],
  CHF: ["USD/CHF"],
};

function getCountdown(eventTime: string): string {
  const diff = new Date(eventTime).getTime() - Date.now();
  if (diff <= 0) return "Passed";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

function DirectionIcon({ dir }: { dir: string }) {
  if (dir === "bullish") return <TrendingUp className="h-3.5 w-3.5" />;
  if (dir === "bearish") return <TrendingDown className="h-3.5 w-3.5" />;
  return <Minus className="h-3.5 w-3.5" />;
}

export default function Fundamentals() {
  const [filterImpact, setFilterImpact] = useState<string>("all");
  const [filterCurrency, setFilterCurrency] = useState<string>("all");
  const [showInterpretation, setShowInterpretation] = useState(true);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
  const [, setTick] = useState(0);

  // Refresh countdowns every minute
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(iv);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["fundamentals"],
    queryFn: () => fundamentalsApi.data(),
    staleTime: 300000,
  });

  // Fetch news impact interpretation
  const { data: impactData, isLoading: impactLoading } = useQuery({
    queryKey: ["news-impact"],
    queryFn: () => fundamentalsApi.newsImpact(),
    staleTime: 300000,
  });

  const events: any[] = data?.upcomingEvents || data?.thisWeekEvents || [];
  const impacts: any[] = impactData?.impacts || [];

  const filtered = events.filter((e: any) => {
    if (filterImpact !== "all" && e.impact !== filterImpact) return false;
    if (filterCurrency !== "all" && e.currency !== filterCurrency) return false;
    return true;
  });

  const currencies = [...new Set(events.map((e: any) => e.currency))].filter(Boolean).sort();

  // Aggregate directional bias per currency from impacts
  const currencyBias = useMemo(() => {
    const biasMap: Record<string, { bullish: number; bearish: number; neutral: number; total: number; topReason: string }> = {};
    impacts.forEach((imp: any) => {
      const ccy = imp.currency;
      if (!biasMap[ccy]) biasMap[ccy] = { bullish: 0, bearish: 0, neutral: 0, total: 0, topReason: "" };
      biasMap[ccy].total++;
      if (imp.directionalImpact === "bullish") biasMap[ccy].bullish++;
      else if (imp.directionalImpact === "bearish") biasMap[ccy].bearish++;
      else biasMap[ccy].neutral++;
      if (!biasMap[ccy].topReason && imp.reasoning) biasMap[ccy].topReason = imp.reasoning;
    });
    return biasMap;
  }, [impacts]);

  // Match events to their impact interpretation
  const getImpactForEvent = (event: any) => {
    return impacts.find((imp: any) =>
      imp.name === event.name && imp.currency === event.currency
    );
  };

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Calendar className="h-6 w-6" /> Economic Calendar
            </h1>
            <p className="text-sm text-muted-foreground">Fundamental events with AI interpretation</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowInterpretation(!showInterpretation)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                showInterpretation ? "bg-primary/10 border-primary/30 text-primary" : "bg-card border-border text-muted-foreground"
              }`}
            >
              <Brain className="h-3 w-3" />
              Interpretation
            </button>
            <select value={filterImpact} onChange={e => setFilterImpact(e.target.value)}
              className="bg-card border border-border rounded px-2 py-1 text-xs">
              <option value="all">All Impact</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select value={filterCurrency} onChange={e => setFilterCurrency(e.target.value)}
              className="bg-card border border-border rounded px-2 py-1 text-xs">
              <option value="all">All Currencies</option>
              {currencies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Currency Bias Summary — from news impact interpretation */}
        {showInterpretation && impacts.length > 0 && (
          <Card className="border-primary/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Brain className="h-4 w-4 text-primary" />
                News-Driven Currency Bias
                <span className="text-[10px] text-muted-foreground font-normal">(±6h window)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                {Object.entries(currencyBias).sort(([,a], [,b]) => b.total - a.total).map(([ccy, bias]) => {
                  const net = bias.bullish - bias.bearish;
                  const dir = net > 0 ? "bullish" : net < 0 ? "bearish" : "neutral";
                  return (
                    <div key={ccy} className="p-2 bg-secondary/30 border border-border rounded text-center">
                      <p className="text-xs font-bold">{ccy}</p>
                      <div className={`flex items-center justify-center gap-1 ${DIRECTION_COLORS[dir]}`}>
                        <DirectionIcon dir={dir} />
                        <span className="text-[10px] font-medium capitalize">{dir}</span>
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-0.5">
                        {bias.bullish}↑ {bias.bearish}↓ {bias.neutral}—
                      </p>
                    </div>
                  );
                })}
              </div>
              {impactLoading && <p className="text-[10px] text-muted-foreground mt-2">Loading interpretation...</p>}
            </CardContent>
          </Card>
        )}

        {/* Event List */}
        {isLoading ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Loading economic events...</CardContent></Card>
        ) : filtered.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">No events found for the selected filters.</CardContent></Card>
        ) : (
          <div className="space-y-2">
            {filtered.map((event: any, i: number) => {
              const affectedPairs = PAIRS_FOR_CURRENCY[event.currency] || [];
              const countdown = event.scheduledTime ? getCountdown(event.scheduledTime) : "";
              const impact = showInterpretation ? getImpactForEvent(event) : null;
              const isExpanded = expandedEvent === i;
              return (
                <Card key={i} className={impact ? "border-l-2 border-l-primary/40" : ""}>
                  <CardContent className="pt-3 pb-3">
                    <div
                      className="flex items-start justify-between gap-4 cursor-pointer"
                      onClick={() => setExpandedEvent(isExpanded ? null : i)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className={`text-[10px] ${IMPACT_COLORS[event.impact] || IMPACT_COLORS.low}`}>
                            {event.impact === 'high' && <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />}
                            {event.impact?.toUpperCase()}
                          </Badge>
                          <span className="text-xs font-bold">{event.currency}</span>
                          <span className="text-xs text-muted-foreground">{event.scheduledTime?.split('T')[0]}</span>
                          {impact && (
                            <span className={`flex items-center gap-0.5 text-[10px] font-medium ${DIRECTION_COLORS[impact.directionalImpact]}`}>
                              <DirectionIcon dir={impact.directionalImpact} />
                              {impact.directionalImpact}
                              {impact.confidence > 0 && <span className="text-muted-foreground ml-0.5">({impact.confidence}%)</span>}
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-medium truncate">{event.name || event.title || event.event}</p>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                          {event.forecast != null && <span>Forecast: {event.forecast}</span>}
                          {event.previous != null && <span>Previous: {event.previous}</span>}
                          {event.actual != null && (
                            <span className="font-medium text-foreground">Actual: {event.actual}</span>
                          )}
                        </div>
                        {affectedPairs.length > 0 && (
                          <div className="flex gap-1 mt-1.5 flex-wrap">
                            {affectedPairs.map(p => (
                              <span key={p} className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/50 text-muted-foreground">{p}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0 flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span>{countdown}</span>
                        </div>
                        {impact && (
                          isExpanded
                            ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                    </div>

                    {/* Expanded Interpretation */}
                    {isExpanded && impact && (
                      <div className="mt-3 pt-3 border-t border-border/50">
                        <div className="flex items-start gap-2">
                          <Zap className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                          <div className="space-y-1.5">
                            <p className="text-xs text-foreground">{impact.reasoning}</p>
                            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                              <span>Category: <strong className="text-foreground capitalize">{impact.category?.replace(/_/g, " ")}</strong></span>
                              <span>Confidence: <strong className="text-foreground">{impact.confidence}%</strong></span>
                              <span>Direction: <strong className={DIRECTION_COLORS[impact.directionalImpact]}>{impact.directionalImpact}</strong></span>
                            </div>
                            {/* Trading implication */}
                            <div className="p-2 bg-secondary/30 rounded text-[10px]">
                              <p className="font-medium text-foreground mb-0.5">Trading Implication:</p>
                              <p className="text-muted-foreground">
                                {impact.directionalImpact === "bullish" && `${event.currency} strength expected — look for long setups on ${event.currency}/X pairs, shorts on X/${event.currency} pairs.`}
                                {impact.directionalImpact === "bearish" && `${event.currency} weakness expected — look for short setups on ${event.currency}/X pairs, longs on X/${event.currency} pairs.`}
                                {impact.directionalImpact === "neutral" && `Neutral impact — no strong directional bias from this event. Trade based on technicals.`}
                                {impact.directionalImpact === "unknown" && `Impact unclear — insufficient data to determine direction. Avoid trading ${event.currency} pairs around this event.`}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
