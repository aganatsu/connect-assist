import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fundamentalsApi } from "@/lib/api";
import { Calendar, Clock, AlertTriangle, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const IMPACT_COLORS: Record<string, string> = {
  high: "bg-destructive/20 text-destructive border-destructive/30",
  medium: "bg-warning/20 text-warning border-warning/30",
  low: "bg-muted/20 text-muted-foreground border-muted/30",
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

export default function Fundamentals() {
  const [filterImpact, setFilterImpact] = useState<string>("all");
  const [filterCurrency, setFilterCurrency] = useState<string>("all");
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

  const events = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];

  const filtered = events.filter((e: any) => {
    if (filterImpact !== "all" && e.impact !== filterImpact) return false;
    if (filterCurrency !== "all" && e.currency !== filterCurrency) return false;
    return true;
  });

  const currencies = [...new Set(events.map((e: any) => e.currency))].filter(Boolean).sort();

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Calendar className="h-6 w-6" /> Economic Calendar
            </h1>
            <p className="text-sm text-muted-foreground">Fundamental events affecting forex pairs</p>
          </div>
          <div className="flex items-center gap-2">
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

        {isLoading ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Loading economic events...</CardContent></Card>
        ) : filtered.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">No events found for the selected filters.</CardContent></Card>
        ) : (
          <div className="space-y-2">
            {filtered.map((event: any, i: number) => {
              const affectedPairs = PAIRS_FOR_CURRENCY[event.currency] || [];
              const countdown = event.datetime ? getCountdown(event.datetime) : "";
              return (
                <Card key={i}>
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className={`text-[10px] ${IMPACT_COLORS[event.impact] || IMPACT_COLORS.low}`}>
                            {event.impact === 'high' && <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />}
                            {event.impact?.toUpperCase()}
                          </Badge>
                          <span className="text-xs font-bold">{event.currency}</span>
                          <span className="text-xs text-muted-foreground">{event.datetime?.split('T')[0]}</span>
                        </div>
                        <p className="text-sm font-medium truncate">{event.title || event.event}</p>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                          {event.forecast != null && <span>Forecast: {event.forecast}</span>}
                          {event.previous != null && <span>Previous: {event.previous}</span>}
                          {event.actual != null && (
                            <span className="font-medium text-foreground">Actual: {event.actual}</span>
                          )}
                        </div>
                        {affectedPairs.length > 0 && (
                          <div className="flex gap-1 mt-1.5">
                            {affectedPairs.map(p => (
                              <span key={p} className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/50 text-muted-foreground">{p}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span>{countdown}</span>
                        </div>
                      </div>
                    </div>
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
