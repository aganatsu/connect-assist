import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { SignalReasoningCard } from "@/components/SignalReasoningCard";
import { formatFullDateTime } from "@/lib/formatTime";
import { formatMoney } from "@/lib/marketData";
import { paperApi } from "@/lib/api";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────────

interface ExpandedPositionCardProps {
  position: any;
  onSaved: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

function calcRMultiple(direction: string, entry: number, current: number, sl: number): number | null {
  const risk = direction === "long" ? entry - sl : sl - entry;
  if (!risk || risk <= 0) return null;
  const reward = direction === "long" ? current - entry : entry - current;
  return reward / risk;
}

function priceAtR(direction: string, entry: number, sl: number, rMultiple: number): number | null {
  const risk = direction === "long" ? entry - sl : sl - entry;
  if (!risk || risk <= 0) return null;
  return direction === "long" ? entry + risk * rMultiple : entry - risk * rMultiple;
}

function getPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes("JPY") || s.includes("XAU") || s.includes("GOLD")) return 0.01;
  if (s.includes("XAG") || s.includes("SILVER")) return 0.001;
  if (s.includes("BTC") || s.includes("ETH")) return 1;
  if (s.includes("US30") || s.includes("SPX") || s.includes("NAS")) return 1;
  return 0.0001;
}

function formatPrice(price: number, symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("JPY")) return price.toFixed(3);
  if (s.includes("XAU") || s.includes("GOLD")) return price.toFixed(2);
  return price.toFixed(5);
}

// ─── R-Multiple Progress Bar ────────────────────────────────────────

