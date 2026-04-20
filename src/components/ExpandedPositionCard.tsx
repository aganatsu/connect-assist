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

/** Calculate current R-multiple: (current - entry) / (entry - sl) for long, inverted for short */
function calcRMultiple(direction: string, entry: number, current: number, sl: number): number | null {
  const risk = direction === "long" ? entry - sl : sl - entry;
  if (!risk || risk <= 0) return null;
  const reward = direction === "long" ? current - entry : entry - current;
  return reward / risk;
}

/** Calculate the price at a given R-multiple */
function priceAtR(direction: string, entry: number, sl: number, rMultiple: number): number | null {
  const risk = direction === "long" ? entry - sl : sl - entry;
  if (!risk || risk <= 0) return null;
  return direction === "long" ? entry + risk * rMultiple : entry - risk * rMultiple;
}

/** Calculate pip value based on symbol */
function getPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes("JPY") || s.includes("XAU") || s.includes("GOLD")) return 0.01;
  if (s.includes("XAG") || s.includes("SILVER")) return 0.001;
  if (s.includes("BTC") || s.includes("ETH")) return 1;
  if (s.includes("US30") || s.includes("SPX") || s.includes("NAS")) return 1;
  return 0.0001;
}

function priceToPips(symbol: string, priceDistance: number): string {
  const pipSize = getPipSize(symbol);
  return (priceDistance / pipSize).toFixed(1);
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
}) {
  // Bar range: -1R to max(tpR + 0.5, 2R)
  const maxR = Math.max(tpR ? tpR + 0.5 : 2, 2);
  const minR = -1;
  const range = maxR - minR;

  const toPercent = (r: number) => Math.max(0, Math.min(100, ((r - minR) / range) * 100));

  const entryPct = toPercent(0);
  const currentPct = toPercent(currentR);
  const isProfit = currentR >= 0;

  // Markers
  const markers: { r: number; label: string; price: string; color: string }[] = [];
  if (beR != null && bePrice != null) {
    markers.push({ r: beR, label: `${beR}R BE`, price: bePrice.toFixed(5), color: "text-yellow-400" });
  }
  if (partialR != null && partialPrice != null) {
    markers.push({ r: partialR, label: `${partialR}R PT`, price: partialPrice.toFixed(3), color: "text-cyan-400" });
  }
  if (tpR != null && tpPrice != null) {
    markers.push({ r: tpR, label: `TP`, price: tpPrice.toFixed(5), color: "text-blue-400" });
  }

  return (
    <div className="relative w-full h-14 select-none">
      {/* Track */}
      <div className="absolute top-5 left-0 right-0 h-1.5 bg-muted/40 rounded-full" />

      {/* Fill from entry to current */}
      {isProfit ? (
        <div
          className="absolute top-5 h-1.5 rounded-full bg-gradient-to-r from-emerald-500/60 to-emerald-400"
          style={{ left: `${entryPct}%`, width: `${Math.max(0, currentPct - entryPct)}%` }}
        />
      ) : (
        <div
          className="absolute top-5 h-1.5 rounded-full bg-gradient-to-r from-red-400 to-red-500/60"
          style={{ left: `${currentPct}%`, width: `${Math.max(0, entryPct - currentPct)}%` }}
        />
      )}

      {/* Entry marker */}
      <div className="absolute top-3 flex flex-col items-center" style={{ left: `${entryPct}%`, transform: "translateX(-50%)" }}>
        <div className="w-0.5 h-4 bg-muted-foreground/60" />
        <span className="text-[7px] text-muted-foreground mt-0.5">Entry</span>
      </div>

      {/* Current position dot */}
      <div className="absolute flex flex-col items-center" style={{ left: `${currentPct}%`, transform: "translateX(-50%)", top: "0px" }}>
        <span className={`text-[8px] font-mono font-bold ${isProfit ? "text-emerald-400" : "text-red-400"}`}>
          {currentR >= 0 ? "+" : ""}{currentR.toFixed(2)}R
        </span>
        <div className={`w-2.5 h-2.5 rounded-full border-2 mt-0.5 ${isProfit ? "bg-emerald-400 border-emerald-300" : "bg-red-400 border-red-300"}`} />
      </div>

      {/* R-level markers */}
      {markers.map((m, i) => (
        <div
          key={i}
          className="absolute flex flex-col items-center"
          style={{ left: `${toPercent(m.r)}%`, transform: "translateX(-50%)", top: "12px" }}
        >
          <div className={`w-0.5 h-5 ${m.color.replace("text-", "bg-")} opacity-60`} />
          <span className={`text-[7px] font-mono mt-0.5 ${m.color} opacity-80`}>{m.label}</span>
        </div>
      ))}

      {/* Scale labels */}
      <div className="absolute bottom-0 left-0 text-[7px] text-muted-foreground/50 font-mono">-1R</div>
      <div className="absolute bottom-0 text-[7px] text-muted-foreground/50 font-mono" style={{ left: `${toPercent(1)}%`, transform: "translateX(-50%)" }}>1R</div>
      <div className="absolute bottom-0 right-0 text-[7px] text-muted-foreground/50 font-mono">+{maxR.toFixed(1)}R</div>
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
      badge: active ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" : "bg-emerald-500/5 text-emerald-400/50 border-emerald-500/20",
      text: active ? "text-emerald-300" : "text-emerald-400/40",
    },
    yellow: {
      dot: active ? "bg-yellow-400" : "bg-yellow-400/30",
      badge: active ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/50" : "bg-yellow-500/5 text-yellow-400/50 border-yellow-500/20",
      text: active ? "text-yellow-300" : "text-yellow-400/40",
    },
    cyan: {
      dot: active ? "bg-cyan-400" : "bg-cyan-400/30",
      badge: active ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/50" : "bg-cyan-500/5 text-cyan-400/50 border-cyan-500/20",
      text: active ? "text-cyan-300" : "text-cyan-400/40",
    },
  };
  const c = colors[colorClass];

  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded bg-secondary/30 border border-border/30">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.dot}`} />
      <span className="text-[9px] font-medium text-foreground/80 w-16 flex-shrink-0">{label}</span>
      <span className={`px-1.5 py-0.5 text-[8px] font-bold rounded border ${c.badge}`}>
        {active ? "ACTIVE" : "Pending"}
      </span>
      <span className={`text-[9px] font-mono flex-1 truncate ${c.text}`}>
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
    <div className="flex items-end gap-2 pt-2 border-t border-border/40">
      <div className="space-y-0.5">
        <Label className="text-[8px] text-muted-foreground uppercase tracking-wider">Stop Loss</Label>
        <Input
          type="number" step="0.00001" value={sl}
          onChange={(e) => setSl(e.target.value)} placeholder="—"
          className="h-7 w-28 text-[10px] font-mono px-1.5"
        />
      </div>
      <div className="space-y-0.5">
        <Label className="text-[8px] text-muted-foreground uppercase tracking-wider">Take Profit</Label>
        <Input
          type="number" step="0.00001" value={tp}
          onChange={(e) => setTp(e.target.value)} placeholder="—"
          className="h-7 w-28 text-[10px] font-mono px-1.5"
        />
      </div>
      <Button size="sm" className="h-7 text-[10px]" disabled={!dirty || saving} onClick={handleSave}>
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
      </Button>
      {dirty && !saving && (
        <Button size="sm" variant="ghost" className="h-7 text-[10px]"
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

  // Original SL from exit flags (the initial SL before any trailing/BE moved it)
  // We need the original entry SL to calculate R-multiples properly
  // The original risk = entry - originalSL (for long)
  // If trailing has moved the SL, the current SL is different from original
  const originalSlPips = ef.trailingStopPips || ef.breakEvenPips;
  const originalSl = sl != null ? (
    ef.trailingStopActivated && ef.trailingStopPips
      ? (direction === "long" ? entry - ef.trailingStopPips * pipSize : entry + ef.trailingStopPips * pipSize)
      : sl
  ) : null;

  // Use original SL for R-multiple calculation (risk = distance from entry to original SL)
  // But if we don't have original SL info, use current SL
  const riskSl = originalSl ?? sl;

  // R-multiple
  const currentR = riskSl != null ? calcRMultiple(direction, entry, current, riskSl) : null;

  // TP R-multiple
  const tpR = (tp != null && riskSl != null) ? calcRMultiple(direction, entry, tp, riskSl) : null;

  // BE trigger level
  const beR = ef.breakEvenPips != null && riskSl != null
    ? (ef.breakEvenPips * pipSize) / (direction === "long" ? entry - riskSl : riskSl - entry)
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

  // Trigger colors and icons for exit attribution
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
    <div className="bg-secondary/20 border border-border/50 rounded-md p-3 space-y-3 text-[10px]">
      {/* ── TOP BAR: Trade Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
            direction === "long"
              ? "bg-success/15 border border-success/40 text-success"
              : "bg-destructive/15 border border-destructive/40 text-destructive"
          }`}>
            {direction === "long" ? "BUY" : "SELL"}
          </span>
          <span className="font-bold text-foreground text-[12px]">{p.symbol}</span>
          <span className="text-muted-foreground text-[10px]">{parseFloat(p.size)?.toFixed(2)} lots</span>
          <span className={`text-[10px] ${direction === "long" ? "text-success" : "text-destructive"}`}>
            {direction === "long" ? "▲" : "▼"}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono">
          <span className="text-muted-foreground">Entry <span className="text-foreground">{entry.toFixed(5)}</span></span>
          <span className="text-muted-foreground">→</span>
          <span className="text-muted-foreground">Now <span className="text-foreground">{current.toFixed(5)}</span></span>
          <span className={`font-bold ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>
            {formatMoney(p.pnl, true)}
          </span>
          <span className={`${pnlPips >= 0 ? "text-success/70" : "text-destructive/70"}`}>
            {pnlPips >= 0 ? "+" : ""}{pnlPips.toFixed(1)} pips
          </span>
          <span className="text-muted-foreground">Score</span>
          <span className="text-primary font-bold">{p.signalScore}/10</span>
          <span className="text-muted-foreground">ID</span>
          <span className="text-muted-foreground/60">{p.orderId?.slice(0, 8)}</span>
        </div>
      </div>

      {/* ── TWO-COLUMN LAYOUT ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* ── LEFT COLUMN: Analysis ── */}
        <div className="space-y-2">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Analysis</p>
          <SignalReasoningCard signalReason={p.signalReason || ""} />
          {/* Extra metadata */}
          <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
            <span>Opened: <span className="font-mono text-foreground/70">{formatFullDateTime(p.openTime)}</span></span>
          </div>
        </div>

        {/* ── RIGHT COLUMN: Trade Management ── */}
        <div className="space-y-2">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Trade Management</p>

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
            />
          )}

          {/* Management status rows */}
          {hasManagement && (
            <div className="space-y-1">
              {/* Trailing Stop */}
              {(ef.trailingStopEnabled || ef.trailingStop) && (
                <ManagementRow
                  label="Trailing"
                  active={!!ef.trailingStopActivated}
                  colorClass="emerald"
                  activeText={sl != null
                    ? `SL moved to ${sl.toFixed(5)} (${currentR != null ? currentR.toFixed(2) : "?"}R locked)`
                    : "Active"
                  }
                  pendingText={ef.trailingStopActivation
                    ? `Triggers ${ef.trailingStopActivation} · ${ef.trailingStopPips} pips`
                    : `${ef.trailingStopPips ?? "?"} pips`
                  }
                />
              )}

              {/* Break Even */}
              {(ef.breakEvenEnabled || ef.breakEven) && (
                <ManagementRow
                  label="Break Even"
                  active={!!ef.breakEvenActivated}
                  colorClass="yellow"
                  activeText={`SL moved to entry (${entry.toFixed(5)})`}
                  pendingText={bePrice != null
                    ? `Triggers at ${beR?.toFixed(1)}R → moves SL to ${entry.toFixed(5)}`
                    : `${ef.breakEvenPips} pips from entry`
                  }
                />
              )}

              {/* Partial TP */}
              {(ef.partialTPEnabled || ef.partialTP) && (
                <ManagementRow
                  label="Partial TP"
                  active={!!ef.partialTPActivated || !!p.partialTpFired}
                  colorClass="cyan"
                  activeText={`${ef.partialTPPercent ?? 50}% closed at ${partialR ?? "?"}R`}
                  pendingText={partialPrice != null
                    ? `${ef.partialTPPercent ?? 50}% close at ${partialR}R (${partialPrice.toFixed(5)})`
                    : `${ef.partialTPPercent ?? 50}% @ ${ef.partialTPLevel ?? "?"}R`
                  }
                />
              )}
            </div>
          )}

          {/* Exit config summary */}
          {exitConfig.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] px-2 py-1 bg-muted/20 rounded border border-border/20">
              {exitConfig.map((c, i) => (
                <span key={i} className="text-muted-foreground">
                  {c.label}: <span className="font-mono text-foreground/70">{c.value}</span>
                </span>
              ))}
            </div>
          )}

          {/* Exit attribution timeline */}
          {exitAttribution.length > 0 && (
            <div className="space-y-0.5 pl-1">
              {exitAttribution.map((ea: any, i: number) => {
                if (ea.trigger === "no_action") return null;
                const color = triggerColors[ea.trigger] || "text-muted-foreground";
                const icon = triggerIcons[ea.trigger] || "\u2022";
                return (
                  <div key={i} className={`flex items-center gap-1 text-[9px] ${color}`}>
                    <span>{icon}</span>
                    <span className="font-medium font-mono">{ea.rMultiple?.toFixed(2)}R</span>
                    <span className="text-muted-foreground truncate max-w-[280px]">{ea.detail}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Legacy invalidation history */}
          {invalidHistory.length > 0 && exitAttribution.length === 0 && (
            <div className="space-y-0.5 pl-1">
              {invalidHistory.map((ih: any, i: number) => (
                <div key={i} className="flex items-center gap-1 text-[9px] text-destructive">
                  <span>{"\uD83D\uDEE1"}</span>
                  <span className="font-medium">SL Tightened</span>
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
