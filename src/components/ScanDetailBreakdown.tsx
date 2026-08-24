/* eslint-disable @typescript-eslint/no-explicit-any -- Scan-log payloads are untyped at this UI boundary. */
import { useEffect, useState } from "react";
import { Minus, ShieldX, TrendingDown, TrendingUp } from "lucide-react";

import { LegacyDiagnosticsPanel } from "@/components/LegacyDiagnosticsPanel";
import { ZoneStoryPanel } from "@/components/ZoneStoryPanel";
import { formatNewsGateCountdown } from "@/lib/newsGateCountdown";
import { generateDetailNarrative, generateTradeEntryNarrative } from "@/lib/narrative";
import { uniqueRejectionReasons } from "@/lib/rejectedSetupAnalytics";

export function TradeDecisionPanel({ detail }: { detail: any }) {
  const decision = detail?.singleOwnershipDecision;
  const enforcement = detail?.singleOwnershipEnforcement;
  const workflow = detail?.canonicalScannerState;
  const workflowEnforcement = detail?.canonicalScannerEnforcement;
  const presentation = detail?.tradeDecisionPresentation;
  const sequenceObservation = detail?.liquidityConfirmationObservation;
  if (!decision && !enforcement && !workflow) return null;
  const outcome = String(workflow?.stage || decision?.decision || "unavailable").replace(/_/g, " ").toUpperCase();
  const outcomeColor = ["AUTHORIZED", "ENTERED", "MANAGING", "ALLOW"].includes(outcome) ? "text-success"
    : outcome.includes("AWAITING") || ["WATCHING", "AT POI", "WATCH"].includes(outcome) ? "text-warning" : "text-destructive";
  const primaryExplanation = presentation?.primary?.explanation || workflow?.explanation || null;
  const diagnostics = Array.isArray(presentation?.diagnostics) ? presentation.diagnostics : [];
  const failedCheck = Array.isArray(presentation?.authorityChecks)
    ? presentation.authorityChecks.find((check: any) => check.passed === false || check.passed == null)
    : null;
  const nextRequirement = presentation?.primary?.nextRequirement
    || workflow?.nextRequirement
    || failedCheck?.reason
    || (failedCheck?.role ? `Complete ${String(failedCheck.role).replace(/_/g, " ")}.` : null);
  return (
    <section className="border border-border/70 bg-card" aria-label="Trade decision summary">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <div>
          <p className="text-xs font-semibold">Trade Decision</p>
          <p className="text-[11px] text-muted-foreground">ICT Scanner Workflow · current canonical authority</p>
        </div>
        <span className={"text-xs font-mono font-bold " + outcomeColor}>{outcome}</span>
      </div>
      <div className="space-y-2 px-3 py-2 text-xs">
        {primaryExplanation ? <p className={outcomeColor}>{primaryExplanation}</p> : <p className="text-muted-foreground">No canonical scanner explanation recorded.</p>}
        {nextRequirement && !["AUTHORIZED", "ENTERED", "MANAGING", "ALLOW"].includes(outcome) && (
          <div className="border-l-2 border-warning pl-2">
            <p className="text-[11px] font-semibold text-warning">Next required</p>
            <p className="text-[11px] text-foreground/90">{nextRequirement}</p>
          </div>
        )}
        {sequenceObservation && (
          <div className="border-l-2 border-cyan-500 pl-2 text-[11px]">
            <span className="font-semibold text-cyan-400">Sequence observation: </span>
            <span className={sequenceObservation.ready ? "text-success" : "text-warning"}>
              {String(sequenceObservation.reasonCode || "unavailable").replace(/_/g, " ")}
            </span>
          </div>
        )}
        <p className="text-muted-foreground">
          Workflow: <span className="font-mono text-foreground">{String(workflowEnforcement?.effectiveMode || "observe").toUpperCase()}</span>
          {" · Trade Decision: "}<span className="font-mono text-foreground">{String(enforcement?.effectiveMode || "observe").toUpperCase()}</span>
        </p>
        {primaryExplanation ? <p className={outcomeColor}>{primaryExplanation}</p> : <p className="text-muted-foreground">No canonical scanner explanation recorded.</p>}
        {Array.isArray(presentation?.authorityChecks) && presentation.authorityChecks.length > 0 && (
          <div className="grid grid-cols-2 gap-1 border-t border-border/40 pt-2 sm:grid-cols-4">
            {presentation.authorityChecks.map((check: any) => (
              <div key={check.role} className="flex items-center justify-between gap-1 border border-border/40 px-1.5 py-1">
                <span className="min-w-0 break-words text-muted-foreground">{String(check.role).replace(/_/g, " ")}</span>
                <span className={check.passed === true ? "text-success" : check.passed === false ? "text-destructive" : "text-warning"}>{check.passed === true ? "PASS" : check.passed === false ? "BLOCK" : "WAIT"}</span>
              </div>
            ))}
          </div>
        )}
        {diagnostics.length > 0 && (
          <details className="border-t border-border/40 pt-2">
            <summary className="cursor-pointer text-muted-foreground">Diagnostic scores and legacy checks ({diagnostics.length})</summary>
            <div className="mt-1 space-y-1">
              {diagnostics.map((item: any, index: number) => <p key={`${item.code}-${index}`} className="text-muted-foreground">{item.reason || String(item.code).replace(/_/g, " ")}</p>)}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

export function ScanDetailBreakdown({ signal: d, observedAt }: { signal: any; observedAt?: string | null }) {
  const [newsClock, setNewsClock] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNewsClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const statusLabel = d.status === "limit_order_from_watchlist" || d.status === "zone_setup_from_watchlist" ? "🔍📋 ZONE+WL" : d.status === "limit_order_placed" || d.status === "zone_setup_active" ? "🔍 ZONE SETUP" : d.status === "trade_placed_from_watchlist" ? "📋 WATCHLIST" : d.status === "trade_placed_at_zone" ? "✅ PLACED@ZONE" : d.status === "trade_placed" ? "✅ PLACED" : d.status === "waiting_for_sweep" ? "⏳ SWEEP WAIT" : d.status === "waiting_for_reconfirmation" ? "⏳ RECONFIRM" : d.status === "watching_zone" ? "⏳ WATCHING" : d.status === "watchlist_persistence_failed" ? "⚠ WATCHLIST ERROR" : d.status === "waiting_zone_untracked" ? "ZONE AWAY" : d.status === "paused" ? "⏸ PAUSED" : d.status === "no_direction" ? "— NO DIR" : d.status === "rejected" ? "REJECTED" : d.status === "below_threshold" ? "SKIP" : d.status?.startsWith("skipped_") ? "SKIPPED" : d.status?.startsWith("staged_") ? "⏳ STAGED" : d.status?.toUpperCase() || "—";
  const statusColor = d.status === "limit_order_from_watchlist" || d.status === "zone_setup_from_watchlist" ? "text-tier3" : d.status === "limit_order_placed" || d.status === "zone_setup_active" ? "text-info-c" : d.status === "trade_placed_from_watchlist" ? "text-cyan-400" : d.status?.startsWith("trade_placed") ? "text-success" : d.status === "rejected" || d.status === "watchlist_persistence_failed" ? "text-destructive" : d.status === "waiting_for_sweep" ? "text-purple-400" : d.status === "waiting_for_reconfirmation" ? "text-orange-400" : d.status === "paused" || d.status === "no_direction" ? "text-zinc-400" : "text-muted-foreground";

  // Only show failed gates
  const failedGates = d.gates?.filter((g: any) => !g.passed) || [];
  const visibleRejectionReasons = uniqueRejectionReasons(d.gates, d.rejectionReasons);

  return (
    <div className="space-y-2">
      {/* 1. Header — Pair + Status + Score + Signal Source */}
      <div className="flex items-center gap-2">
        {d.direction === "long" ? <TrendingUp className="h-3 w-3 text-success" /> : d.direction === "short" ? <TrendingDown className="h-3 w-3 text-destructive" /> : <Minus className="h-3 w-3 text-muted-foreground" />}
        <span className="text-[12px] font-bold">{d.pair}</span>
        {d.signalSource && (d.status === "trade_placed" || d.status === "trade_placed_from_watchlist" || d.status === "trade_placed_at_zone") && (
          <span className={`text-[9px] font-mono font-bold px-1 py-0.5 rounded ${
            d.signalSource === "unified" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" :
            d.signalSource === "cascade" ? "bg-purple-500/15 text-purple-400 border border-purple-500/30" :
            "bg-orange-500/15 text-orange-400 border border-orange-500/30"
          }`}>
            {d.signalSource === "unified" ? "UNIFIED ×1" : d.signalSource === "cascade" ? "CASCADE ×1" : "STANDALONE ×0.5"}
          </span>
        )}
        <span className={`text-[12px] font-bold ${statusColor}`}>{statusLabel}</span>
      </div>

      {/* Signal source context note for standalone */}
      {d.signalSource && d.signalSource !== "unified" && d.signalSource !== "cascade" && (d.status === "trade_placed" || d.status === "trade_placed_from_watchlist" || d.status === "trade_placed_at_zone") && (
        <div className="text-[9px] px-2 py-1 rounded bg-orange-500/10 border border-orange-500/20 text-orange-300">
          Entry via <span className="font-bold">standalone impulse zone</span> — unified confirmation not met. Position size halved (×0.5).
        </div>
      )}

      <TradeDecisionPanel detail={d} />

      {/* 3. Narrative — plain-English thesis */}
      {d.direction && d.direction !== "none" && (
        <p className="text-[11px] text-muted-foreground/80 italic leading-tight">
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
            limitOrder: d.limitOrder ? { entry_price: d.limitOrder.entryPrice, zone_type: d.limitOrder.zoneType } : undefined,
          })}
        </p>
      )}

      {/* 4. Zone Story — consolidated impulse + unified zone narrative */}
      <ZoneStoryPanel
        unifiedData={d.unifiedZone}
        gateData={d.impulseZone}
        zoneLocalEnforcement={d.zoneLocalEnforcement}
        isLiveContext
        symbol={d.pair}
        direction={d.direction}
        timeframeEvidenceId={d.timeframeEvidenceId}
        frozenCrossTimeframeContext={d.frozenCrossTimeframeContext}
        frozenExecutablePlan={d.frozenExecutablePlan}
      />
      {/* Direction Verdict */}
      {d.directionVerdict && !d.directionVerdict.error && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm ${
            d.directionVerdict.verdict === "long" ? "bg-success/15 text-success border border-success/30" :
            d.directionVerdict.verdict === "short" ? "bg-destructive/15 text-destructive border border-destructive/30" :
            "bg-muted/30 text-muted-foreground border border-border"
          }`}>
            {d.directionVerdict.verdict === "long" ? "↑ LONG" : d.directionVerdict.verdict === "short" ? "↓ SHORT" : "— NEUTRAL"}
          </span>
          <span className="text-[10px] font-mono font-bold">{d.directionVerdict.confidence}%</span>
          <span className="text-[9px] text-muted-foreground">{Math.round(d.directionVerdict.agreement * 100)}% agree</span>
          {d.directionVerdict.shouldBlock && (
            <span className="text-[9px] font-bold text-destructive bg-destructive/10 px-1 rounded">BLOCKED</span>
          )}
          {d.directionVerdict.scoreAdjustment !== 0 && (
            <span className={`text-[9px] font-mono ${d.directionVerdict.scoreAdjustment > 0 ? "text-success" : "text-destructive"}`}>
              adj: {d.directionVerdict.scoreAdjustment > 0 ? "+" : ""}{d.directionVerdict.scoreAdjustment.toFixed(2)}
            </span>
          )}
        </div>
      )}

      <LegacyDiagnosticsPanel
        score={d.score}
        factorCount={d.factorCount}
        factors={d.factors}
        tieredScoring={d.tieredScoring}
        gates={d.gates}
        ownershipDiagnostics={d.legacyGateDiagnostics}
        compact
      />

      {/* 6. Regime Detection */}
      {d.regimeData && (
        <div className="rounded border border-violet-500/30 bg-badge-info px-2 py-1.5 space-y-1">
          <p className="text-[11px] text-tier3 uppercase tracking-wider font-bold">Regime Detection</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {/* Daily Regime */}
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Daily:</span>
              <span className={`text-[11px] font-bold ${
                d.regimeData.daily?.regime?.includes("trend") ? "text-profit"
                : d.regimeData.daily?.regime?.includes("range") ? "text-warn"
                : "text-highlight"
              }`}>
                {(d.regimeData.daily?.regime || "—").replace(/_/g, " ")}
              </span>
              <span className="text-[11px] text-muted-foreground">
                ({Math.round((d.regimeData.daily?.confidence || 0) * 100)}%)
              </span>
              {d.regimeData.daily?.bias && d.regimeData.daily.bias !== "neutral" && (
                <span className={`text-[11px] ${d.regimeData.daily.bias === "bullish" ? "text-success" : "text-destructive"}`}>
                  {d.regimeData.daily.bias === "bullish" ? "↑" : "↓"}
                </span>
              )}
            </div>
            {/* 4H Regime */}
            {d.regimeData.h4 && (
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">4H:</span>
                <span className={`text-[11px] font-bold ${
                  d.regimeData.h4.regime?.includes("trend") ? "text-profit"
                  : d.regimeData.h4.regime?.includes("range") ? "text-warn"
                  : "text-highlight"
                }`}>
                  {(d.regimeData.h4.regime || "—").replace(/_/g, " ")}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  ({Math.round((d.regimeData.h4.confidence || 0) * 100)}%)
                </span>
                {d.regimeData.h4.bias && d.regimeData.h4.bias !== "neutral" && (
                  <span className={`text-[11px] ${d.regimeData.h4.bias === "bullish" ? "text-success" : "text-destructive"}`}>
                    {d.regimeData.h4.bias === "bullish" ? "↑" : "↓"}
                  </span>
                )}
              </div>
            )}
            {/* Multi-TF Alignment */}
            {d.regimeData.multiTFAlignment && d.regimeData.multiTFAlignment !== "mixed" && (
              <div className="flex items-center gap-1">
                <span className={`text-[11px] font-bold px-1 py-0.5 rounded ${
                  d.regimeData.multiTFAlignment === "agree" ? "bg-badge-profit text-profit"
                  : d.regimeData.multiTFAlignment === "disagree" ? "bg-badge-loss text-loss"
                  : "bg-badge-warn text-highlight"
                }`}>
                  {d.regimeData.multiTFAlignment === "agree" ? "TF ✓ AGREE"
                    : d.regimeData.multiTFAlignment === "disagree" ? "TF ✗ DISAGREE"
                    : "TF ~ MIXED"}
                </span>
              </div>
            )}
          </div>
          {/* Transition State */}
          {d.regimeData.daily?.transition && d.regimeData.daily.transition.state !== "stable" && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className={`text-[11px] font-bold px-1 py-0.5 rounded ${
                d.regimeData.daily.transition.state === "range_to_trending" ? "bg-badge-profit text-profit"
                : d.regimeData.daily.transition.state === "accelerating" ? "bg-badge-info text-info-c"
                : d.regimeData.daily.transition.state === "trending_to_range" ? "bg-badge-warn text-warn"
                : d.regimeData.daily.transition.state === "decelerating" ? "bg-badge-loss text-loss"
                : "bg-muted text-muted-foreground"
              }`}>
                {d.regimeData.daily.transition.state === "range_to_trending" ? "⚡ RANGE → TREND"
                  : d.regimeData.daily.transition.state === "accelerating" ? "🚀 ACCELERATING"
                  : d.regimeData.daily.transition.state === "trending_to_range" ? "⏸ TREND → RANGE"
                  : d.regimeData.daily.transition.state === "decelerating" ? "📉 DECELERATING"
                  : d.regimeData.daily.transition.state.replace(/_/g, " ").toUpperCase()}
              </span>
              <span className="text-[11px] text-muted-foreground">
                ({Math.round(d.regimeData.daily.transition.confidence * 100)}% conf, momentum {d.regimeData.daily.transition.momentum > 0 ? "+" : ""}{d.regimeData.daily.transition.momentum.toFixed(3)}/candle)
              </span>
            </div>
          )}
          {/* 4H Transition */}
          {d.regimeData.h4?.transition && d.regimeData.h4.transition.state !== "stable" && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">4H:</span>
              <span className={`text-[11px] font-bold px-1 py-0.5 rounded ${
                d.regimeData.h4.transition.state.includes("trending") || d.regimeData.h4.transition.state === "accelerating" ? "bg-badge-profit text-profit"
                : "bg-badge-warn text-warn"
              }`}>
                {d.regimeData.h4.transition.state.replace(/_/g, " ")}
              </span>
              <span className="text-[11px] text-muted-foreground">
                (mom: {d.regimeData.h4.transition.momentum > 0 ? "+" : ""}{d.regimeData.h4.transition.momentum.toFixed(3)})
              </span>
            </div>
          )}
        </div>
      )}

      {/* 7. Failed Gates Only */}
      {d.gates && (
        <div className="space-y-0.5">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-bold">
            {failedGates.length > 0 ? `Failed Gates (${failedGates.length})` : "✓ All gates passed"}
          </p>
          {failedGates.map((g: any, gi: number) => (
            <div key={gi} className="flex items-center gap-1 text-[11px] text-destructive">
              <span><ShieldX className="h-2.5 w-2.5" /></span>
              <span>{formatNewsGateCountdown(g.reason, newsClock, observedAt)}</span>
            </div>
          ))}
        </div>
      )}

      {/* 8. Rejection Reasons (conditional) */}
      {visibleRejectionReasons.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[11px] text-destructive uppercase tracking-wider font-bold">Rejection Reasons</p>
          {visibleRejectionReasons.map((r: string, ri: number) => (
            <p key={ri} className="text-[11px] text-destructive">⚠ {formatNewsGateCountdown(r, newsClock, observedAt)}</p>
          ))}
        </div>
      )}

      {/* 9. Structure Intelligence — compact */}
      {d.structureIntel && (
        <div className="rounded border border-violet-500/30 bg-badge-info px-2 py-1.5 space-y-1">
          <p className="text-[11px] uppercase tracking-wider font-bold text-tier3">Structure Intelligence</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Internal BOS:</span>
              <span className="text-[11px] font-mono text-foreground">{d.structureIntel.counts?.internalBOS ?? 0}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">External BOS:</span>
              <span className="text-[11px] font-mono text-foreground">{d.structureIntel.counts?.externalBOS ?? 0}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Internal CHoCH:</span>
              <span className="text-[11px] font-mono text-foreground">{d.structureIntel.counts?.internalCHoCH ?? 0}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">External CHoCH:</span>
              <span className="text-[11px] font-mono text-foreground">{d.structureIntel.counts?.externalCHoCH ?? 0}</span>
            </div>
          </div>
          {/* S2F Rate */}
          {d.structureIntel.s2f && (
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-muted-foreground">S2F Rate:</span>
              <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${
                d.structureIntel.s2f.overallRate > 0.4 ? "bg-badge-profit text-profit"
                : d.structureIntel.s2f.overallRate > 0.2 ? "bg-badge-warn text-warn"
                : "bg-badge-loss text-loss"
              }`}>
                {(d.structureIntel.s2f.overallRate * 100).toFixed(0)}%
              </span>
              <span className="text-[11px] text-muted-foreground">
                ({d.structureIntel.s2f.totalFractals} fractals | Bull {(d.structureIntel.s2f.bullishRate * 100).toFixed(0)}% / Bear {(d.structureIntel.s2f.bearishRate * 100).toFixed(0)}%)
              </span>
            </div>
          )}
          {/* Active S/R only */}
          {d.structureIntel.derivedSR?.active?.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-0.5">
              <span className="text-[11px] text-profit font-semibold">Active S/R:</span>
              {d.structureIntel.derivedSR.active.map((sr: any, i: number) => (
                <span key={i} className={`text-[11px] font-mono px-1 py-0.5 rounded ${
                  sr.type === "support" ? "bg-badge-profit text-profit" : "bg-badge-loss text-loss"
                }`}>
                  {sr.type === "support" ? "S" : "R"} {sr.price?.toFixed(sr.price > 10 ? 3 : 5)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Trade Entry Thesis — shown for placed trades */}
      {(d.status === "trade_placed" || d.status === "trade_placed_from_watchlist") && d.factors && (
        <div className="rounded border border-success/30 bg-success/5 px-2 py-1">
          <p className="text-[11px] text-success/90 leading-tight">
            {generateTradeEntryNarrative({
              pair: d.pair,
              direction: d.direction,
              score: d.score,
              factors: d.factors,
              tieredScoring: d.tieredScoring,
              regimeData: d.regimeData,
              staging: d.staging,
              limitOrder: d.limitOrder ? { entry_price: d.limitOrder.entryPrice, zone_type: d.limitOrder.zoneType } : undefined,
            })}
          </p>
        </div>
      )}

      {/* Watchlist Origin Banner */}
      {d.staging?.action === "promoted_and_traded" && (
        <div className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1.5">
          <p className="text-[11px] text-cyan-400 uppercase tracking-wider font-bold">📋 Promoted from Watchlist</p>
          <p className="mt-1 text-[12px] text-cyan-300">
            Watched for {d.staging.cycles} cycle{d.staging.cycles !== 1 ? "s" : ""} · Started at {d.staging.initialScore?.toFixed(1)}% → {d.score?.toFixed(1)}%
          </p>
        </div>
      )}

      {/* Zone Setup Banner */}
      {d.limitOrder && (
        <div className="rounded border border-blue-500/30 bg-badge-info px-2 py-1.5">
          <p className="text-[11px] text-info-c uppercase tracking-wider font-bold">🔍 Zone Setup Active</p>
          <p className="mt-1 text-[12px] text-info-c">
            Trigger: {Number(d.limitOrder.entryPrice).toFixed(5)} ({d.limitOrder.zoneType} zone) · {d.limitOrder.distancePips} pips from current
          </p>
          <p className="text-[12px] text-info-c/70">
            Zone: [{Number(d.limitOrder.zoneLow).toFixed(5)} – {Number(d.limitOrder.zoneHigh).toFixed(5)}] · Expires: {new Date(d.limitOrder.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
          <p className="text-[10px] text-warn/80 mt-1 italic">
            Will hunt for 5m CHoCH confirmation when price reaches zone
          </p>
        </div>
      )}
    </div>
  );
}
