import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { OverrideBadge } from "@/components/TradeOverrideEditor";
import { ChevronRight } from "lucide-react";

interface MobilePositionCardProps {
  position: any;
  isExpanded: boolean;
  onToggle: () => void;
  onClose: (id: string) => void;
}

export function MobilePositionCard({ position: p, isExpanded, onToggle, onClose }: MobilePositionCardProps) {
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

  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex items-center gap-3 active:bg-secondary/30 transition-colors"
      >
        {/* Direction indicator */}
        <div className={`w-1 h-8 rounded-full shrink-0 ${p.direction === "long" ? "bg-success" : "bg-destructive"}`} />

        {/* Main info */}
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-mono font-medium">{p.symbol}</span>
            <span className={`text-[9px] font-medium ${p.direction === "long" ? "text-success" : "text-destructive"}`}>
              {p.direction === "long" ? "LONG" : "SHORT"}
            </span>
            <OverrideBadge position={p} />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
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
              <span className="text-[8px] text-muted-foreground font-mono">
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
              <span className="text-muted-foreground">SL</span>
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
          </div>
          <div className="pl-4 flex gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onClose(p.id); }}
              className="text-[10px] font-medium text-destructive border border-destructive/30 px-2 py-1 hover:bg-destructive/10 transition-colors"
            >
              Close Position
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
