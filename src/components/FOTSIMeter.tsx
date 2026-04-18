import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fotsiScannerApi } from "@/lib/api";
import { toast } from "sonner";
import {
  TrendingUp, TrendingDown, Minus, Activity, RefreshCw,
  ArrowUpRight, ArrowDownRight, BarChart3, Zap,
} from "lucide-react";

// ─── FOTSI Constants (mirrored from backend) ──────────────────────
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "NZD"] as const;
type Currency = (typeof CURRENCIES)[number];

const OB_THRESHOLD = 50;
const OS_THRESHOLD = -50;
const NEUTRAL_UPPER = 25;
const NEUTRAL_LOWER = -25;

// Currency flag emojis for visual flair
const FLAGS: Record<Currency, string> = {
  EUR: "🇪🇺", USD: "🇺🇸", GBP: "🇬🇧", CHF: "🇨🇭",
  JPY: "🇯🇵", AUD: "🇦🇺", CAD: "🇨🇦", NZD: "🇳🇿",
};

function classifyZone(val: number): "overbought" | "oversold" | "bullish" | "bearish" | "neutral" {
  if (val >= OB_THRESHOLD) return "overbought";
  if (val <= OS_THRESHOLD) return "oversold";
  if (val > NEUTRAL_UPPER) return "bullish";
  if (val < NEUTRAL_LOWER) return "bearish";
  return "neutral";
}

function zoneColor(zone: string): string {
  switch (zone) {
    case "overbought": return "text-red-400";
    case "oversold": return "text-emerald-400";
    case "bullish": return "text-blue-400";
    case "bearish": return "text-orange-400";
    default: return "text-muted-foreground";
  }
}

function zoneBg(zone: string): string {
  switch (zone) {
    case "overbought": return "bg-red-500/20 border-red-500/40";
    case "oversold": return "bg-emerald-500/20 border-emerald-500/40";
    case "bullish": return "bg-blue-500/15 border-blue-500/30";
    case "bearish": return "bg-orange-500/15 border-orange-500/30";
    default: return "bg-muted/20 border-border";
  }
}

function barColor(val: number): string {
  if (val >= OB_THRESHOLD) return "bg-red-500";
  if (val <= OS_THRESHOLD) return "bg-emerald-500";
  if (val > NEUTRAL_UPPER) return "bg-blue-500";
  if (val < NEUTRAL_LOWER) return "bg-orange-500";
  return "bg-muted-foreground/40";
}

interface FOTSIMeterProps {
  /** Compact mode for embedding in the bot control bar */
  compact?: boolean;
}

