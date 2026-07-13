import { useState } from "react";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { OverrideBadge } from "@/components/TradeOverrideEditor";
import { SignalReasoningCard } from "@/components/SignalReasoningCard";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChevronRight, Info } from "lucide-react";

interface MobilePositionCardProps {
  position: any;
  isExpanded: boolean;
  onToggle: () => void;
  onClose: (id: string) => void;
}

export function MobilePositionCard({ position: p, isExpanded, onToggle, onClose }: MobilePositionCardProps) {
  const [detailSheet, setDetailSheet] = useState(false);

  const inst = INSTRUMENTS.find((i: any) => i.symbol === p.symbol);
  const pipSize = inst?.pipSize || 0.0001;
  const entry = parseFloat(p.entryPrice);
  const current = parseFloat(p.currentPrice);
  const sl = p.stopLoss ? parseFloat(p.stopLoss) : null;

  // Parse exit flags
  let sr: any = {};
  try { sr = JSON.parse(p.signalReason || "{}"); } catch {}
  const ef: any = sr.exitFlags || {};
  const origSl = sr.originalSL != null ? parseFloat(sr.originalSL) : sl;

  // Calculations
  const riskPips = origSl !== null ? Math.abs(entry - origSl) / pipSize : 0;
  const profitPips = p.direction === "long" ? (current - entry) / pipSize : (entry - current) / pipSize;
  const rMult = riskPips > 0 ? profitPips / riskPips : 0;

  // Management status
  const beEnabled = ef.breakEvenEnabled ?? ef.breakEven ?? false;
  const beFired = ef.breakEvenActivated === true;
  const trailEnabled = ef.trailingStopEnabled ?? ef.trailingStop ?? false;
  const trailFired = ef.trailingStopActivated === true;
  const holdEnabled = ef.maxHoldEnabled !== false && ef.maxHoldHours && ef.maxHoldHours > 0;
  const openMs = new Date(p.openTime).getTime();
  const holdHours = (Date.now() - openMs) / 3600000;

  // Entry confirmation data for detail sheet
  const conf = sr.confirmation || {};
  const lo = sr.limitOrderOrigin || {};
  const iz = sr.impulseZoneEntry || sr.impulseZone?.bestZone || {};

  const confirmTypeLabels: Record<string, string> = {
    engulfing: "Engulfing", rejection_wick: "Rejection Wick",
    fvg: "FVG Created", sweep_reclaim: "Sweep + Reclaim",
    displacement: "Displacement", volume_spike: "Volume Spike",
  };

  const zoneType = lo.zoneType || iz.zoneType || iz.type || null;
  const zoneLow = lo.zoneLow || iz.zoneLow || iz.low;
  const zoneHigh = lo.zoneHigh || iz.zoneHigh || iz.high;

  return (
    <>
    <div className="border-b border-border/40 last:border-0 max-w-full overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full min-w-0 px-3 py-2.5 flex items-center gap-2 active:bg-secondary/30 transition-colors"
      >
        {/* Direction indicator */}
        <div className={`w-1 h-8 rounded-full shrink-0 ${p.direction === "long" ? "bg-success" : "bg-destructive"}`} />

        {/* Main info */}
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-mono font-medium truncate">{p.symbol}</span>
            <span className={`text-[9px] font-medium ${p.direction === "long" ? "text-success" : "text-destructive"}`}>
              {p.direction === "long" ? "LONG" : "SHORT"}
            </span>
            {p.mirrorStatus === "mirrored" && (
              <span title="Mirrored to broker" className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
            )}
            {p.mirrorStatus === "orphan" && (
              <span title="Live mode but NOT mirrored to MT4/MT5 (broker was down at open) — management will not fan out" className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
            )}
            <OverrideBadge position={p} />
            {sr.signalSource && (
              <span className={`text-[8px] font-mono font-bold px-1 py-0 rounded shrink-0 ${
                sr.signalSource === "unified" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" :
                sr.signalSource === "cascade" ? "bg-purple-500/15 text-purple-400 border border-purple-500/30" :
                "bg-orange-500/15 text-orange-400 border border-orange-500/30"
              }`}>
                {sr.signalSource === "unified" ? "UNI" : sr.signalSource === "cascade" ? "CAS" : "STD½"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0 overflow-hidden">
            {/* Management badges — compact, no emojis */}
            {beEnabled && (
              <span className={`text-[8px] font-medium px-1 py-0 border ${beFired ? "border-success/40 text-success" : "border-border text-muted-foreground"}`}>
                BE{beFired ? "✓" : ""}
              </span>
            )}
            {trailEnabled && (
              <span className={`text-[8px] font-medium px-1 py-0 border ${trailFired ? "border-cyan-500/40 text-cyan-400" : "border-border text-muted-foreground"}`}>
                TRAIL{trailFired ? "✓" : ""}
              </span>
            )}
            {holdEnabled && (
              <span className="text-[8px] text-muted-foreground font-mono truncate">
                {holdHours.toFixed(1)}h/{ef.maxHoldHours}h
              </span>
            )}
          </div>
        </div>

        {/* P&L and R */}
        <div className="text-right shrink-0">
          <div className={`text-xs font-mono font-bold ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>
            {formatMoney(p.pnl, true)}
          </div>
          <div className={`text-[10px] font-mono ${rMult >= 0 ? "text-success/70" : "text-destructive/70"}`}>
            {rMult >= 0 ? "+" : ""}{rMult.toFixed(2)}R
          </div>
        </div>

        <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-0 space-y-2">
          {/* Signal source context note */}
          {sr.signalSource === "standalone" && (
            <div className="text-[9px] text-orange-400/80 bg-orange-500/10 border border-orange-500/20 rounded px-2 py-1">
              Entry via standalone impulse zone — unified confirmation not met. Size halved (×0.5).
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono pl-4 border-l-2 border-border">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Entry</span>
              <span>{entry.toFixed(5)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current</span>
              <span>{current.toFixed(5)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground" title="Current stop loss — may have moved due to break-even or trailing">Current SL</span>
              <span className="text-destructive">{sl !== null ? sl.toFixed(5) : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">TP</span>
              <span className="text-success">{p.takeProfit ? parseFloat(p.takeProfit).toFixed(5) : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pips</span>
              <span className={profitPips >= 0 ? "text-success" : "text-destructive"}>{profitPips >= 0 ? "+" : ""}{profitPips.toFixed(1)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Size</span>
              <span>{parseFloat(p.size || 0).toFixed(2)}</span>
            </div>
            {p.signalScore != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Score</span>
                <span className="text-primary font-bold">{Number(p.signalScore) > 10 ? `${Number(p.signalScore).toFixed(1)}%` : `${p.signalScore}/10`}</span>
              </div>
            )}
            {trailFired && sl !== null && origSl !== null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Locked R</span>
                <span className="text-cyan-400 font-bold">
                  {(() => {
                    const risk = p.direction === "long" ? entry - origSl : origSl - entry;
                    if (risk <= 0) return "—";
                    const locked = p.direction === "long" ? sl - entry : entry - sl;
                    return `${(locked / risk).toFixed(2)}R`;
                  })()}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hold</span>
              <span>{holdHours.toFixed(1)}h</span>
            </div>
          </div>
          <div className="pl-4 flex gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onClose(p.id); }}
              className="text-[10px] font-medium text-destructive border border-destructive/30 px-2 py-1 hover:bg-destructive/10 transition-colors"
            >
              Close Position
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setDetailSheet(true); }}
              className="text-[10px] font-medium text-primary border border-primary/30 px-2 py-1 hover:bg-primary/10 transition-colors flex items-center gap-1"
            >
              <Info className="h-3 w-3" />
              View Full Details
            </button>
          </div>
        </div>
      )}
    </div>

    {/* Full Detail Bottom Sheet */}
    <Sheet open={detailSheet} onOpenChange={setDetailSheet}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-2xl">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-sm flex items-center gap-2">
            <span className={`w-2 h-5 rounded-full ${p.direction === "long" ? "bg-success" : "bg-destructive"}`} />
            <span className="font-mono">{p.symbol}</span>
            <span className={`text-[10px] font-medium ${p.direction === "long" ? "text-success" : "text-destructive"}`}>
              {p.direction === "long" ? "LONG" : "SHORT"}
            </span>
            {sr.signalSource && (
              <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${
                sr.signalSource === "unified" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" :
                sr.signalSource === "cascade" ? "bg-purple-500/15 text-purple-400 border border-purple-500/30" :
                "bg-orange-500/15 text-orange-400 border border-orange-500/30"
              }`}>
                {sr.signalSource === "unified" ? "UNIFIED ×1" : sr.signalSource === "cascade" ? "CASCADE ×1" : "STANDALONE ×0.5"}
              </span>
            )}
            <span className="ml-auto text-xs font-mono text-muted-foreground">
              {p.signalScore != null ? (Number(p.signalScore) > 10 ? `${Number(p.signalScore).toFixed(1)}%` : `${p.signalScore}/10`) : ""}
            </span>
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 pb-6">
          {/* Entry Confirmation Story */}
          {(sr.confirmationEntry || sr.entryMethod === "market_fill_at_zone" || sr.filledFromLimitOrder) && (
            <div className="rounded-lg border border-border/40 bg-secondary/30 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-muted-foreground">Entry Confirmation</span>
                {sr.confirmationEntry && conf.tier && (
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                    conf.tier === 1 ? "bg-success/15 border-success/40 text-success" :
                    conf.tier === 2 ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-400" :
                    "bg-purple-500/15 border-purple-500/40 text-purple-400"
                  }`}>
                    T{conf.tier}
                  </span>
                )}
                {sr.entryMethod === "market_fill_at_zone" && !sr.confirmationEntry && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/15 border border-amber-500/40 text-amber-400">
                    Market Fill at Zone
                  </span>
                )}
                {sr.filledFromLimitOrder && !sr.confirmationEntry && sr.entryMethod !== "market_fill_at_zone" && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-500/15 border border-blue-500/40 text-blue-400">
                    Limit Order Fill
                  </span>
                )}
              </div>

              {/* Confirmation signal details */}
              {sr.confirmationEntry && conf.type && (
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] font-mono">
                  <span className="text-muted-foreground">Signal: <span className="text-foreground font-semibold">{confirmTypeLabels[conf.type] || conf.type || "\u2014"}</span></span>
                  {conf.displacement != null && (
                    <span className="text-muted-foreground">Disp: <span className={`font-semibold ${conf.displacement >= 1.5 ? "text-success" : conf.displacement >= 1.0 ? "text-foreground" : "text-warn"}`}>{conf.displacement.toFixed(2)}\u00d7</span></span>
                  )}
                  {conf.significance && (
                    <span className="text-muted-foreground">Strength: <span className={`font-semibold ${conf.significance === "high" ? "text-success" : conf.significance === "medium" ? "text-foreground" : "text-muted-foreground"}`}>{conf.significance}</span></span>
                  )}
                </div>
              )}

              {/* Supporting signals */}
              {sr.confirmationEntry && Array.isArray(conf.supportingSignals) && conf.supportingSignals.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {conf.supportingSignals.map((sig: string, i: number) => (
                    <span key={i} className="rounded-full bg-secondary/60 border border-border px-2 py-0.5 text-[9px] text-foreground/70">
                      {sig.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              )}

              {/* Zone info */}
              {(zoneType || zoneLow != null) && (
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] font-mono">
                  {zoneType && (
                    <span className="text-muted-foreground">Zone: <span className="text-foreground font-semibold">{zoneType}</span></span>
                  )}
                  {zoneLow != null && zoneHigh != null && (
                    <span className="text-muted-foreground">[{Number(zoneLow).toFixed(5)} \u2013 {Number(zoneHigh).toFixed(5)}]</span>
                  )}
                </div>
              )}

              {/* Watchlist origin */}
              {sr.promotedFromWatchlist && sr.watchlistOrigin && (
                <div className="flex items-center gap-2 text-[10px] text-cyan-400/80">
                  <span>Watched {sr.watchlistOrigin.cyclesWatched} cycles</span>
                  {sr.watchlistOrigin.initialScore != null && (
                    <span>\u00b7 Started at {sr.watchlistOrigin.initialScore.toFixed(1)}%</span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Signal Reasoning Card — full factor breakdown, tier scores, zone qualifiers, exit strategy */}
          {p.signalReason && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-bold mb-1.5">Signal Breakdown</p>
              <SignalReasoningCard signalReason={p.signalReason} />
            </div>
          )}

          {/* Trade Metrics Summary */}
          <div>
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-bold mb-1.5">Trade Metrics</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] font-mono border border-border/40 rounded-lg px-3 py-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Entry</span>
                <span>{entry.toFixed(5)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Current</span>
                <span>{current.toFixed(5)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stop Loss</span>
                <span className="text-destructive">{sl !== null ? sl.toFixed(5) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Take Profit</span>
                <span className="text-success">{p.takeProfit ? parseFloat(p.takeProfit).toFixed(5) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">P&L (pips)</span>
                <span className={profitPips >= 0 ? "text-success" : "text-destructive"}>{profitPips >= 0 ? "+" : ""}{profitPips.toFixed(1)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">R Multiple</span>
                <span className={rMult >= 0 ? "text-success" : "text-destructive"}>{rMult >= 0 ? "+" : ""}{rMult.toFixed(2)}R</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Size</span>
                <span>{parseFloat(p.size || 0).toFixed(2)} lots</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hold Time</span>
                <span>{holdHours.toFixed(1)}h</span>
              </div>
              {origSl !== null && origSl !== sl && (
                <div className="flex justify-between col-span-2">
                  <span className="text-muted-foreground">Original SL</span>
                  <span className="text-muted-foreground/70">{origSl.toFixed(5)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Management Status */}
          {(beEnabled || trailEnabled || holdEnabled) && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-bold mb-1.5">Trade Management</p>
              <div className="space-y-1 text-[11px]">
                {beEnabled && (
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${beFired ? "bg-success" : "bg-muted-foreground"}`} />
                    <span className="text-muted-foreground">Break Even</span>
                    <span className={beFired ? "text-success font-medium" : "text-muted-foreground"}>
                      {beFired ? "Activated" : `Pending (${ef.breakEvenPips || "—"} pips)`}
                    </span>
                  </div>
                )}
                {trailEnabled && (
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${trailFired ? "bg-cyan-400" : "bg-muted-foreground"}`} />
                    <span className="text-muted-foreground">Trailing Stop</span>
                    <span className={trailFired ? "text-cyan-400 font-medium" : "text-muted-foreground"}>
                      {trailFired ? "Active" : `Pending (${ef.trailingStopPips || "—"} pips)`}
                    </span>
                  </div>
                )}
                {holdEnabled && (
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${holdHours >= ef.maxHoldHours ? "bg-warning" : "bg-muted-foreground"}`} />
                    <span className="text-muted-foreground">Max Hold</span>
                    <span className={holdHours >= ef.maxHoldHours ? "text-warning font-medium" : "text-muted-foreground"}>
                      {holdHours.toFixed(1)}h / {ef.maxHoldHours}h
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
    </>
  );
}
