/**
 * Scan → Detail Breakdown: what Scalper15 decided for this pair (bot-scanner writes detail.scalper15 and
 * detail.skipReason / detail.reason). Shown above the confluence breakdown, which under Scalper15 is
 * recorded only — without this panel the screen answers a question the strategy no longer asks.
 */

import { fmt, scalper15Headline, type Scalper15Detail } from "@/lib/scalper15";

export function Scalper15Panel({ status, s, skipReason, reason }: { status?: string; s: Scalper15Detail; skipReason?: string; reason?: string }) {
  const dir = s.bias === 1 ? "LONG" : s.bias === -1 ? "SHORT" : "none";
  const placed = status === "scalper15_order_placed";
  return (
    <div className="border border-primary/30 rounded-sm">
      <div className="flex items-center gap-1.5 px-1.5 py-0.5 bg-primary/10 border-b border-primary/20">
        <span className="text-[9px] font-bold uppercase tracking-wider text-primary">Scalper15</span>
        <span className={`text-[9px] font-bold ${placed ? "text-success" : "text-muted-foreground"}`}>{placed ? "order placed" : "no order"}</span>
        <span className="text-[9px] text-muted-foreground ml-auto">this decides the trade</span>
      </div>
      <div className="px-1.5 py-1 space-y-0.5 text-[10px]">
        <p className="leading-tight">{scalper15Headline(status, s, skipReason, reason)}</p>
        <div className="grid grid-cols-2 gap-x-2 font-mono text-muted-foreground">
          <span>1H direction: <span className={dir === "LONG" ? "text-success" : dir === "SHORT" ? "text-destructive" : ""}>{dir}</span></span>
          <span>1H target: {fmt(s.bias === 1 ? s.legHigh : s.bias === -1 ? s.legLow : undefined)}</span>
          {s.zone && <span>15m {s.zone.type}: {fmt(s.zone.low)}–{fmt(s.zone.high)}</span>}
          {s.stop !== undefined && <span>Stop: {fmt(s.stop)}</span>}
          {s.plannedR !== undefined && <span>Planned: {s.plannedR.toFixed(2)}R</span>}
        </div>
        <p className="text-[9px] text-muted-foreground/80 italic">The tier score below is the old confluence engine — recorded only; it does not block or allow Scalper15 trades.</p>
      </div>
    </div>
  );
}
