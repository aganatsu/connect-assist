import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, RefreshCw, TrendingUp, TrendingDown, Zap, ChevronDown, ChevronUp } from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────
type Currency = "EUR" | "USD" | "GBP" | "CHF" | "JPY" | "AUD" | "CAD" | "NZD";

interface FOTSIStrengthMeterProps {
  strengths: Record<string, number> | null;
  lastScanTime?: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────
const CURRENCY_FLAGS: Record<Currency, string> = {
  AUD: "🇦🇺", EUR: "🇪🇺", CHF: "🇨🇭", GBP: "🇬🇧",
  NZD: "🇳🇿", CAD: "🇨🇦", USD: "🇺🇸", JPY: "🇯🇵",
};

const OB_THRESHOLD = 50;
const BULL_THRESHOLD = 25;
const BEAR_THRESHOLD = -25;
const OS_THRESHOLD = -50;

function getZone(value: number): { label: string; color: string; barColor: string; textColor: string } {
  if (value >= OB_THRESHOLD) return { label: "OB", color: "border-red-500 text-red-500", barColor: "bg-red-500", textColor: "text-red-500" };
  if (value > BULL_THRESHOLD) return { label: "BULL", color: "border-cyan-500 text-cyan-500", barColor: "bg-cyan-500", textColor: "text-cyan-500" };
  if (value > BEAR_THRESHOLD) return { label: "", color: "", barColor: "bg-zinc-400 dark:bg-zinc-500", textColor: "text-foreground" };
  if (value > OS_THRESHOLD) return { label: "BEAR", color: "border-orange-500 text-orange-500", barColor: "bg-orange-500", textColor: "text-orange-500" };
  return { label: "OS", color: "border-emerald-500 text-emerald-500", barColor: "bg-emerald-500", textColor: "text-emerald-500" };
}

// All 28 forex pairs for "Ranked Pairs" tab
const ALL_PAIRS: [string, Currency, Currency][] = [
  ["EUR/USD","EUR","USD"],["EUR/GBP","EUR","GBP"],["EUR/CHF","EUR","CHF"],["EUR/JPY","EUR","JPY"],
  ["EUR/AUD","EUR","AUD"],["EUR/CAD","EUR","CAD"],["EUR/NZD","EUR","NZD"],
  ["GBP/USD","GBP","USD"],["GBP/CHF","GBP","CHF"],["GBP/JPY","GBP","JPY"],
  ["GBP/AUD","GBP","AUD"],["GBP/CAD","GBP","CAD"],["GBP/NZD","GBP","NZD"],
  ["USD/CHF","USD","CHF"],["USD/JPY","USD","JPY"],["AUD/USD","AUD","USD"],
  ["USD/CAD","USD","CAD"],["NZD/USD","NZD","USD"],
  ["CHF/JPY","CHF","JPY"],["AUD/CHF","AUD","CHF"],["CAD/CHF","CAD","CHF"],["NZD/CHF","NZD","CHF"],
  ["AUD/JPY","AUD","JPY"],["CAD/JPY","CAD","JPY"],["NZD/JPY","NZD","JPY"],
  ["AUD/CAD","AUD","CAD"],["AUD/NZD","AUD","NZD"],["NZD/CAD","NZD","CAD"],
];

// ─── Component ──────────────────────────────────────────────────────
export function FOTSIStrengthMeter({ strengths, lastScanTime, onRefresh, isRefreshing }: FOTSIStrengthMeterProps) {
  const [tab, setTab] = useState<"meter" | "pairs">("meter");
  const [collapsed, setCollapsed] = useState(false);

  // Sort currencies by strength (descending)
  const ranked = useMemo(() => {
    if (!strengths) return [];
    return (Object.entries(strengths) as [Currency, number][])
      .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => b[1] - a[1]);
  }, [strengths]);

