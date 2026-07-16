import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { formatPrice } from "@/lib/formatTime";
import { paperApi } from "@/lib/api";
import { toast } from "sonner";
import { TierFactorBreakdown, TierScoreSummary, type TieredScoringMeta } from "./TierFactorBreakdown";
import { TradeOverrideEditor } from "./TradeOverrideEditor";

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
  const inst = INSTRUMENTS.find(i => i.symbol === symbol);
  return inst?.pipSize ?? 0.0001;
}

// formatPrice is now imported from @/lib/formatTime (single source of truth)

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
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Current SL</Label>
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
  // Priority: 1) sr.originalSL (stored at trade open — new trades)
  //           2) If BE/trailing haven't fired yet, current SL IS the original
  //           3) Fall back to current SL (best we can do for legacy trades)
  const storedOriginalSl = sr.originalSL != null ? parseFloat(sr.originalSL) : null;
  const originalSl = storedOriginalSl
    ?? ((!ef.breakEvenActivated && !ef.trailingStopActivated) ? sl : null)
    ?? sl; // last resort: use current SL (may be moved, but better than a bogus number)
  const riskSl = originalSl ?? sl;

  // R-multiple (current floating R based on live price)
  const currentR = riskSl != null ? calcRMultiple(direction, entry, current, riskSl) : null;

  // Locked R (guaranteed R based on where trailing SL sits, not current price)
  // Only meaningful when trailing is active AND SL is on the profit side of entry
  const rawLockedR = (ef.trailingStopActivated && sl != null && riskSl != null)
    ? calcRMultiple(direction, entry, sl, riskSl)
    : null;
  // Cap: locked R can never exceed current R (you can't lock more than you have)
  const lockedR = (rawLockedR != null && currentR != null)
    ? Math.min(rawLockedR, currentR)
    : rawLockedR;

  // Locked P&L in dollars (what you'd get if trailing SL is hit)
  const lockedPnl = (ef.trailingStopActivated && sl != null)
    ? (() => {
        const diff = direction === "long" ? sl - entry : entry - sl;
        const pipsLocked = diff / pipSize;
        const currentPnlPips = direction === "long" ? (current - entry) / pipSize : (entry - current) / pipSize;
        if (Math.abs(currentPnlPips) > 0.001 && p.pnl != null) {
          const raw = (pipsLocked / currentPnlPips) * p.pnl;
          // Cap: locked P&L can never exceed current floating P&L
          return p.pnl >= 0 ? Math.min(raw, p.pnl) : Math.max(raw, p.pnl);
        }
        return null;
      })()
    : null;

  // BE trigger level
  const riskDist = riskSl != null ? (direction === "long" ? entry - riskSl : riskSl - entry) : null;
  const beR = ef.breakEvenPips != null && riskDist && riskDist > 0
    ? Math.min(2.0, Math.max(1.0, (ef.breakEvenPips * pipSize) / riskDist))
    : null;
  const bePrice = beR != null && riskSl != null ? priceAtR(direction, entry, riskSl, beR) : null;

  // Partial TP level
  const partialR = ef.partialTPLevel ?? null;
  const partialPrice = partialR != null && riskSl != null ? priceAtR(direction, entry, riskSl, partialR) : null;

  // P&L pips
  const pnlPips = direction === "long"
    ? (current - entry) / pipSize
    : (entry - current) / pipSize;

  // Dollar per pip (derived from live P&L / pips)
  const dollarPerPip = (Math.abs(pnlPips) > 0.01 && p.pnl != null)
    ? Math.abs(p.pnl / pnlPips)
    : null;

  // Risk in pips (SL distance)
  const riskPips = riskDist != null ? riskDist / pipSize : null;

  // Trailing stop: activation pips & trail distance pips
  const trailActivationR = ef.trailingStopActivation === "after_0.5r" ? 0.5
    : ef.trailingStopActivation === "after_1r" ? 1.0
    : ef.trailingStopActivation === "after_1.5r" ? 1.5
    : ef.trailingStopActivation === "after_2r" ? 2.0
    : null;
  const trailActivationPips = trailActivationR != null && riskPips != null
    ? trailActivationR * riskPips : null;
  const trailActivationDollar = trailActivationPips != null && dollarPerPip != null
    ? trailActivationPips * dollarPerPip : null;
  const trailDistPips = ef.trailingStopPips ?? null;

  // Break-even: trigger pips & dollar
  const beTriggerPips = ef.breakEvenPips ?? null;
  const beTriggerDollar = beTriggerPips != null && dollarPerPip != null
    ? beTriggerPips * dollarPerPip : null;

  // Partial TP: trigger pips & dollar
  const partialTriggerPips = partialR != null && riskPips != null
    ? partialR * riskPips : null;
  const partialTriggerDollar = partialTriggerPips != null && dollarPerPip != null
    ? partialTriggerPips * dollarPerPip : null;

  // Format helper for pips + dollar
  const fmtPipsDollar = (pips: number | null, dollar: number | null): string => {
    if (pips == null) return "";
    const pipStr = `+${pips.toFixed(1)}p`;
    if (dollar != null) return `${pipStr} / ~${formatMoney(dollar, true)}`;
    return pipStr;
  };

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
  // Try percentage format first (new), then legacy /10 format
  const pctMatch = summaryText.match(/score:\s*([\d.]+)%/i);
  const legacyScoreMatch = summaryText.match(/score:\s*([\d.]+)\/10/i);
  const summaryScore = pctMatch ? parseFloat(pctMatch[1]) : (legacyScoreMatch ? parseFloat(legacyScoreMatch[1]) : null);

  // Setup info
  const setupType: string | null = sr.setupType ?? null;
  const setupConfidence: number | null = sr.setupConfidence ?? null;

  // Aligned factors — extract from factorScores or summary text
  // Summary format: "BUY: 9/17 factors ... (score: 72.5%). Market Structure: MS+Trend | Order Flow: Breaker | FOTSI: aligned"
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
  // TP Method — show the targeting strategy used for this trade
  if (sr.tpMethod) {
    const tpMethodLabels: Record<string, string> = {
      rr_ratio: `R:R (${ef.tpRatio || sr.exitFlags?.tpRatio || "2.0"}:1)`,
      next_level: "Next Structure Level",
      fixed_pips: "Fixed Pips",
      atr_multiple: "ATR Multiple",
    };
    exitConfig.push({ label: "TP Target", value: tpMethodLabels[sr.tpMethod] || sr.tpMethod });
  }
  if (ef.trailingStopPips != null) {
    exitConfig.push({ label: "Trailing", value: `${ef.trailingStopPips} pips${ef.trailingStopActivation ? ` (${ef.trailingStopActivation})` : ""}` });
  }
  if (ef.breakEvenPips != null) {
    exitConfig.push({ label: "BE", value: `${ef.breakEvenPips} pips` });
  }
  if (ef.tpRatio != null && sr.tpMethod !== "rr_ratio") {
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
    trailing_enabled: "text-profit", trailing_stop: "text-profit",
    be_enabled: "text-highlight", break_even: "text-highlight",
    partial_enabled: "text-cyan-400", partial_tp: "text-cyan-400",
    structure_invalidated: "text-destructive", session_close: "text-warn",
    max_hold_exceeded: "text-warn", no_action: "text-muted-foreground",
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
          {p.mirrorStatus === "mirrored" && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-success/15 border border-success/40 text-success"
              title={`Mirrored to ${p.mirroredConnectionIds?.length || 0} broker connection(s)`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-success" /> MIRRORED
            </span>
          )}
          {p.mirrorStatus === "orphan" && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-warning/15 border border-warning/40 text-warning"
              title="Live mode but no broker link — this trade was NOT mirrored to MT4/MT5 at open (broker likely undeployed). SL/TP, reverse-close and management will NOT fan out. Close manually on MT5 if needed."
            >
              <span className="w-1.5 h-1.5 rounded-full bg-warning" /> ORPHAN
            </span>
          )}
          {sr.promotedFromWatchlist && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-cyan-500/15 border border-cyan-500/40 text-cyan-400" title={sr.watchlistOrigin?.promotionReason || "Promoted from watchlist"}>
              \ud83d\udccb WATCHLIST
              {sr.watchlistOrigin?.cyclesWatched && <span className="text-cyan-300/70">({sr.watchlistOrigin.cyclesWatched} cycles)</span>}
            </span>
          )}
          {sr.signalSource && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold ${
              sr.signalSource === "unified" ? "bg-cyan-500/15 border border-cyan-500/40 text-cyan-400" :
              sr.signalSource === "cascade" ? "bg-purple-500/15 border border-purple-500/40 text-purple-400" :
              "bg-orange-500/15 border border-orange-500/40 text-orange-400"
            }`} title={sr.signalSource === "unified" ? "Full unified confirmation — full position size" : sr.signalSource === "cascade" ? "Cascade zone confirmation — full position size" : "Standalone impulse zone entry — position size halved (×0.5)"}>
              {sr.signalSource === "unified" ? "UNIFIED ×1" : sr.signalSource === "cascade" ? "CASCADE ×1" : "STANDALONE ×0.5"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs font-mono flex-wrap">
          <span className="text-muted-foreground">Entry: <span className="text-foreground font-semibold">{formatPrice(entry, p.symbol)}</span></span>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">Current: <span className="text-foreground font-semibold">{formatPrice(current, p.symbol)}</span></span>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">P&L: <span className={`font-bold ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(p.pnl, true)}</span></span>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">Score: <span className="text-primary font-bold">{Number(p.signalScore) > 10 ? `${Number(p.signalScore).toFixed(1)}%` : `${p.signalScore}/10`}</span></span>
        </div>
      </div>

      {/* ═══ ROW 1.5: Entry Confirmation Story ═══ */}
      {(sr.confirmationEntry || sr.entryMethod === "market_fill_at_zone" || sr.filledFromLimitOrder) && (() => {
        const conf = sr.confirmation || {};
        const lo = sr.limitOrderOrigin || {};
        const iz = sr.impulseZoneEntry || sr.impulseZone?.bestZone || {};
        const isConfirmedEntry = sr.confirmationEntry && conf.type;
        const isMarketFillAtZone = sr.entryMethod === "market_fill_at_zone";
        const hasWatchlistOrigin = sr.promotedFromWatchlist && sr.watchlistOrigin;

        const confirmTypeLabels: Record<string, string> = {
          engulfing: "Engulfing", rejection_wick: "Rejection Wick",
          fvg: "FVG Created", sweep_reclaim: "Sweep + Reclaim",
          displacement: "Displacement", volume_spike: "Volume Spike",
        };
        const confirmLabel = confirmTypeLabels[conf.type] || conf.type || "\u2014";

        const tierColors: Record<number, string> = {
          1: "bg-success/15 border-success/40 text-success",
          2: "bg-cyan-500/15 border-cyan-500/40 text-cyan-400",
          3: "bg-purple-500/15 border-purple-500/40 text-purple-400",
        };

        const zoneType = lo.zoneType || iz.zoneType || iz.type || null;
        const zoneLow = lo.zoneLow || iz.zoneLow || iz.low;
        const zoneHigh = lo.zoneHigh || iz.zoneHigh || iz.high;

        const fmtTime = (iso: string | undefined) => {
          if (!iso) return null;
          try {
            return new Date(iso).toLocaleTimeString("en-US", {
              month: "2-digit", day: "2-digit",
              hour: "2-digit", minute: "2-digit", second: "2-digit",
              hour12: true,
            });
          } catch { return null; }
        };

        const zoneTouchTime = fmtTime(conf.zoneTouchTime || lo.zoneTouchTime);
        const filledAt = fmtTime(lo.filledAt);
        const placedAt = fmtTime(lo.placedAt);

        return (
          <div className="rounded-lg border border-border/40 bg-secondary/30 px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-muted-foreground">Entry Confirmation</span>
              {isConfirmedEntry && conf.tier && (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold border ${tierColors[conf.tier] || tierColors[3]}`}>
                  T{conf.tier}
                </span>
              )}
              {isMarketFillAtZone && !isConfirmedEntry && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/15 border border-amber-500/40 text-amber-400">
                  Market Fill at Zone
                </span>
              )}
              {sr.filledFromLimitOrder && !isConfirmedEntry && !isMarketFillAtZone && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-500/15 border border-blue-500/40 text-blue-400">
                  Limit Order Fill
                </span>
              )}
              {/* Confirmation method badge — only show when non-default */}
              {sr.confirmationMethod && sr.confirmationMethod !== "choch" && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-violet-500/15 border border-violet-500/40 text-violet-400">
                  {sr.confirmationMethod === "indicators" ? `Indicator Consensus` : `CHoCH + Indicators`}
                </span>
              )}
            </div>

            {/* Confirmation signal details */}
            {isConfirmedEntry && (
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] font-mono">
                <span className="text-muted-foreground">Signal: <span className="text-foreground font-semibold">{confirmLabel}</span></span>
                {conf.displacement != null && (
                  <span className="text-muted-foreground">Disp: <span className={`font-semibold ${conf.displacement >= 1.5 ? "text-success" : conf.displacement >= 1.0 ? "text-foreground" : "text-warn"}`}>{conf.displacement.toFixed(2)}\u00d7</span></span>
                )}
                {conf.significance && (
                  <span className="text-muted-foreground">Strength: <span className={`font-semibold ${conf.significance === "high" ? "text-success" : conf.significance === "medium" ? "text-foreground" : "text-muted-foreground"}`}>{conf.significance}</span></span>
                )}
                {conf.closeBased != null && (
                  <span className="text-muted-foreground">{conf.closeBased ? "Close-based \u2713" : "Wick-based"}</span>
                )}
              </div>
            )}

            {/* Supporting signals */}
            {isConfirmedEntry && Array.isArray(conf.supportingSignals) && conf.supportingSignals.length > 0 && (
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
                  <span className="text-muted-foreground">[{formatPrice(zoneLow, p.symbol)} \u2013 {formatPrice(zoneHigh, p.symbol)}]</span>
                )}
              </div>
            )}

            {/* Timeline: placed → zone touched → confirmed → filled */}
            {(placedAt || zoneTouchTime || filledAt) && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                {placedAt && <span>Placed: {placedAt}</span>}
                {zoneTouchTime && <span>Zone touch: {zoneTouchTime}</span>}
                {conf.confirmationAttempts != null && conf.confirmationAttempts > 0 && (
                  <span>Attempts: {conf.confirmationAttempts}</span>
                )}
                {filledAt && <span>Filled: {filledAt}</span>}
              </div>
            )}

            {/* Watchlist origin (compact — header already shows badge) */}
            {hasWatchlistOrigin && (
              <div className="flex items-center gap-2 text-[10px] text-cyan-400/80">
                <span>Watched {sr.watchlistOrigin.cyclesWatched} cycles</span>
                {sr.watchlistOrigin.initialScore != null && (
                  <span>\u00b7 Started at {sr.watchlistOrigin.initialScore.toFixed(1)}%</span>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ ROW 2: Live Trade Management Status (3 cards) ═══ */}
      {hasManagement && (
        <div className="flex gap-2">
          {(ef.trailingStopEnabled || ef.trailingStop) && (
            <ManagementCard
              title="TRAILING STOP"
              active={!!ef.trailingStopActivated}
              borderColor="border-l-emerald-500"
              badgeColor={ef.trailingStopActivated
                ? "bg-badge-profit text-profit"
                : "bg-badge-warn text-highlight"
              }
              lines={ef.trailingStopActivated
                ? [
                    sl != null ? `SL: ${formatPrice(sl, p.symbol)}` : "Active",
                    lockedR != null
                      ? (lockedR >= 0
                          ? `${lockedR.toFixed(2)}R locked${lockedPnl != null ? ` (${formatMoney(lockedPnl, true)})` : ""}`
                          : `Risk → ${lockedR.toFixed(2)}R${lockedPnl != null ? ` (${formatMoney(lockedPnl, true)})` : ""}`)
                      : "",
                  ].filter(Boolean)
                : [
                    trailActivationPips != null
                      ? `Activates at ${trailActivationR}R (${fmtPipsDollar(trailActivationPips, trailActivationDollar)})`
                      : (ef.trailingStopActivation
                        ? `Triggers ${ef.trailingStopActivation}`
                        : `${ef.trailingStopPips ?? "?"}p step`),
                    trailDistPips != null
                      ? `Trail: ${trailDistPips}p behind price${riskPips ? ` (${(trailDistPips / riskPips).toFixed(1)}× SL)` : ""}`
                      : "",
                  ].filter(Boolean)
              }
            />
          )}

          {(ef.breakEvenEnabled || ef.breakEven) && (
            <ManagementCard
              title="BREAK EVEN"
              active={!!ef.breakEvenActivated}
              borderColor="border-l-yellow-500"
              badgeColor={ef.breakEvenActivated
                ? "bg-badge-profit text-profit"
                : "bg-badge-warn text-highlight"
              }
              lines={ef.breakEvenActivated
                ? [`SL moved to entry (${formatPrice(entry, p.symbol)})`]
                : [
                    bePrice != null
                      ? `Trigger: ${beR?.toFixed(1)}R (${fmtPipsDollar(beTriggerPips, beTriggerDollar)})`
                      : `${ef.breakEvenPips} pips from entry`,
                    bePrice != null
                      ? `SL → ${formatPrice(entry, p.symbol)} at ${formatPrice(bePrice, p.symbol)}`
                      : "",
                  ].filter(Boolean)
              }
            />
          )}

          {(ef.partialTPEnabled || ef.partialTP) && (
            <ManagementCard
              title="PARTIAL TP"
              active={!!ef.partialTPActivated || !!p.partialTpFired}
              borderColor="border-l-cyan-500"
              badgeColor={(ef.partialTPActivated || p.partialTpFired)
                ? "bg-badge-profit text-profit"
                : "bg-badge-warn text-highlight"
              }
              lines={(ef.partialTPActivated || p.partialTpFired)
                ? [`${ef.partialTPPercent ?? 50}% closed at ${partialR ?? "?"}R`]
                : [
                    partialTriggerPips != null
                      ? `Close ${ef.partialTPPercent ?? 50}% at ${partialR}R (${fmtPipsDollar(partialTriggerPips, partialTriggerDollar)})`
                      : `${ef.partialTPPercent ?? 50}% @ ${partialR != null ? `${partialR}R` : `${ef.partialTPLevel ?? "?"}R`}`,
                    partialPrice != null
                      ? `Target: ${formatPrice(partialPrice, p.symbol)}`
                      : "",
                  ].filter(Boolean)
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
              {factorCount != null ? `${factorCount} factors${factorTotal ? ` (of ${factorTotal})` : ""}` : ""}
              {summaryScore != null ? ` \u00B7 score ${summaryScore > 10 ? `${summaryScore.toFixed(1)}%` : `${summaryScore}/10`}` : ""}
            </span>
          </div>
          {sr.tieredScoring && <div className="mt-1"><TierScoreSummary tieredScoring={sr.tieredScoring} /></div>}
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

      {/* ═══ ROW 4: Factor Breakdown (Tier-Grouped or Legacy Pills) ═══ */}
      {Array.isArray(sr.factorScores) && sr.factorScores.length > 0 ? (
        <TierFactorBreakdown factors={sr.factorScores} tieredScoring={sr.tieredScoring ?? null} compact />
      ) : alignedFactors.length > 0 ? (
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
      ) : null}

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

      {/* ═══ ROW 7: Per-Trade Management Overrides ═══ */}
      <TradeOverrideEditor position={p} onSaved={onSaved} />
    </div>
  );
}

export default ExpandedPositionCard;
