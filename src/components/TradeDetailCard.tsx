import React from "react";
import { Badge } from "@/components/ui/badge";
import { getPipSize } from "@/lib/pipDisplay";
import { formatPrice } from "@/lib/formatTime";

interface TradeDetailProps {
  symbol: string;
  direction: string;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  mfePips: number | null;
  maePips: number | null;
  rrRatio: number | null;
  outcomeStatus: string;
  tpHit: boolean | null;
  slHit: boolean | null;
  tpHitTimeMinutes: number | null;
  priceReachedEntry: boolean | null;
  confluenceScore: number;
  tier1Count: number;
  failedGates: string[] | null;
  sessionName: string | null;
  regime: string | null;
}

// formatPrice is now imported from @/lib/formatTime (single source of truth)

export function TradeDetailCard({ 
  symbol, direction, entryPrice, stopLoss, takeProfit,
  mfePips, maePips, rrRatio, outcomeStatus, tpHit, slHit,
  tpHitTimeMinutes, priceReachedEntry, confluenceScore,
  tier1Count, failedGates, sessionName, regime,
}: TradeDetailProps) {
  const pipSize = getPipSize(symbol);
  const isLong = direction === "long";
  
  // Calculate actual price levels from pips
  const mfePrice = (mfePips !== null && mfePips !== 0) 
    ? (isLong ? entryPrice + (mfePips * pipSize) : entryPrice - (mfePips * pipSize))
    : null;
  const maePrice = (maePips !== null && maePips !== 0)
    ? (isLong ? entryPrice - (maePips * pipSize) : entryPrice + (maePips * pipSize))
    : null;

  // Build the price ladder (sorted high to low)
  interface LevelItem {
    label: string;
    price: number;
    color: string;
    icon: string;
    isCurrent?: boolean;
  }

  const levels: LevelItem[] = [];
  
  levels.push({ label: "Entry", price: entryPrice, color: "text-blue-400", icon: "●" });
  if (stopLoss !== null) levels.push({ label: "Stop Loss", price: stopLoss, color: "text-destructive", icon: "✕" });
  if (takeProfit !== null) levels.push({ label: "Take Profit", price: takeProfit, color: "text-emerald-400", icon: "◎" });
  if (mfePrice !== null) levels.push({ label: "MFE Reached", price: mfePrice, color: "text-green-300", icon: "▲" });
  if (maePrice !== null) levels.push({ label: "MAE Reached", price: maePrice, color: "text-orange-400", icon: "▼" });

  // Sort: highest price first
  levels.sort((a, b) => b.price - a.price);

  // Calculate distances for the visual bar
  const allPrices = levels.map(l => l.price);
  const maxPrice = Math.max(...allPrices);
  const minPrice = Math.min(...allPrices);
  const range = maxPrice - minPrice || 1;

  // Outcome label
  const outcomeLabel = outcomeStatus === "would_have_won" ? "Would Have Won" 
    : outcomeStatus === "would_have_lost" ? "Would Have Lost"
    : outcomeStatus === "pending" ? "Pending"
    : "Inconclusive";
  
  const outcomeColor = outcomeStatus === "would_have_won" ? "text-emerald-400"
    : outcomeStatus === "would_have_lost" ? "text-destructive"
    : "text-muted-foreground";

  return (
    <div className="bg-muted/30 border border-border/50 rounded-lg p-4 mt-1 mb-2 animate-in slide-in-from-top-2 duration-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className={isLong ? "border-emerald-500/50 text-emerald-400" : "border-destructive/50 text-destructive"}>
            {isLong ? "▲ LONG" : "▼ SHORT"} {symbol}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Score: {confluenceScore.toFixed(1)} | T1: {tier1Count} | RR: {rrRatio?.toFixed(1) || "—"}
          </span>
        </div>
        <div className={`text-sm font-semibold ${outcomeColor}`}>
          {outcomeLabel}
          {tpHitTimeMinutes !== null && tpHit && (
            <span className="text-xs text-muted-foreground ml-2">
              (TP hit in {tpHitTimeMinutes < 60 ? `${tpHitTimeMinutes}m` : `${Math.floor(tpHitTimeMinutes / 60)}h ${tpHitTimeMinutes % 60}m`})
            </span>
          )}
        </div>
      </div>

      {/* Price Ladder */}
      <div className="grid grid-cols-[1fr_auto] gap-4">
        {/* Visual ladder */}
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[60px] top-0 bottom-0 w-px bg-border/50" />
          
          {/* Risk zone (SL to Entry) */}
          {stopLoss !== null && (
            <div 
              className="absolute left-[56px] w-[9px] bg-destructive/15 rounded-sm"
              style={{
                top: `${((maxPrice - Math.max(entryPrice, stopLoss)) / range) * 100}%`,
                height: `${(Math.abs(entryPrice - stopLoss) / range) * 100}%`,
              }}
            />
          )}
          
          {/* Reward zone (Entry to TP) */}
          {takeProfit !== null && (
            <div 
              className="absolute left-[56px] w-[9px] bg-emerald-500/15 rounded-sm"
              style={{
                top: `${((maxPrice - Math.max(entryPrice, takeProfit)) / range) * 100}%`,
                height: `${(Math.abs(takeProfit - entryPrice) / range) * 100}%`,
              }}
            />
          )}

          {/* Level markers */}
          <div className="flex flex-col gap-0" style={{ minHeight: "120px" }}>
            {levels.map((level, i) => (
              <div 
                key={level.label}
                className="flex items-center gap-2 py-1.5"
                style={{ 
                  position: "relative",
                }}
              >
                <span className={`text-xs w-[48px] text-right ${level.color}`}>
                  {level.icon}
                </span>
                <div className={`w-3 h-3 rounded-full border-2 ${
                  level.label === "Entry" ? "border-blue-400 bg-blue-400/30" :
                  level.label === "Stop Loss" ? "border-red-400 bg-red-400/30" :
                  level.label === "Take Profit" ? "border-emerald-400 bg-emerald-400/30" :
                  level.label === "MFE Reached" ? "border-green-300 bg-green-300/30" :
                  "border-orange-400 bg-warning/30"
                }`} />
                <span className={`text-xs font-medium ${level.color}`}>
                  {level.label}
                </span>
                <span className="text-xs font-mono text-foreground/80 ml-auto">
                  {formatPrice(level.price, symbol)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats panel */}
        <div className="text-xs space-y-2 min-w-[180px] border-l border-border/30 pl-4">
          <div className="space-y-1.5">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Entry</span>
              <span className="font-mono">{formatPrice(entryPrice, symbol)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Stop Loss</span>
              <span className="font-mono text-destructive">{formatPrice(stopLoss, symbol)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Take Profit</span>
              <span className="font-mono text-emerald-400">{formatPrice(takeProfit, symbol)}</span>
            </div>
          </div>
          
          <div className="border-t border-border/30 pt-2 space-y-1.5">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Max Favorable</span>
              <span className="font-mono text-green-300">{mfePrice ? formatPrice(mfePrice, symbol) : "—"}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Max Adverse</span>
              <span className="font-mono text-orange-400">{maePrice ? formatPrice(maePrice, symbol) : "—"}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Entry Reached</span>
              <span className={priceReachedEntry ? "text-emerald-400" : "text-muted-foreground"}>
                {priceReachedEntry ? "Yes" : "No"}
              </span>
            </div>
          </div>

          <div className="border-t border-border/30 pt-2 space-y-1.5">
            {sessionName && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Session</span>
                <span>{sessionName}</span>
              </div>
            )}
            {regime && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Regime</span>
                <span className="capitalize">{regime}</span>
              </div>
            )}
            {failedGates && failedGates.length > 0 && (
              <div className="pt-1">
                <span className="text-muted-foreground block mb-1">Blocked by:</span>
                <div className="flex flex-wrap gap-1">
                  {failedGates.map((g, i) => (
                    <Badge key={i} variant="destructive" className="text-[9px] px-1.5 py-0">
                      {g}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
