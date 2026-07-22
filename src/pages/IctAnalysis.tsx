import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { AppShell } from "@/components/AppShell";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Clock, Target, BarChart3, Layers, Activity, TrendingUp, TrendingDown, Minus, Compass, Shield, Zap, ArrowUpDown } from "lucide-react";
import { scannerApi, marketApi } from "@/lib/api";
import { INSTRUMENTS, SESSIONS, KILL_ZONES } from "@/lib/marketData";
import { formatPrice } from "@/lib/formatTime";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartTheme } from "@/lib/chartTheme";
import { TierFactorBreakdown, TierScoreSummary } from "@/components/TierFactorBreakdown";
import { ZoneStoryPanel } from "@/components/ZoneStoryPanel";
import { generateDetailNarrative } from "@/lib/narrative";
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

const SYMBOLS = INSTRUMENTS.map(i => i.symbol);
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "NZD", "CHF"];

export default function IctAnalysis() {
  const [selectedSymbol, setSelectedSymbol] = useState("EUR/USD");
  const currentHour = new Date().getUTCHours();
  const { resolvedTheme } = useTheme();
  const isMobile = useIsMobile();
  const ct = getChartTheme(resolvedTheme);

  // Listen for global symbol change
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.symbol) setSelectedSymbol(detail.symbol);
    };
    window.addEventListener('smc-symbol-change', handler);
    return () => window.removeEventListener('smc-symbol-change', handler);
  }, []);

  // ── Data Source: Bot Scanner scan_logs (same as BotView) ──
  const { data: scanLogs, isLoading: scanLoading } = useQuery({
    queryKey: ["scan-logs"],
    queryFn: () => scannerApi.logs(),
    staleTime: 30000,
    refetchInterval: 60000,
  });

  // Parse latest scan
  const { meta, pairDetails, selectedDetail } = useMemo(() => {
    const logs = Array.isArray(scanLogs) ? scanLogs : [];
    const currentScan = logs[0];
    if (!currentScan) return { meta: null, pairDetails: [], selectedDetail: null };
    let dj = currentScan.details_json;
    if (typeof dj === "string") { try { dj = JSON.parse(dj); } catch { return { meta: null, pairDetails: [], selectedDetail: null }; } }
    const arr = Array.isArray(dj) ? dj : [];
    const m = arr.find((d: any) => d?.__meta) ?? null;
    const details = arr.filter((d: any) => !d?.__meta);
    const selected = details.find((d: any) => d?.pair === selectedSymbol) || null;
    return { meta: m, pairDetails: details, selectedDetail: selected };
  }, [scanLogs, selectedSymbol]);

  // Scanner timestamp
  const scanTime = useMemo(() => {
    const logs = Array.isArray(scanLogs) ? scanLogs : [];
    if (logs[0]?.scanned_at) {
      const d = new Date(logs[0].scanned_at);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return null;
  }, [scanLogs]);

  // Currency Strength from scanner __meta (already computed)
  const strengthData = useMemo(() => {
    if (meta?.fotsiStrengths && typeof meta.fotsiStrengths === "object") {
      return CURRENCIES
        .map(c => ({ currency: c, score: meta.fotsiStrengths[c] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    }
    // Fallback: compute from per-pair scanner data if no meta
    return [];
  }, [meta]);

  // Fallback currency strength from live quotes (if scanner meta doesn't have it)
  const strengthPairs = useMemo(() => [
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD", "USD/CHF",
    "EUR/GBP", "EUR/JPY", "EUR/AUD", "EUR/CAD", "EUR/NZD", "EUR/CHF",
    "GBP/JPY", "GBP/AUD", "GBP/CAD", "GBP/NZD", "GBP/CHF",
    "AUD/JPY", "AUD/CAD", "AUD/NZD", "AUD/CHF",
    "CAD/JPY", "CAD/CHF",
    "NZD/JPY", "NZD/CAD", "NZD/CHF",
    "CHF/JPY",
  ], []);
  const { data: liveQuotes } = useQuery({
    queryKey: ["ict-live-quotes"],
    queryFn: async () => {
      try { return await marketApi.batchQuotes(strengthPairs); } catch { return null; }
    },
    staleTime: 30000,
    refetchInterval: 60000,
    enabled: strengthData.length === 0, // only fetch if scanner doesn't provide it
  });
  const fallbackStrength = useMemo(() => {
    if (strengthData.length > 0) return strengthData;
    if (!liveQuotes) return [];
    const scores: Record<string, number> = {};
    const counts: Record<string, number> = {};
    CURRENCIES.forEach(c => { scores[c] = 0; counts[c] = 0; });
    for (const [pair, q] of Object.entries(liveQuotes)) {
      if (!q || (q as any).error) continue;
      const pct = (q as any)?.percentChange ?? (q as any)?.change;
      if (pct == null) continue;
      const base = pair.slice(0, 3).toUpperCase();
      const quote = pair.slice(4, 7).toUpperCase();
      if (scores[base] !== undefined) { scores[base] += pct; counts[base]++; }
      if (scores[quote] !== undefined) { scores[quote] -= pct; counts[quote]++; }
    }
    const result = CURRENCIES.map(c => ({
      currency: c,
      score: counts[c] > 0 ? Math.round((scores[c] / counts[c]) * 100) / 100 : 0,
    }));
    if (result.every(r => r.score === 0)) return [];
    return result.sort((a, b) => b.score - a.score);
  }, [strengthData, liveQuotes]);

  const d = selectedDetail; // shorthand

  return (
    <AppShell>
      <div className="flex flex-col md:flex-row h-[calc(100vh-3.5rem)] md:h-[calc(100vh-4.5rem)]">
        {/* Instrument sidebar — shows score + direction from scanner */}
        <div className="w-full md:w-40 shrink-0 md:border-r border-b md:border-b-0 border-border md:pr-2 pb-2 md:pb-0 flex md:flex-col gap-0.5 overflow-x-auto md:overflow-y-auto">
          <div className="flex items-center justify-between px-2 mb-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Instruments</p>
            {scanTime && <span className="text-[9px] text-muted-foreground font-mono">{scanTime}</span>}
          </div>
          {SYMBOLS.map(s => {
            const pd = pairDetails.find((p: any) => p?.pair === s);
            const score = pd?.score;
            const dir = pd?.direction;
            return (
              <button key={s} onClick={() => setSelectedSymbol(s)}
                className={`w-full text-left px-2 py-1.5 text-xs transition-colors flex items-center justify-between ${selectedSymbol === s ? "text-primary bg-primary/10 glow-border-left" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}`}>
                <div className="flex items-center gap-1">
                  {dir === "long" ? <TrendingUp className="h-2.5 w-2.5 text-success" /> : dir === "short" ? <TrendingDown className="h-2.5 w-2.5 text-destructive" /> : <Minus className="h-2.5 w-2.5 text-muted-foreground/50" />}
                  <span>{s}</span>
                </div>
                {score != null && (
                  <span className={`text-[9px] font-mono font-bold ${
                    score > 10 ? (score >= 60 ? "text-success" : score >= 40 ? "text-warning" : "text-muted-foreground/60") : (score >= 6 ? "text-success" : score >= 4 ? "text-warning" : "text-muted-foreground/60")
                  }`}>{score > 10 ? `${score.toFixed(0)}%` : `${score.toFixed(1)}`}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Analysis content */}
        <div className="flex-1 overflow-y-auto md:pl-3 pt-2 md:pt-0 space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold flex items-center gap-2">
                ICT Analysis — {selectedSymbol}
                {d?.direction && (
                  <span className={`text-sm font-bold uppercase px-2 py-0.5 border ${
                    d.direction === "long" ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"
                  }`}>{d.direction === "long" ? "BUY" : "SELL"}</span>
                )}
              </h1>
              {d && (
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  <span className="text-xs text-muted-foreground">
                    Score: <span className={`font-mono font-bold ${d.score >= 60 ? "text-success" : d.score >= 40 ? "text-warning" : "text-muted-foreground"}`}>
                      {d.score > 10 ? `${d.score.toFixed(1)}%` : `${d.score}/10`}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Trend: <span className={d.trend === "bullish" ? "text-success" : d.trend === "bearish" ? "text-destructive" : ""}>{d.trend}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Zone: <span className="text-primary">{d.zone} ({d.zonePercent?.toFixed(0)}%)</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Session: <span className="text-foreground">{d.session}</span>
                    {d.killZone && <span className="ml-1 text-primary">● KZ</span>}
                  </span>
                </div>
              )}
              {d?.summary && <p className="text-[10px] text-muted-foreground mt-0.5 max-w-2xl">{d.summary}</p>}
            </div>
          </div>

          {scanLoading && <p className="text-xs text-muted-foreground animate-pulse">Loading scanner data...</p>}
          {!scanLoading && !d && <p className="text-xs text-muted-foreground">No scanner data for {selectedSymbol}. Run a scan from the Bot tab.</p>}

          {d && (
            <Accordion type="multiple" defaultValue={["direction", "regime", "zone", "factors", "structure", "strength"]}>

              {/* ── Direction Verdict ── */}
              {d.directionVerdict && !d.directionVerdict.error && (
                <AccordionItem value="direction">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Compass className="h-3.5 w-3.5" /> Direction Verdict</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-sm font-bold px-2 py-1 rounded ${
                          d.directionVerdict.verdict === "long" ? "bg-success/15 text-success border border-success/30" :
                          d.directionVerdict.verdict === "short" ? "bg-destructive/15 text-destructive border border-destructive/30" :
                          "bg-muted/30 text-muted-foreground border border-border"
                        }`}>
                          {d.directionVerdict.verdict === "long" ? "↑ LONG" : d.directionVerdict.verdict === "short" ? "↓ SHORT" : "— NEUTRAL"}
                        </span>
                        <span className={`text-sm font-mono font-bold ${
                          d.directionVerdict.confidence >= 70 ? "text-success" :
                          d.directionVerdict.confidence >= 50 ? "text-warning" : "text-destructive"
                        }`}>{d.directionVerdict.confidence}% confidence</span>
                        <span className="text-xs text-muted-foreground">{Math.round(d.directionVerdict.agreement * 100)}% agreement</span>
                        {d.directionVerdict.shouldBlock && (
                          <span className="text-xs font-bold text-destructive bg-destructive/10 px-1.5 py-0.5 rounded border border-destructive/30">BLOCKED</span>
                        )}
                      </div>
                      {d.directionVerdict.scoreAdjustment !== 0 && (
                        <p className={`text-xs font-mono ${d.directionVerdict.scoreAdjustment > 0 ? "text-success" : "text-destructive"}`}>
                          Score adjustment: {d.directionVerdict.scoreAdjustment > 0 ? "+" : ""}{d.directionVerdict.scoreAdjustment.toFixed(2)}
                        </p>
                      )}
                      {/* Narrative */}
                      {d.direction && d.direction !== "none" && (
                        <p className="text-[11px] text-muted-foreground/80 italic leading-tight border-t border-border/30 pt-2">
                          {generateDetailNarrative({
                            pair: d.pair,
                            direction: d.direction,
                            score: d.score,
                            status: d.status,
                            factors: d.factors,
                            tieredScoring: d.tieredScoring,
                            regimeData: d.regimeData,
                            rejectionReasons: d.rejectionReasons,
                            gates: d.gates,
                            staging: d.staging,
                          })}
                        </p>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Regime Detection ── */}
              {d.regimeData && (
                <AccordionItem value="regime">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> Regime Detection</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-2">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {/* Daily */}
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Daily Regime</p>
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold ${
                              d.regimeData.daily?.regime?.includes("trend") ? "text-success" :
                              d.regimeData.daily?.regime?.includes("range") ? "text-warning" : "text-primary"
                            }`}>{(d.regimeData.daily?.regime || "—").replace(/_/g, " ")}</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {Math.round((d.regimeData.daily?.confidence || 0) * 100)}%
                            </span>
                            {d.regimeData.daily?.bias && d.regimeData.daily.bias !== "neutral" && (
                              <span className={`text-xs font-bold ${d.regimeData.daily.bias === "bullish" ? "text-success" : "text-destructive"}`}>
                                {d.regimeData.daily.bias === "bullish" ? "↑ Bullish" : "↓ Bearish"}
                              </span>
                            )}
                          </div>
                          {d.regimeData.daily?.atrTrend && (
                            <p className="text-[10px] text-muted-foreground">ATR: {d.regimeData.daily.atrTrend}</p>
                          )}
                          {d.regimeData.daily?.transition && d.regimeData.daily.transition.state !== "stable" && (
                            <div className="flex items-center gap-1 mt-1">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                d.regimeData.daily.transition.state === "range_to_trending" ? "bg-success/15 text-success" :
                                d.regimeData.daily.transition.state === "accelerating" ? "bg-primary/15 text-primary" :
                                d.regimeData.daily.transition.state === "trending_to_range" ? "bg-warning/15 text-warning" :
                                "bg-destructive/15 text-destructive"
                              }`}>
                                {d.regimeData.daily.transition.state.replace(/_/g, " ")}
                              </span>
                              <span className="text-[9px] text-muted-foreground font-mono">
                                mom: {d.regimeData.daily.transition.momentum > 0 ? "+" : ""}{d.regimeData.daily.transition.momentum.toFixed(3)}
                              </span>
                            </div>
                          )}
                        </div>
                        {/* 4H */}
                        {d.regimeData.h4 && (
                          <div className="space-y-1">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">4H Regime</p>
                            <div className="flex items-center gap-2">
                              <span className={`text-sm font-bold ${
                                d.regimeData.h4.regime?.includes("trend") ? "text-success" :
                                d.regimeData.h4.regime?.includes("range") ? "text-warning" : "text-primary"
                              }`}>{(d.regimeData.h4.regime || "—").replace(/_/g, " ")}</span>
                              <span className="text-xs text-muted-foreground font-mono">
                                {Math.round((d.regimeData.h4.confidence || 0) * 100)}%
                              </span>
                              {d.regimeData.h4.bias && d.regimeData.h4.bias !== "neutral" && (
                                <span className={`text-xs font-bold ${d.regimeData.h4.bias === "bullish" ? "text-success" : "text-destructive"}`}>
                                  {d.regimeData.h4.bias === "bullish" ? "↑" : "↓"}
                                </span>
                              )}
                            </div>
                            {d.regimeData.h4?.transition && d.regimeData.h4.transition.state !== "stable" && (
                              <div className="flex items-center gap-1 mt-1">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                  d.regimeData.h4.transition.state.includes("trend") || d.regimeData.h4.transition.state === "accelerating" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                                }`}>{d.regimeData.h4.transition.state.replace(/_/g, " ")}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      {/* Multi-TF Alignment */}
                      {d.regimeData.multiTFAlignment && (
                        <div className="flex items-center gap-2 pt-2 border-t border-border/30">
                          <span className="text-xs text-muted-foreground">Multi-TF:</span>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                            d.regimeData.multiTFAlignment === "agree" ? "bg-success/15 text-success border border-success/30" :
                            d.regimeData.multiTFAlignment === "disagree" ? "bg-destructive/15 text-destructive border border-destructive/30" :
                            "bg-warning/15 text-warning border border-warning/30"
                          }`}>
                            {d.regimeData.multiTFAlignment === "agree" ? "✓ ALIGNED" : d.regimeData.multiTFAlignment === "disagree" ? "✗ CONFLICTING" : "~ MIXED"}
                          </span>
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Zone Story ── */}
              {(d.unifiedZone || d.impulseZone) && (
                <AccordionItem value="zone">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Target className="h-3.5 w-3.5" /> Zone Story</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3">
                      <ZoneStoryPanel unifiedData={d.unifiedZone} gateData={d.impulseZone} isLiveContext symbol={d.pair} />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Tiered Scoring + Factor Breakdown ── */}
              {d.factors && (
                <AccordionItem value="factors">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Layers className="h-3.5 w-3.5" /> Confluence Factors ({d.factorCount}/{d.factors.length})</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-3">
                      {d.tieredScoring && <TierScoreSummary tieredScoring={d.tieredScoring} />}
                      <TierFactorBreakdown factors={d.factors} tieredScoring={d.tieredScoring ?? null} />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Structure Intelligence ── */}
              {d.structureIntel && (
                <AccordionItem value="structure">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Shield className="h-3.5 w-3.5" /> Structure Intelligence</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-2">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div className="p-2 bg-card/50 border border-border text-center">
                          <p className="text-[9px] text-muted-foreground">Internal BOS</p>
                          <p className="text-lg font-mono font-bold text-foreground">{d.structureIntel.counts?.internalBOS ?? 0}</p>
                        </div>
                        <div className="p-2 bg-card/50 border border-border text-center">
                          <p className="text-[9px] text-muted-foreground">External BOS</p>
                          <p className="text-lg font-mono font-bold text-foreground">{d.structureIntel.counts?.externalBOS ?? 0}</p>
                        </div>
                        <div className="p-2 bg-card/50 border border-border text-center">
                          <p className="text-[9px] text-muted-foreground">Internal CHoCH</p>
                          <p className="text-lg font-mono font-bold text-primary">{d.structureIntel.counts?.internalCHoCH ?? 0}</p>
                        </div>
                        <div className="p-2 bg-card/50 border border-border text-center">
                          <p className="text-[9px] text-muted-foreground">External CHoCH</p>
                          <p className="text-lg font-mono font-bold text-primary">{d.structureIntel.counts?.externalCHoCH ?? 0}</p>
                        </div>
                      </div>
                      {/* S2F Rate */}
                      {d.structureIntel.s2f && (
                        <div className="flex items-center gap-3 pt-2 border-t border-border/30">
                          <span className="text-xs text-muted-foreground">Structure-to-Fractal Rate:</span>
                          <span className={`text-sm font-bold px-2 py-0.5 rounded ${
                            d.structureIntel.s2f.overallRate > 0.4 ? "bg-success/15 text-success" :
                            d.structureIntel.s2f.overallRate > 0.2 ? "bg-warning/15 text-warning" : "bg-destructive/15 text-destructive"
                          }`}>{(d.structureIntel.s2f.overallRate * 100).toFixed(0)}%</span>
                          <span className="text-[10px] text-muted-foreground">
                            ({d.structureIntel.s2f.totalFractals} fractals · Bull {(d.structureIntel.s2f.bullishRate * 100).toFixed(0)}% / Bear {(d.structureIntel.s2f.bearishRate * 100).toFixed(0)}%)
                          </span>
                        </div>
                      )}
                      {/* Derived S/R */}
                      {d.structureIntel.derivedSR?.active?.length > 0 && (
                        <div className="pt-2 border-t border-border/30">
                          <p className="text-[10px] text-muted-foreground mb-1">Active S/R Levels</p>
                          <div className="flex flex-wrap gap-1">
                            {d.structureIntel.derivedSR.active.map((sr: any, i: number) => (
                              <span key={i} className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                                sr.type === "support" ? "bg-success/15 text-success border border-success/30" : "bg-destructive/15 text-destructive border border-destructive/30"
                              }`}>{sr.type === "support" ? "S" : "R"} {sr.price?.toFixed(sr.price > 10 ? 3 : 5)}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Currency Strength ── */}
              <AccordionItem value="strength">
                <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><BarChart3 className="h-3.5 w-3.5" /> Currency Strength</span></AccordionTrigger>
                <AccordionContent>
                  <div className="bg-secondary/30 border border-border p-3">
                    {fallbackStrength.length > 0 ? (
                      <div>
                        <div className="h-[220px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={fallbackStrength} layout="vertical" barSize={16}>
                              <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} strokeOpacity={0.4} />
                              <XAxis type="number" tick={{ fontSize: 10, fontFamily: "'IBM Plex Mono'", fill: ct.axis }} stroke={ct.grid} axisLine={false} tickLine={false} />
                              <YAxis dataKey="currency" type="category" tick={{ fontSize: 11, fontFamily: "'IBM Plex Mono'", fontWeight: 600, fill: ct.axis }} stroke={ct.grid} axisLine={false} tickLine={false} width={40} />
                              <Tooltip
                                contentStyle={{ backgroundColor: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: "6px", fontSize: "12px", color: ct.axis }}
                                labelStyle={{ color: ct.axis, fontWeight: 600 }}
                                formatter={(value: number) => [`${value.toFixed(2)}%`, "Strength"]}
                              />
                              <Bar dataKey="score" radius={[0, 3, 3, 0]}>{fallbackStrength.map((entry, i) => <Cell key={i} fill={entry.score >= 0 ? 'hsl(155, 70%, 45%)' : 'hsl(0, 72%, 51%)'} />)}</Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1 text-center">
                          {meta?.fotsiStrengths ? "From scanner FOTSI computation" : "Based on % change across 28 pairs"} · <span className="text-success">Green = strong</span> · <span className="text-destructive">Red = weak</span>
                        </p>
                      </div>
                    ) : <p className="text-xs text-muted-foreground animate-pulse">Fetching strength data...</p>}
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* ── Entity Lifecycles ── */}
              {d.analysis_snapshot?.entityLifecycles && (
                <AccordionItem value="entities">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><ArrowUpDown className="h-3.5 w-3.5" /> Entity Lifecycles</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {/* Order Blocks */}
                        <EntityCard title="Order Blocks" data={d.analysis_snapshot.entityLifecycles.orderBlocks} states={["active", "tested", "mitigating", "broken"]} />
                        {/* FVGs */}
                        <EntityCard title="Fair Value Gaps" data={d.analysis_snapshot.entityLifecycles.fvgs} states={["open", "respected", "partially_filled", "filled"]}
                          extra={d.analysis_snapshot.entityLifecycles.fvgs.avgFillPercent > 0 ? `Avg fill: ${d.analysis_snapshot.entityLifecycles.fvgs.avgFillPercent.toFixed(0)}%` : undefined} />
                        {/* Swing Points */}
                        <EntityCard title="Swing Points" data={d.analysis_snapshot.entityLifecycles.swingPoints} states={["active", "tested", "swept", "broken"]} />
                        {/* Liquidity Pools */}
                        <EntityCard title="Liquidity Pools" data={d.analysis_snapshot.entityLifecycles.liquidityPools} states={["active", "swept_rejected", "swept_absorbed", "retested"]} />
                        {/* Breaker Blocks */}
                        <EntityCard title="Breaker Blocks" data={d.analysis_snapshot.entityLifecycles.breakerBlocks} states={["active", "tested", "respected", "broken"]} />
                        {/* Unicorn Setups */}
                        <EntityCard title="Unicorn Setups" data={d.analysis_snapshot.entityLifecycles.unicornSetups} states={["active", "invalidated"]} />
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Confluence Stacking ── */}
              {d.confluenceStacking && (
                <AccordionItem value="stacking">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Layers className="h-3.5 w-3.5" /> Confluence Stacking ({d.confluenceStacking.totalStacks} zones)</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-2">
                      {d.confluenceStacking.bestStack && (
                        <div className="flex items-center gap-2 pb-2 border-b border-border/30">
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Best Stack:</span>
                          <span className="text-xs font-bold text-primary">{d.confluenceStacking.bestStack.label}</span>
                          <span className="text-[10px] text-muted-foreground">{d.confluenceStacking.bestStack.layerCount} layers</span>
                          {d.confluenceStacking.bestStack.alignment && (
                            <span className={`text-[10px] font-bold ${d.confluenceStacking.bestStack.alignment === "aligned" ? "text-success" : "text-warning"}`}>
                              {d.confluenceStacking.bestStack.alignment}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="space-y-1.5">
                        {d.confluenceStacking.stacks.map((s: any, i: number) => (
                          <div key={i} className="flex items-center justify-between px-2 py-1.5 bg-card/50 border border-border">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono font-bold text-primary">{s.layerCount}L</span>
                              <span className="text-[11px] text-foreground">{s.label}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {s.overlapZone && (
                                <span className="text-[9px] font-mono text-muted-foreground">
                                  {formatPrice(s.overlapZone[0])} – {formatPrice(s.overlapZone[1])}
                                </span>
                              )}
                              {s.directionalAlignment && (
                                <span className={`text-[9px] font-bold ${s.directionalAlignment === "aligned" ? "text-success" : "text-warning"}`}>
                                  {s.directionalAlignment}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Sweep & Reclaim ── */}
              {d.sweepReclaim && (
                <AccordionItem value="sweep">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Zap className="h-3.5 w-3.5" /> Sweep & Reclaim ({d.sweepReclaim.reclaimedCount}/{d.sweepReclaim.totalSweeps})</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-1.5">
                      {d.sweepReclaim.sweeps.map((sr: any, i: number) => (
                        <div key={i} className={`flex items-center justify-between px-2 py-1.5 border-l-2 ${sr.reclaimed ? "border-l-success bg-success/5" : "border-l-destructive bg-destructive/5"}`}>
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold ${sr.reclaimed ? "text-success" : "text-destructive"}`}>
                              {sr.reclaimed ? "✓ RECLAIMED" : "✗ SWEPT"}
                            </span>
                            <span className="text-[11px] text-foreground">{sr.type}</span>
                            <span className="text-[10px] font-mono text-muted-foreground">{formatPrice(sr.sweptLevel)}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {sr.reclaimStrength && <span className="text-[9px] text-muted-foreground">str: {sr.reclaimStrength}</span>}
                            {sr.createdFVG && <span className="text-[9px] text-primary">+FVG</span>}
                            {sr.createdDisplacement && <span className="text-[9px] text-primary">+DISP</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Pullback Health ── */}
              {d.pullbackHealth && (
                <AccordionItem value="pullback">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> Pullback Health</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">Trend:</span>
                        <span className={`text-sm font-bold ${
                          d.pullbackHealth.trend === "healthy" ? "text-success" :
                          d.pullbackHealth.trend === "weakening" ? "text-warning" : "text-destructive"
                        }`}>{d.pullbackHealth.trend}</span>
                        <span className="text-xs text-muted-foreground">Decay Rate:</span>
                        <span className={`text-sm font-mono font-bold ${
                          d.pullbackHealth.decayRate < 0.3 ? "text-success" :
                          d.pullbackHealth.decayRate < 0.6 ? "text-warning" : "text-destructive"
                        }`}>{(d.pullbackHealth.decayRate * 100).toFixed(0)}%</span>
                      </div>
                      {d.pullbackHealth.detail && (
                        <p className="text-[10px] text-muted-foreground">{d.pullbackHealth.detail}</p>
                      )}
                      {d.pullbackHealth.measurements?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/30">
                          {d.pullbackHealth.measurements.map((m: any, i: number) => (
                            <span key={i} className="text-[9px] font-mono px-1.5 py-0.5 bg-card/50 border border-border rounded">
                              {m.depthPercent.toFixed(1)}% → Fib {m.nearestFibLevel}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Setup Classification ── */}
              {d.setupClassification && (
                <AccordionItem value="setup">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Target className="h-3.5 w-3.5" /> Setup Classification</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-primary">{d.setupClassification.setupType}</span>
                        <span className={`text-xs font-mono font-bold px-1.5 py-0.5 rounded ${
                          d.setupClassification.confidence >= 0.7 ? "bg-success/15 text-success" :
                          d.setupClassification.confidence >= 0.4 ? "bg-warning/15 text-warning" : "bg-muted/30 text-muted-foreground"
                        }`}>{(d.setupClassification.confidence * 100).toFixed(0)}% conf</span>
                        {d.setupClassification.executionProfile && (
                          <span className="text-[10px] text-muted-foreground border border-border px-1.5 py-0.5 rounded">{d.setupClassification.executionProfile}</span>
                        )}
                      </div>
                      {d.setupClassification.rationale && (
                        <p className="text-[10px] text-muted-foreground">{d.setupClassification.rationale}</p>
                      )}
                      {/* Style info */}
                      <div className="flex items-center gap-3 pt-2 border-t border-border/30">
                        <span className="text-[10px] text-muted-foreground">Style: <span className="text-foreground font-medium">{d.tradingStyle}</span></span>
                        {d.suggestedStyle && d.suggestedStyle !== d.tradingStyle && (
                          <span className="text-[10px] text-warning">Suggested: {d.suggestedStyle}</span>
                        )}
                        {d.styleMismatch && (
                          <span className="text-[9px] text-warning italic">{d.styleMismatch}</span>
                        )}
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Session Map (static) ── */}
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

              {/* ── Fib Levels ── */}
              {d.fibLevels && (
                <AccordionItem value="fib">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Target className="h-3.5 w-3.5" /> Fibonacci Levels</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-2">
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-muted-foreground">Swing High: <span className="font-mono text-foreground">{formatPrice(d.fibLevels.swingHigh)}</span></span>
                        <span className="text-muted-foreground">Swing Low: <span className="font-mono text-foreground">{formatPrice(d.fibLevels.swingLow)}</span></span>
                        <span className="text-muted-foreground">Direction: <span className={d.fibLevels.direction === "bullish" ? "text-success" : "text-destructive"}>{d.fibLevels.direction}</span></span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {d.fibLevels.retracements && (
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Retracements</p>
                            <div className="space-y-0.5">
                              {Object.entries(d.fibLevels.retracements).map(([level, price]) => (
                                <div key={level} className="flex justify-between text-[10px]">
                                  <span className="text-muted-foreground">{level}</span>
                                  <span className="font-mono text-foreground">{formatPrice(price as number)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {d.fibLevels.extensions && (
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Extensions</p>
                            <div className="space-y-0.5">
                              {Object.entries(d.fibLevels.extensions).map(([level, price]) => (
                                <div key={level} className="flex justify-between text-[10px]">
                                  <span className="text-muted-foreground">{level}</span>
                                  <span className="font-mono text-foreground">{formatPrice(price as number)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

              {/* ── Gates ── */}
              {d.gates && (
                <AccordionItem value="gates">
                  <AccordionTrigger className="text-xs"><span className="flex items-center gap-2"><Shield className="h-3.5 w-3.5" /> Gates ({d.gates.filter((g: any) => g.passed).length}/{d.gates.length} passed)</span></AccordionTrigger>
                  <AccordionContent>
                    <div className="bg-secondary/30 border border-border p-3 space-y-0.5">
                      {d.gates.map((g: any, i: number) => (
                        <div key={i} className={`flex items-center gap-2 px-2 py-1 text-[11px] ${g.passed ? "text-muted-foreground" : "text-destructive"}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${g.passed ? "bg-success" : "bg-destructive"}`} />
                          <span className={g.passed ? "" : "font-medium"}>{g.reason || g.name || `Gate ${i + 1}`}</span>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              )}

            </Accordion>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── Entity Lifecycle Card ──
function EntityCard({ title, data, states, extra }: { title: string; data: any; states: string[]; extra?: string }) {
  if (!data) return null;
  return (
    <div className="p-2 bg-card/50 border border-border space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{title}</p>
        <span className="text-sm font-mono font-bold text-foreground">{data.total}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {states.map(s => {
          const count = data.byState?.[s] ?? 0;
          if (count === 0) return null;
          const color = s === "active" || s === "open" ? "text-success" :
            s === "tested" || s === "respected" || s === "partially_filled" ? "text-warning" :
            s === "swept" || s === "broken" || s === "filled" || s === "invalidated" || s === "swept_absorbed" ? "text-destructive" :
            s === "swept_rejected" || s === "retested" ? "text-primary" : "text-muted-foreground";
          return (
            <span key={s} className={`text-[9px] font-mono px-1 py-0.5 bg-muted/20 rounded ${color}`}>
              {s.replace(/_/g, " ")}: {count}
            </span>
          );
        })}
      </div>
      {extra && <p className="text-[9px] text-muted-foreground">{extra}</p>}
    </div>
  );
}
