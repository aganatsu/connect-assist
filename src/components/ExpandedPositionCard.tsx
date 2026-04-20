import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
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

// ─── Management Card (ROW 2) ────────────────────────────────────────

function ManagementCard({
  title,
  active,
  lines,
  borderColor,
  badgeColor,
}: {
  title: string;
  active: boolean;
  lines: string[];
  borderColor: string;
  badgeColor: string;
}) {
  return (
    <div className={`flex-1 min-w-0 rounded-lg border-l-[3px] ${borderColor} bg-secondary/40 px-2.5 py-2`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold text-foreground/80 uppercase tracking-wider">{title}</span>
        <span className={`text-[9px] font-bold px-2 py-0.5 rounded ${badgeColor}`}>
          {active ? "ACTIVE" : "Pending"}
        </span>
      </div>
      {lines.map((line, i) => (
        <div key={i} className={`text-xs font-mono ${i === 0 ? "text-foreground/90" : "text-foreground/60"}`}>
          {line}
        </div>
      ))}
    </div>
  );
}

// ─── Inline SL/TP Editor (ROW 6) ───────────────────────────────────

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
    <div className="flex items-end gap-3 pt-2 border-t border-border/30">
      <div className="space-y-1 flex-1">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Stop Loss</Label>
        <Input
          type="number" step="0.00001" value={sl}
          onChange={(e) => setSl(e.target.value)} placeholder="—"
          className="h-9 text-xs font-mono px-2"
        />
      </div>
      <div className="space-y-1 flex-1">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Take Profit</Label>
        <Input
          type="number" step="0.00001" value={tp}
          onChange={(e) => setTp(e.target.value)} placeholder="—"
          className="h-9 text-xs font-mono px-2"
        />
      </div>
      <Button
        size="sm"
        className="h-9 px-6 text-xs bg-cyan-600 hover:bg-cyan-700 text-white"
        disabled={!dirty || saving}
        onClick={handleSave}
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
      </Button>
      {dirty && !saving && (
        <Button size="sm" variant="ghost" className="h-9 text-xs"
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

  // R-multiple (current floating R based on live price)
  const currentR = riskSl != null ? calcRMultiple(direction, entry, current, riskSl) : null;

  // Locked R (guaranteed R based on where trailing SL sits, not current price)
  const lockedR = (ef.trailingStopActivated && sl != null && riskSl != null)
    ? calcRMultiple(direction, entry, sl, riskSl)
    : null;

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
    || ef.trailingStop || ef.breakEven || ef.partialTP;

  // Parse summary for signal info
  const summaryText = sr.summary || "";
  const dirMatch = summaryText.match(/^(BUY|SELL)/i);
  const summaryDir = dirMatch ? dirMatch[1].toUpperCase() : null;
  const factorMatch = summaryText.match(/(\d+)\/(\d+)\s+factors/i);
  const factorCount = factorMatch ? parseInt(factorMatch[1], 10) : null;
  const factorTotal = factorMatch ? parseInt(factorMatch[2], 10) : null;
  const scoreMatch = summaryText.match(/score:\s*([\d.]+)\/10/i);
  const summaryScore = scoreMatch ? parseFloat(scoreMatch[1]) : null;

  // Setup info
  const setupType: string | null = sr.setupType ?? null;
  const setupConfidence: number | null = sr.setupConfidence ?? null;

  // Aligned factors — extract from factorScores or summary text
  // Summary format: "BUY: 9/22 factors ... (score: 8/10). Market Structure: MS+Trend | Order Flow: Breaker | FOTSI: aligned"
  // Each segment after ". " is "GroupName: Factor1+Factor2" separated by " | "
  let alignedFactors: string[] = [];
  if (Array.isArray(sr.factorScores) && sr.factorScores.length > 0) {
    alignedFactors = sr.factorScores
      .filter((f: any) => f.present)
      .map((f: any) => f.name);
  } else {
    // Split on first "). " to get the factor groups part
    const afterParen = summaryText.split(/\)\. /).slice(1).join("). ");
    if (afterParen) {
      // Split on " | " to get each group segment
      const segments = afterParen.split(/\s*\|\s*/);
      for (const seg of segments) {
        // Each segment is "GroupName: Factor1+Factor2" or "FOTSI: label"
        const colonIdx = seg.indexOf(":");
        if (colonIdx >= 0) {
          const groupName = seg.slice(0, colonIdx).trim();
          // Skip FOTSI — its value is a label ("aligned"/"divergent"), not factor names
          if (groupName.toUpperCase() === "FOTSI") continue;
          const factorsPart = seg.slice(colonIdx + 1).trim();
          // Split individual factors on "+"
          const names = factorsPart.split("+").map(s => s.trim()).filter(Boolean);
          alignedFactors.push(...names);
        } else {
          // No colon — treat the whole segment as a factor name
          const trimmed = seg.trim();
          if (trimmed) alignedFactors.push(trimmed);
        }
      }
    }
  }

  // Exit strategy config rows
  const exitConfig: { label: string; value: string }[] = [];
  if (ef.trailingStopPips != null) {
    exitConfig.push({ label: "Trailing", value: `${ef.trailingStopPips} pips${ef.trailingStopActivation ? ` (${ef.trailingStopActivation})` : ""}` });
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

  // Trigger icons/colors for exit attribution
  const triggerIcons: Record<string, string> = {
    trailing_enabled: "\u2197", trailing_stop: "\u2197",
    be_enabled: "\u2696", break_even: "\u2696",
    partial_enabled: "\uD83D\uDCB0", partial_tp: "\uD83D\uDCB0",
    structure_invalidated: "\uD83D\uDEE1", session_close: "\u23F0",
    max_hold_exceeded: "\u23F3", no_action: "\u2014",
  };
  const triggerColors: Record<string, string> = {
    trailing_enabled: "text-emerald-400", trailing_stop: "text-emerald-400",
    be_enabled: "text-yellow-400", break_even: "text-yellow-400",
    partial_enabled: "text-cyan-400", partial_tp: "text-cyan-400",
    structure_invalidated: "text-destructive", session_close: "text-orange-400",
    max_hold_exceeded: "text-orange-400", no_action: "text-muted-foreground",
  };

  return (
    <div className="bg-secondary/20 border border-border/50 rounded-lg p-3 space-y-2.5">

      {/* ═══ ROW 1: Trade Header Bar ═══ */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span className={`inline-flex items-center px-2.5 py-1 rounded text-[11px] font-bold tracking-wider ${
            direction === "long"
              ? "bg-success/15 border border-success/40 text-success"
              : "bg-destructive/15 border border-destructive/40 text-destructive"
          }`}>
            {direction === "long" ? "BUY" : "SELL"}
          </span>
          <span className="font-bold text-foreground text-base">{p.symbol}</span>
          <span className="text-muted-foreground text-xs">{parseFloat(p.size)?.toFixed(2)} lots</span>
          <span className={`text-xs ${direction === "long" ? "text-success" : "text-destructive"}`}>
            {direction === "long" ? "\u25B2" : "\u25BC"}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono flex-wrap">
          <span className="text-muted-foreground">Entry: <span className="text-foreground font-semibold">{formatPrice(entry, p.symbol)}</span></span>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">Current: <span className="text-foreground font-semibold">{formatPrice(current, p.symbol)}</span></span>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">P&L: <span className={`font-bold ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(p.pnl, true)}</span></span>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">Score: <span className="text-primary font-bold">{p.signalScore}/10</span></span>
        </div>
      </div>

      {/* ═══ ROW 2: Live Trade Management Status (3 cards) ═══ */}
      {hasManagement && (
        <div className="flex gap-2">
          {(ef.trailingStopEnabled || ef.trailingStop) && (
            <ManagementCard
              title="TRAILING STOP"
              active={!!ef.trailingStopActivated}
              borderColor="border-l-emerald-500"
              badgeColor={ef.trailingStopActivated
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-yellow-500/20 text-yellow-400"
              }
              lines={ef.trailingStopActivated
                ? [
                    sl != null ? `Current SL: ${formatPrice(sl, p.symbol)}` : "Active",
                    lockedR != null
                      ? (lockedR >= 0
                          ? `${lockedR.toFixed(2)}R locked`
                          : `Risk reduced to ${lockedR.toFixed(2)}R`)
                      : "",
                  ].filter(Boolean)
                : [
                    ef.trailingStopActivation
                      ? `Triggers ${ef.trailingStopActivation}`
                      : `${ef.trailingStopPips ?? "?"}p step`,
                  ]
              }
            />
          )}

          {(ef.breakEvenEnabled || ef.breakEven) && (
            <ManagementCard
              title="BREAK EVEN"
              active={!!ef.breakEvenActivated}
              borderColor="border-l-yellow-500"
              badgeColor={ef.breakEvenActivated
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-yellow-500/20 text-yellow-400"
              }
              lines={ef.breakEvenActivated
                ? [`SL moved to entry (${formatPrice(entry, p.symbol)})`]
                : [
                    bePrice != null
                      ? `Trigger: ${beR?.toFixed(1)}R (${formatPrice(bePrice, p.symbol)})`
                      : `${ef.breakEvenPips} pips from entry`,
                  ]
              }
            />
          )}

          {(ef.partialTPEnabled || ef.partialTP) && (
            <ManagementCard
              title="PARTIAL TP"
              active={!!ef.partialTPActivated || !!p.partialTpFired}
              borderColor="border-l-cyan-500"
              badgeColor={(ef.partialTPActivated || p.partialTpFired)
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-yellow-500/20 text-yellow-400"
              }
              lines={(ef.partialTPActivated || p.partialTpFired)
                ? [`${ef.partialTPPercent ?? 50}% closed at ${partialR ?? "?"}R`]
                : [
                    `${ef.partialTPPercent ?? 50}% @ ${partialR != null ? `${partialR}R` : `${ef.partialTPLevel ?? "?"}R`}`,
                  ]
              }
            />
          )}
        </div>
      )}

      {/* ═══ ROW 3: Signal + Exit Strategy (two columns, compact) ═══ */}
      <div className="grid grid-cols-2 gap-4">
        {/* Left: Signal */}
        <div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Signal</span>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {summaryDir && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider ${
                summaryDir === "BUY"
                  ? "bg-success/15 border border-success/40 text-success"
                  : "bg-destructive/15 border border-destructive/40 text-destructive"
              }`}>
                Direction {summaryDir}
              </span>
            )}
            <span className="text-[11px] text-foreground/80 font-mono">
              {factorCount != null ? `${factorCount}/${factorTotal} factors` : ""}
              {summaryScore != null ? ` \u00B7 score ${summaryScore}/10` : ""}
            </span>
          </div>
          {setupType && (
            <div className="text-[11px] text-foreground/70 font-mono mt-0.5">
              Setup: {setupType}{setupConfidence != null ? ` ${Math.round(setupConfidence * 100)}% conf` : ""}
            </div>
          )}
        </div>

        {/* Right: Exit Strategy */}
        {exitConfig.length > 0 && (
          <div>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Exit Strategy</span>
            <div className="mt-1 space-y-0.5">
              {exitConfig.map((c, i) => (
                <div key={i} className="text-[11px] font-mono text-foreground/80">
                  {c.label}: {c.value}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ═══ ROW 4: Aligned Factors (pills) ═══ */}
      {alignedFactors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {alignedFactors.map((f, i) => (
            <span
              key={i}
              className="rounded-full bg-secondary/60 border border-border px-2.5 py-0.5 text-[10px] text-foreground/80"
            >
              {f}
            </span>
          ))}
        </div>
      )}

      {/* ═══ ROW 5: Exit Attribution Timeline ═══ */}
      {exitAttribution.length > 0 && (
        <div className="space-y-1">
          {exitAttribution.map((ea: any, i: number) => {
            if (ea.trigger === "no_action") return null;
            const color = triggerColors[ea.trigger] || "text-muted-foreground";
            const icon = triggerIcons[ea.trigger] || "\u2022";
            return (
              <div key={i} className={`flex items-center gap-2 text-xs ${color}`}>
                <span className="flex-shrink-0">{icon}</span>
                <span className="font-bold font-mono">{ea.rMultiple?.toFixed(2)}R</span>
                <span className="text-foreground/70">{ea.detail}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Legacy invalidation history */}
      {invalidHistory.length > 0 && exitAttribution.length === 0 && (
        <div className="space-y-1">
          {invalidHistory.map((ih: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs text-destructive">
              <span className="flex-shrink-0">{"\uD83D\uDEE1"}</span>
              <span className="font-bold">SL Tightened</span>
              <span className="text-foreground/70">at {ih.rMultiple}R — {ih.reason}</span>
            </div>
          ))}
        </div>
      )}

      {/* ═══ ROW 6: SL/TP Editor ═══ */}
      <SLTPEditor position={p} onSaved={onSaved} />
    </div>
  );
}

export default ExpandedPositionCard;