  // Compute ranked pairs (base strength - quote strength = pair bias)
  const rankedPairs = useMemo(() => {
    if (!strengths) return [];
    return ALL_PAIRS
      .map(([pair, base, quote]) => {
        const baseStr = strengths[base] ?? 0;
        const quoteStr = strengths[quote] ?? 0;
        const spread = baseStr - quoteStr;
        return { pair, base, quote, baseStr, quoteStr, spread };
      })
      .sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
  }, [strengths]);

  // Key divergence stats
  const strongest = ranked[0];
  const weakest = ranked[ranked.length - 1];
  const maxSpread = rankedPairs[0];

  // Format scan time
  const scanTimeStr = lastScanTime
    ? new Date(lastScanTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";

  if (!strengths) {
    return (
      <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
        <CardHeader className="py-3 px-4">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <BarChart3 className="w-4 h-4 text-cyan-500" />
            FOTSI Currency Strength
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <p className="text-xs text-muted-foreground text-center py-4">
            No currency strength data yet. Run a scan to populate.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Bar scale: max absolute value determines 100% width
  const maxAbs = Math.max(...ranked.map(([, v]) => Math.abs(v)), 1);

  return (
    <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
      {/* Header */}
      <CardHeader className="py-2.5 px-4 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="w-4 h-4 text-cyan-500" />
          Currency Strength
        </CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">
            Last scan: {scanTimeStr}
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              className="p-1 rounded hover:bg-accent transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`} />
            </button>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1 rounded hover:bg-accent transition-colors"
          >
            {collapsed ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="px-4 pb-3 pt-0">
          {/* Tabs */}
          <div className="flex gap-0 mb-3 border-b border-border">
            <button
              onClick={() => setTab("meter")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
                tab === "meter"
                  ? "border-cyan-500 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Strength Meter
            </button>
            <button
              onClick={() => setTab("pairs")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
                tab === "pairs"
                  ? "border-cyan-500 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Ranked Pairs
            </button>
          </div>

          {tab === "meter" && (
            <>
              {/* Legend */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3">
                <LegendItem color="bg-red-500" label="OB ≥50" />
                <LegendItem color="bg-cyan-500" label="Bull >25" />
                <LegendItem color="bg-zinc-400 dark:bg-zinc-500" label="Neutral" />
                <LegendItem color="bg-orange-500" label="Bear <-25" />
                <LegendItem color="bg-emerald-500" label="OS ≤-50" />
              </div>

              {/* Currency Bars */}
              <div className="space-y-1">
                {ranked.map(([currency, value], i) => {
                  const zone = getZone(value);
                  const barWidth = Math.min(Math.abs(value) / maxAbs * 100, 100);
                  const isPositive = value >= 0;

                  return (
                    <div key={currency} className="flex items-center gap-1.5 h-8">
                      {/* Rank */}
                      <span className="text-[10px] text-muted-foreground w-3 text-right font-mono">{i + 1}</span>
                      {/* Flag */}
                      <span className="text-sm w-5 text-center">{CURRENCY_FLAGS[currency] || "🏳️"}</span>
                      {/* Currency code */}
                      <span className="text-xs font-bold w-8">{currency}</span>
                      {/* Bar chart */}
                      <div className="flex-1 relative h-5 flex items-center">
                        {/* Background track */}
                        <div className="absolute inset-0 bg-zinc-100 dark:bg-zinc-800/60 rounded-sm" />
                        {/* Center line */}
                        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-300 dark:bg-zinc-600 z-10" />
                        {/* Dashed quarter lines */}
                        <div className="absolute left-1/4 top-0 bottom-0 w-px border-l border-dashed border-zinc-300/50 dark:border-zinc-600/50" />
                        <div className="absolute left-3/4 top-0 bottom-0 w-px border-l border-dashed border-zinc-300/50 dark:border-zinc-600/50" />
                        {/* Bar */}
                        <div
                          className={`absolute h-3.5 rounded-sm ${zone.barColor} transition-all duration-500 z-[5]`}
                          style={{
                            width: `${barWidth / 2}%`,
                            ...(isPositive
                              ? { left: "50%" }
                              : { right: "50%" }),
                          }}
                        />
                      </div>
                      {/* Value */}
                      <span className={`text-xs font-mono font-bold w-12 text-right ${zone.textColor}`}>
                        {value >= 0 ? "+" : ""}{value.toFixed(1)}
                      </span>
                      {/* Zone badge */}
                      <div className="w-12 flex justify-center">
                        {zone.label && (
                          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 font-bold ${zone.color}`}>
                            {zone.label}
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Key Divergences */}
              {strongest && weakest && (
                <div className="mt-3 pt-3 border-t border-border/50">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                    Key Divergences
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <div className="flex items-center gap-1.5">
                      <TrendingUp className="w-3 h-3 text-cyan-500" />
                      <span className="text-muted-foreground">Strongest:</span>
                      <span className="font-mono">{CURRENCY_FLAGS[strongest[0]]}</span>
                      <span className="font-bold">{strongest[0]}</span>
                      <span className="font-mono text-cyan-500">{strongest[1].toFixed(1)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <TrendingDown className="w-3 h-3 text-orange-500" />
                      <span className="text-muted-foreground">Weakest:</span>
                      <span className="font-mono">{CURRENCY_FLAGS[weakest[0]]}</span>
                      <span className="font-bold">{weakest[0]}</span>
                      <span className={`font-mono ${weakest[1] < 0 ? "text-orange-500" : "text-foreground"}`}>
                        {weakest[1].toFixed(1)}
                      </span>
                    </div>
                  </div>
                  {maxSpread && (
                    <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                      <Zap className="w-3 h-3 text-amber-500" />
                      <span className="text-muted-foreground">Max Spread:</span>
                      <span className="font-mono font-bold text-amber-500">{Math.abs(maxSpread.spread).toFixed(1)}</span>
                      <span className="text-muted-foreground">({maxSpread.pair})</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {tab === "pairs" && (
            <div className="space-y-0.5 max-h-[320px] overflow-y-auto">
              {rankedPairs.slice(0, 15).map(({ pair, base, quote, baseStr, quoteStr, spread }, i) => {
                const isBullish = spread > 0;
                const absSpread = Math.abs(spread);
                const zone = getZone(spread);

                return (
                  <div key={pair} className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-accent/50 transition-colors">
                    <span className="text-[10px] text-muted-foreground w-4 text-right font-mono">{i + 1}</span>
                    <div className="flex items-center gap-1 w-20">
                      <span className="text-[10px]">{CURRENCY_FLAGS[base]}</span>
                      <span className="text-xs font-bold">{pair}</span>
                    </div>
                    {/* Mini bar */}
                    <div className="flex-1 relative h-3 bg-zinc-100 dark:bg-zinc-800/60 rounded-sm overflow-hidden">
                      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-300 dark:bg-zinc-600" />
                      <div
                        className={`absolute h-full ${isBullish ? "bg-cyan-500/80" : "bg-orange-500/80"} transition-all duration-300`}
                        style={{
                          width: `${Math.min(absSpread / (maxAbs * 2) * 100, 50)}%`,
                          ...(isBullish ? { left: "50%" } : { right: "50%" }),
                        }}
                      />
                    </div>
                    <span className={`text-xs font-mono font-bold w-10 text-right ${isBullish ? "text-cyan-500" : "text-orange-500"}`}>
                      {isBullish ? "+" : ""}{spread.toFixed(1)}
                    </span>
                    <div className="w-10 flex justify-center">
                      {absSpread > 25 && (
                        <Badge variant="outline" className={`text-[8px] px-1 py-0 h-3.5 ${isBullish ? "border-cyan-500 text-cyan-500" : "border-orange-500 text-orange-500"}`}>
                          {isBullish ? "BUY" : "SELL"}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <div className={`w-2.5 h-2.5 rounded-sm ${color}`} />
      <span className="text-[9px] text-muted-foreground">{label}</span>
    </div>
  );
}