function RMultipleBar({
  currentR,
  tpR,
  beR,
  partialR,
  entry,
  currentPrice,
  tpPrice,
  bePrice,
  partialPrice,
  direction,
  symbol,
}: {
  currentR: number;
  tpR: number | null;
  beR: number | null;
  partialR: number | null;
  entry: number;
  currentPrice: number;
  tpPrice: number | null;
  bePrice: number | null;
  partialPrice: number | null;
  direction: string;
  symbol: string;
}) {
  const maxR = Math.max(tpR ? tpR + 0.5 : 2, 2);
  const minR = -1;
  const range = maxR - minR;

  const toPercent = (r: number) => Math.max(0, Math.min(100, ((r - minR) / range) * 100));

  const entryPct = toPercent(0);
  const currentPct = toPercent(currentR);
  const isProfit = currentR >= 0;

  // Build marker data for the legend below
  const markers: { r: number; label: string; price: string; color: string; bgColor: string }[] = [];
  markers.push({ r: 0, label: "Entry", price: formatPrice(entry, symbol), color: "text-muted-foreground", bgColor: "bg-muted-foreground" });
  if (beR != null && bePrice != null) {
    markers.push({ r: beR, label: `BE (${beR.toFixed(1)}R)`, price: formatPrice(bePrice, symbol), color: "text-yellow-400", bgColor: "bg-yellow-400" });
  }
  if (partialR != null && partialPrice != null) {
    markers.push({ r: partialR, label: `Partial (${partialR}R)`, price: formatPrice(partialPrice, symbol), color: "text-cyan-400", bgColor: "bg-cyan-400" });
  }
  if (tpR != null && tpPrice != null) {
    markers.push({ r: tpR, label: `TP (${tpR.toFixed(1)}R)`, price: formatPrice(tpPrice, symbol), color: "text-blue-400", bgColor: "bg-blue-400" });
  }

  return (
    <div className="w-full select-none bg-muted/10 rounded-lg border border-border/30 p-4">
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">R-Multiple</span>
        <span className={`text-lg font-mono font-bold ${isProfit ? "text-emerald-400" : "text-red-400"}`}>
          {currentR >= 0 ? "+" : ""}{currentR.toFixed(2)}R
        </span>
      </div>

      {/* Bar track — no overflow hidden so markers can extend */}
      <div className="relative h-4 bg-muted/30 rounded-full mx-2">
        {/* Fill from entry to current */}
        {isProfit ? (
          <div
            className="absolute top-0 bottom-0 rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400"
            style={{ left: `${entryPct}%`, width: `${Math.min(100 - entryPct, Math.max(0, currentPct - entryPct))}%` }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 rounded-full bg-gradient-to-r from-red-400 to-red-600"
            style={{ left: `${currentPct}%`, width: `${Math.min(100 - currentPct, Math.max(0, entryPct - currentPct))}%` }}
          />
        )}

        {/* Entry tick */}
        <div className="absolute top-0 bottom-0 w-[2px] bg-white/40 rounded" style={{ left: `${entryPct}%` }} />

        {/* BE tick */}
        {beR != null && (
          <div className="absolute -top-1 -bottom-1 w-[3px] bg-yellow-400 rounded" style={{ left: `${toPercent(beR)}%` }} />
        )}

        {/* Partial TP tick */}
        {partialR != null && (
          <div className="absolute -top-1 -bottom-1 w-[3px] bg-cyan-400 rounded" style={{ left: `${toPercent(partialR)}%` }} />
        )}

        {/* TP tick */}
        {tpR != null && (
          <div className="absolute -top-1 -bottom-1 w-[3px] bg-blue-400 rounded" style={{ left: `${toPercent(tpR)}%` }} />
        )}

        {/* Current position dot */}
        <div
          className={`absolute top-1/2 w-4 h-4 rounded-full border-2 shadow-lg ${
            isProfit ? "bg-emerald-400 border-white" : "bg-red-400 border-white"
          }`}
          style={{ left: `${currentPct}%`, transform: "translate(-50%, -50%)" }}
        />
      </div>

      {/* Scale labels below bar */}
      <div className="flex items-center justify-between mt-1 mx-2">
        <span className="text-[10px] text-muted-foreground/50 font-mono">-1R</span>
        <span className="text-[10px] text-muted-foreground/50 font-mono">0R</span>
        <span className="text-[10px] text-muted-foreground/50 font-mono">1R</span>
        <span className="text-[10px] text-muted-foreground/50 font-mono">+{maxR.toFixed(0)}R</span>
      </div>

      {/* Legend: marker labels with prices in a readable row */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 pt-3 border-t border-border/20">
        {markers.map((m, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded-sm flex-shrink-0 ${m.bgColor}`} />
            <span className={`text-xs font-medium ${m.color}`}>{m.label}</span>
            <span className="text-xs font-mono text-foreground/70">{m.price}</span>
          </div>
        ))}
        {/* Current price in legend too */}
        <div className="flex items-center gap-1.5">
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isProfit ? "bg-emerald-400" : "bg-red-400"}`} />
          <span className={`text-xs font-medium ${isProfit ? "text-emerald-400" : "text-red-400"}`}>Current</span>
          <span className="text-xs font-mono text-foreground/70">{formatPrice(currentPrice, symbol)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Trade Management Status Rows ───────────────────────────────────

function ManagementRow({
  label,
  active,
  activeText,
  pendingText,
  colorClass,
}: {
  label: string;
  active: boolean;
  activeText: string;
  pendingText: string;
  colorClass: "emerald" | "yellow" | "cyan";
}) {
  const colors = {
    emerald: {
      dot: active ? "bg-emerald-400" : "bg-emerald-400/30",
      badge: active ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" : "bg-muted/30 text-emerald-400/50 border-border/40",
      text: active ? "text-emerald-300" : "text-muted-foreground",
    },
    yellow: {
      dot: active ? "bg-yellow-400" : "bg-yellow-400/30",
      badge: active ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/50" : "bg-muted/30 text-yellow-400/50 border-border/40",
      text: active ? "text-yellow-300" : "text-muted-foreground",
    },
    cyan: {
      dot: active ? "bg-cyan-400" : "bg-cyan-400/30",
      badge: active ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/50" : "bg-muted/30 text-cyan-400/50 border-border/40",
      text: active ? "text-cyan-300" : "text-muted-foreground",
    },
  };
  const c = colors[colorClass];

  return (
    <div className="flex items-start gap-2 py-1.5 px-2.5 rounded-md bg-secondary/30 border border-border/30">
      <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${c.dot}`} />
      <span className="text-[11px] font-medium text-foreground/80 w-20 flex-shrink-0">{label}</span>
      <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded border flex-shrink-0 ${c.badge}`}>
        {active ? "ACTIVE" : "Pending"}
      </span>
      <span className={`text-[11px] font-mono leading-snug break-words ${c.text}`}>
        {active ? activeText : pendingText}
      </span>
    </div>
  );
}

// ─── Inline SL/TP Editor ────────────────────────────────────────────

function SLTPEditor({ position, onSaved }: { position: any; onSaved: () => void }) {
  const [sl, setSl] = useState(position.stopLoss ? String(parseFloat(position.stopLoss)) : "");
  const [tp, setTp] = useState(position.takeProfit ? String(parseFloat(position.takeProfit)) : "");
  const [saving, setSaving] = useState(false);

  const initialSl = position.stopLoss ? String(parseFloat(position.stopLoss)) : "";
  const initialTp = position.takeProfit ? String(parseFloat(position.takeProfit)) : "";
  const dirty = sl !== initialSl || tp !== initialTp;

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: { stopLoss?: number | null; takeProfit?: number | null } = {};
      if (sl !== initialSl) updates.stopLoss = sl === "" ? null : parseFloat(sl);
      if (tp !== initialTp) updates.takeProfit = tp === "" ? null : parseFloat(tp);
      await paperApi.updatePosition(position.id, updates);
      toast.success("SL/TP updated");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update SL/TP");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-end gap-3 pt-3 border-t border-border/40">
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Stop Loss</Label>
        <Input
          type="number" step="0.00001" value={sl}
          onChange={(e) => setSl(e.target.value)} placeholder="—"
          className="h-8 w-32 text-xs font-mono px-2"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Take Profit</Label>
        <Input
          type="number" step="0.00001" value={tp}
          onChange={(e) => setTp(e.target.value)} placeholder="—"
          className="h-8 w-32 text-xs font-mono px-2"
        />
      </div>
      <Button size="sm" className="h-8 text-xs px-4" disabled={!dirty || saving} onClick={handleSave}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
      </Button>
      {dirty && !saving && (
        <Button size="sm" variant="ghost" className="h-8 text-xs"
          onClick={() => { setSl(initialSl); setTp(initialTp); }}>
          Reset
        </Button>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function ExpandedPositionCard({ position: p, onSaved }: ExpandedPositionCardProps) {
  // Parse signal reason
  let sr: any = {};
  try { sr = JSON.parse(p.signalReason || "{}"); } catch { /* ignore */ }

  const ef = sr.exitFlags || {};
  const exitAttribution: any[] = sr.exitAttribution || [];
  const invalidHistory = sr.invalidationHistory || [];

  // Core values
  const entry = parseFloat(p.entryPrice);
  const current = parseFloat(p.currentPrice);
  const sl = p.stopLoss ? parseFloat(p.stopLoss) : null;
  const tp = p.takeProfit ? parseFloat(p.takeProfit) : null;
  const direction = p.direction;
  const pipSize = getPipSize(p.symbol);

  // Original SL for R-multiple calculation
  const originalSl = sl != null ? (
    ef.trailingStopActivated && ef.trailingStopPips
      ? (direction === "long" ? entry - ef.trailingStopPips * pipSize : entry + ef.trailingStopPips * pipSize)
      : sl
  ) : null;
  const riskSl = originalSl ?? sl;

  // R-multiple
  const currentR = riskSl != null ? calcRMultiple(direction, entry, current, riskSl) : null;
  const tpR = (tp != null && riskSl != null) ? calcRMultiple(direction, entry, tp, riskSl) : null;

  // BE trigger level
  const riskDist = riskSl != null ? (direction === "long" ? entry - riskSl : riskSl - entry) : null;
  const beR = ef.breakEvenPips != null && riskDist && riskDist > 0
    ? (ef.breakEvenPips * pipSize) / riskDist
    : null;
  const bePrice = beR != null && riskSl != null ? priceAtR(direction, entry, riskSl, beR) : null;

  // Partial TP level
  const partialR = ef.partialTPLevel ?? null;
  const partialPrice = partialR != null && riskSl != null ? priceAtR(direction, entry, riskSl, partialR) : null;

  // P&L pips
  const pnlPips = direction === "long"
    ? (current - entry) / pipSize
    : (entry - current) / pipSize;

  // Has any management features
  const hasManagement = ef.trailingStopEnabled || ef.breakEvenEnabled || ef.partialTPEnabled
    || ef.trailingStop || ef.breakEven || ef.partialTP
    || exitAttribution.length > 0 || invalidHistory.length > 0;

  // Exit strategy config rows
  const exitConfig: { label: string; value: string }[] = [];
  if (ef.trailingStopPips != null) {
    exitConfig.push({ label: "Trail", value: `${ef.trailingStopPips} pips${ef.trailingStopActivation ? ` (${ef.trailingStopActivation})` : ""}` });
  }
  if (ef.breakEvenPips != null) {
    exitConfig.push({ label: "BE", value: `${ef.breakEvenPips} pips` });
  }
  if (ef.tpRatio != null) {
    exitConfig.push({ label: "TP Ratio", value: `${ef.tpRatio}` });
  }
  if (ef.maxHoldHours != null) {
    exitConfig.push({ label: "Max Hold", value: `${ef.maxHoldHours}h` });
  }

  // Trigger colors and icons
  const triggerColors: Record<string, string> = {
    trailing_enabled: "text-emerald-400", trailing_stop: "text-emerald-400",
    be_enabled: "text-yellow-400", break_even: "text-yellow-400",
    partial_enabled: "text-cyan-400", partial_tp: "text-cyan-400",
    structure_invalidated: "text-destructive", session_close: "text-orange-400",
    max_hold_exceeded: "text-orange-400", no_action: "text-muted-foreground",
  };
  const triggerIcons: Record<string, string> = {
    trailing_enabled: "\u2197", trailing_stop: "\u2197",
    be_enabled: "\u2696", break_even: "\u2696",
    partial_enabled: "\uD83D\uDCB0", partial_tp: "\uD83D\uDCB0",
    structure_invalidated: "\uD83D\uDEE1", session_close: "\u23F0",
    max_hold_exceeded: "\u23F3", no_action: "\u2014",
  };

  return (
    <div className="bg-secondary/20 border border-border/50 rounded-lg p-4 space-y-4">
      {/* ── TOP BAR: Trade Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span className={`inline-flex items-center px-2 py-1 rounded text-[11px] font-bold tracking-wider ${
            direction === "long"
              ? "bg-success/15 border border-success/40 text-success"
              : "bg-destructive/15 border border-destructive/40 text-destructive"
          }`}>
            {direction === "long" ? "BUY" : "SELL"}
          </span>
          <span className="font-bold text-foreground text-sm">{p.symbol}</span>
          <span className="text-muted-foreground text-xs">{parseFloat(p.size)?.toFixed(2)} lots</span>
          <span className={`text-xs ${direction === "long" ? "text-success" : "text-destructive"}`}>
            {direction === "long" ? "▲" : "▼"}
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono">
          <span className="text-muted-foreground">Entry <span className="text-foreground font-medium">{formatPrice(entry, p.symbol)}</span></span>
          <span className="text-muted-foreground/50">→</span>
          <span className="text-muted-foreground">Now <span className="text-foreground font-medium">{formatPrice(current, p.symbol)}</span></span>
          <span className={`font-bold text-sm ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>
            {formatMoney(p.pnl, true)}
          </span>
          <span className={`text-xs ${pnlPips >= 0 ? "text-success/70" : "text-destructive/70"}`}>
            {pnlPips >= 0 ? "+" : ""}{pnlPips.toFixed(1)} pips
          </span>
          <span className="text-muted-foreground/60">Score <span className="text-primary font-bold">{p.signalScore}/10</span></span>
          <span className="text-muted-foreground/40">ID {p.orderId?.slice(0, 8)}</span>
        </div>
      </div>

      {/* ── TWO-COLUMN LAYOUT ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── LEFT COLUMN: Analysis ── */}
        <div className="space-y-3 min-w-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Analysis</p>
          <SignalReasoningCard signalReason={p.signalReason || ""} />
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Opened: <span className="font-mono text-foreground/70">{formatFullDateTime(p.openTime)}</span></span>
          </div>
        </div>

        {/* ── RIGHT COLUMN: Trade Management ── */}
        <div className="space-y-3 min-w-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Trade Management</p>

          {/* R-Multiple Progress Bar */}
          {currentR != null && (
            <RMultipleBar
              currentR={currentR}
              tpR={tpR}
              beR={beR}
              partialR={partialR}
              entry={entry}
              currentPrice={current}
              tpPrice={tp}
              bePrice={bePrice}
              partialPrice={partialPrice}
              direction={direction}
              symbol={p.symbol}
            />
          )}

          {/* Management status rows */}
          {hasManagement && (
            <div className="space-y-1.5">
              {(ef.trailingStopEnabled || ef.trailingStop) && (
                <ManagementRow
                  label="Trailing"
                  active={!!ef.trailingStopActivated}
                  colorClass="emerald"
                  activeText={sl != null
                    ? `SL → ${formatPrice(sl, p.symbol)} (${currentR != null ? currentR.toFixed(2) : "?"}R)`
                    : "Active"
                  }
                  pendingText={ef.trailingStopActivation
                    ? `Triggers ${ef.trailingStopActivation} · ${ef.trailingStopPips}p`
                    : `${ef.trailingStopPips ?? "?"}p step`
                  }
                />
              )}

              {(ef.breakEvenEnabled || ef.breakEven) && (
                <ManagementRow
                  label="Break Even"
                  active={!!ef.breakEvenActivated}
                  colorClass="yellow"
                  activeText={`SL → entry (${formatPrice(entry, p.symbol)})`}
                  pendingText={bePrice != null
                    ? `At ${beR?.toFixed(1)}R → SL to ${formatPrice(entry, p.symbol)}`
                    : `${ef.breakEvenPips}p from entry`
                  }
                />
              )}

              {(ef.partialTPEnabled || ef.partialTP) && (
                <ManagementRow
                  label="Partial TP"
                  active={!!ef.partialTPActivated || !!p.partialTpFired}
                  colorClass="cyan"
                  activeText={`${ef.partialTPPercent ?? 50}% closed at ${partialR ?? "?"}R`}
                  pendingText={partialPrice != null
                    ? `${ef.partialTPPercent ?? 50}% @ ${partialR}R (${formatPrice(partialPrice, p.symbol)})`
                    : `${ef.partialTPPercent ?? 50}% @ ${ef.partialTPLevel ?? "?"}R`
                  }
                />
              )}
            </div>
          )}

          {/* Exit config summary */}
          {exitConfig.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs px-2.5 py-1.5 bg-muted/20 rounded-md border border-border/20">
              {exitConfig.map((c, i) => (
                <span key={i} className="text-muted-foreground">
                  {c.label}: <span className="font-mono text-foreground/70">{c.value}</span>
                </span>
              ))}
            </div>
          )}

          {/* Exit attribution timeline */}
          {exitAttribution.length > 0 && (
            <div className="space-y-1 pl-1">
              {exitAttribution.map((ea: any, i: number) => {
                if (ea.trigger === "no_action") return null;
                const color = triggerColors[ea.trigger] || "text-muted-foreground";
                const icon = triggerIcons[ea.trigger] || "\u2022";
                return (
                  <div key={i} className={`flex items-start gap-1.5 text-xs ${color}`}>
                    <span className="flex-shrink-0">{icon}</span>
                    <span className="font-medium font-mono flex-shrink-0">{ea.rMultiple?.toFixed(2)}R</span>
                    <span className="text-muted-foreground break-words">{ea.detail}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Legacy invalidation history */}
          {invalidHistory.length > 0 && exitAttribution.length === 0 && (
            <div className="space-y-1 pl-1">
              {invalidHistory.map((ih: any, i: number) => (
                <div key={i} className="flex items-start gap-1.5 text-xs text-destructive">
                  <span className="flex-shrink-0">{"\uD83D\uDEE1"}</span>
                  <span className="font-medium flex-shrink-0">SL Tightened</span>
                  <span className="text-muted-foreground">at {ih.rMultiple}R — {ih.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── BOTTOM: SL/TP Editor ── */}
      <SLTPEditor position={p} onSaved={onSaved} />
    </div>
  );
}

export default ExpandedPositionCard;