export function FOTSIMeter({ compact = false }: FOTSIMeterProps) {
  const [activeTab, setActiveTab] = useState<"meter" | "pairs">("meter");

  // Fetch Bot #2 status which includes FOTSI strengths and positions
  const { data: botStatus, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["fotsi-status"],
    queryFn: () => fotsiScannerApi.status(),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  // Fetch scan logs for latest scan details
  const { data: scanLogsData } = useQuery({
    queryKey: ["fotsi-scan-logs"],
    queryFn: () => fotsiScannerApi.scanLogs(),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const scanLogs = scanLogsData?.logs ?? [];
  const latestScan = scanLogs.length > 0 ? scanLogs[0] : null;

  // Parse FOTSI strengths from the latest scan details
  // The scan log details contain the FOTSI data
  let strengths: Record<Currency, number> = {} as any;
  let rankedPairs: any[] = [];

  if (latestScan?.details) {
    try {
      const details = typeof latestScan.details === "string"
        ? JSON.parse(latestScan.details)
        : latestScan.details;

      if (details.fotsiStrengths) {
        strengths = details.fotsiStrengths;
      }
      if (details.rankedPairs) {
        rankedPairs = details.rankedPairs;
      }
    } catch {}
  }

  // Sort currencies by strength (strongest first)
  const sorted = [...CURRENCIES].sort((a, b) => (strengths[b] ?? 0) - (strengths[a] ?? 0));
  const hasData = Object.keys(strengths).length > 0;

  // ─── Compact Mode (mini-bar for control bar) ─────────────────────
  if (compact) {
    return (
      <div className="flex items-center gap-1.5" title="FOTSI Currency Strength">
        <Activity className="h-3 w-3 text-primary shrink-0" />
        {hasData ? (
          sorted.slice(0, 4).map(ccy => {
            const val = strengths[ccy] ?? 0;
            const zone = classifyZone(val);
            return (
              <span key={ccy} className={`text-[9px] font-mono font-bold ${zoneColor(zone)}`}>
                {ccy}{val > 0 ? "+" : ""}{val.toFixed(0)}
              </span>
            );
          })
        ) : (
          <span className="text-[9px] text-muted-foreground">No FOTSI data</span>
        )}
      </div>
    );
  }

  // ─── Full Mode ───────────────────────────────────────────────────
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-bold">FOTSI Currency Strength</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {latestScan && (
              <span className="text-[9px] text-muted-foreground font-mono">
                Last scan: {new Date(latestScan.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => { refetch(); toast.info("Refreshing FOTSI data..."); }}
              disabled={isFetching}
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-xs text-muted-foreground">Loading FOTSI data...</span>
          </div>
        ) : !hasData ? (
          <div className="text-center py-6">
            <Activity className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No FOTSI data yet</p>
            <p className="text-[10px] text-muted-foreground mt-1">Run a Bot #2 scan to compute currency strengths</p>
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <TabsList className="h-7 mb-3">
              <TabsTrigger value="meter" className="text-[10px] h-6 px-3">Strength Meter</TabsTrigger>
              <TabsTrigger value="pairs" className="text-[10px] h-6 px-3">Ranked Pairs</TabsTrigger>
            </TabsList>

            <TabsContent value="meter" className="mt-0">
              {/* Zone legend */}
              <div className="flex items-center gap-3 mb-3 text-[8px] text-muted-foreground">
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-500 rounded-sm" /> OB ≥{OB_THRESHOLD}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-500 rounded-sm" /> Bull &gt;{NEUTRAL_UPPER}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-muted-foreground/40 rounded-sm" /> Neutral</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-orange-500 rounded-sm" /> Bear &lt;{NEUTRAL_LOWER}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-500 rounded-sm" /> OS ≤{OS_THRESHOLD}</span>
              </div>

              {/* Currency bars */}
              <div className="space-y-1.5">
                {sorted.map((ccy, idx) => {
                  const val = strengths[ccy] ?? 0;
                  const zone = classifyZone(val);
                  const pct = Math.min(Math.abs(val), 100);
                  const isPositive = val >= 0;

                  return (
                    <div key={ccy} className="flex items-center gap-2">
                      {/* Rank */}
                      <span className="text-[9px] text-muted-foreground font-mono w-3 text-right">{idx + 1}</span>

                      {/* Flag + Currency */}
                      <span className="text-[10px] w-5 text-center">{FLAGS[ccy]}</span>
                      <span className="text-[11px] font-bold font-mono w-8">{ccy}</span>

                      {/* Bar */}
                      <div className="flex-1 h-4 bg-secondary/40 relative overflow-hidden">
                        {/* Center line */}
                        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border z-10" />

                        {/* Value bar */}
                        <div
                          className={`absolute top-0 bottom-0 ${barColor(val)} transition-all duration-500`}
                          style={{
                            left: isPositive ? "50%" : `${50 - pct / 2}%`,
                            width: `${pct / 2}%`,
                          }}
                        />

                        {/* OB/OS zone markers */}
                        <div className="absolute top-0 bottom-0 border-l border-dashed border-red-500/30" style={{ left: "75%" }} />
                        <div className="absolute top-0 bottom-0 border-l border-dashed border-emerald-500/30" style={{ left: "25%" }} />
                      </div>

                      {/* Value + Zone badge */}
                      <span className={`text-[11px] font-mono font-bold w-12 text-right ${zoneColor(zone)}`}>
                        {val > 0 ? "+" : ""}{val.toFixed(1)}
                      </span>
                      <Badge variant="outline" className={`text-[7px] px-1 py-0 h-3.5 border ${zoneBg(zone)} ${zoneColor(zone)} font-bold uppercase`}>
                        {zone === "overbought" ? "OB" : zone === "oversold" ? "OS" : zone === "bullish" ? "BULL" : zone === "bearish" ? "BEAR" : "—"}
                      </Badge>
                    </div>
                  );
                })}
              </div>

              {/* Divergence highlights */}
              {sorted.length >= 2 && (
                <div className="mt-3 pt-2 border-t border-border">
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1.5">Key Divergences</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <ArrowUpRight className="h-3 w-3 text-emerald-400" />
                      <span className="text-muted-foreground">Strongest:</span>
                      <span className="font-bold">{FLAGS[sorted[0]]} {sorted[0]}</span>
                      <span className={`font-mono font-bold ${zoneColor(classifyZone(strengths[sorted[0]] ?? 0))}`}>
                        {(strengths[sorted[0]] ?? 0).toFixed(1)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <ArrowDownRight className="h-3 w-3 text-red-400" />
                      <span className="text-muted-foreground">Weakest:</span>
                      <span className="font-bold">{FLAGS[sorted[sorted.length - 1]]} {sorted[sorted.length - 1]}</span>
                      <span className={`font-mono font-bold ${zoneColor(classifyZone(strengths[sorted[sorted.length - 1]] ?? 0))}`}>
                        {(strengths[sorted[sorted.length - 1]] ?? 0).toFixed(1)}
                      </span>
                    </div>
                  </div>
                  {/* Max spread */}
                  {(() => {
                    const maxSpread = (strengths[sorted[0]] ?? 0) - (strengths[sorted[sorted.length - 1]] ?? 0);
                    return (
                      <div className="flex items-center gap-1.5 text-[10px] mt-1.5">
                        <Zap className="h-3 w-3 text-primary" />
                        <span className="text-muted-foreground">Max Spread:</span>
                        <span className="font-mono font-bold text-primary">{maxSpread.toFixed(1)}</span>
                        <span className="text-muted-foreground">({sorted[0]}/{sorted[sorted.length - 1]})</span>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Bot #2 positions summary */}
              {botStatus && (
                <div className="mt-3 pt-2 border-t border-border">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground">Bot #2 Open Positions:</span>
                    <span className="font-bold font-mono">{botStatus.openPositions ?? 0}</span>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="pairs" className="mt-0">
              {rankedPairs.length === 0 ? (
                <div className="text-center py-6">
                  <p className="text-xs text-muted-foreground">No ranked pairs from latest scan</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Run a scan to see pair rankings</p>
                </div>
              ) : (
                <div className="space-y-0">
                  <div className="flex items-center text-[8px] text-muted-foreground uppercase tracking-wider border-b border-border pb-1 mb-1">
                    <span className="w-6">#</span>
                    <span className="flex-1">Pair</span>
                    <span className="w-12 text-right">Dir</span>
                    <span className="w-14 text-right">Base TSI</span>
                    <span className="w-14 text-right">Quote TSI</span>
                    <span className="w-14 text-right">Spread</span>
                    <span className="w-12 text-right">Hook</span>
                  </div>
                  {rankedPairs.map((p: any, i: number) => (
                    <div key={i} className="flex items-center text-[10px] py-1 border-b border-border/30 hover:bg-secondary/20 transition-colors">
                      <span className="w-6 text-muted-foreground font-mono">{i + 1}</span>
                      <span className="flex-1 font-bold">{p.pair}</span>
                      <span className={`w-12 text-right font-medium ${p.direction === "long" ? "text-success" : "text-destructive"}`}>
                        {p.direction === "long" ? "▲ BUY" : "▼ SELL"}
                      </span>
                      <span className={`w-14 text-right font-mono ${(p.baseTSI ?? 0) > 0 ? "text-success" : "text-destructive"}`}>
                        {(p.baseTSI ?? 0).toFixed(1)}
                      </span>
                      <span className={`w-14 text-right font-mono ${(p.quoteTSI ?? 0) > 0 ? "text-success" : "text-destructive"}`}>
                        {(p.quoteTSI ?? 0).toFixed(1)}
                      </span>
                      <span className="w-14 text-right font-mono font-bold text-primary">
                        {(p.spread ?? 0).toFixed(1)}
                      </span>
                      <span className="w-12 text-right">
                        {p.hook ? (
                          <Badge variant="outline" className="text-[7px] px-1 py-0 h-3.5 bg-primary/10 border-primary/30 text-primary">HOOK</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}
