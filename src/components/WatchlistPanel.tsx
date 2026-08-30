import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OverflowText } from "@/components/ui/overflow-text";
import { scannerApi, type StagedSetup } from "@/lib/api";
import {
  getStagedLifecyclePhaseLabel,
  getStagedLifecycleStatusText,
  getWatchlistDisplay,
} from "@/lib/featureState";
import { formatPrice, formatPct } from "@/lib/formatTime";
import { toast } from "sonner";
import {
  Eye, EyeOff, TrendingUp, TrendingDown, X, Clock,
  ChevronDown, ChevronUp, Loader2, Target, ShieldX,
  Zap, RefreshCw,
} from "lucide-react";

// ── Time helpers ──
function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ${min % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ttlRemaining(stagedAt: string, ttlMinutes: number): { text: string; pct: number; urgent: boolean } {
  const elapsed = (Date.now() - new Date(stagedAt).getTime()) / 60_000;
  const remaining = Math.max(0, ttlMinutes - elapsed);
  const pct = Math.max(0, Math.min(100, (remaining / ttlMinutes) * 100));
  if (remaining <= 0) return { text: "Expired", pct: 0, urgent: true };
  if (remaining < 15) return { text: `${Math.ceil(remaining)}m left`, pct, urgent: true };
  if (remaining < 60) return { text: `${Math.ceil(remaining)}m left`, pct, urgent: false };
  const hrs = Math.floor(remaining / 60);
  const mins = Math.ceil(remaining % 60);
  return { text: `${hrs}h ${mins}m left`, pct, urgent: false };
}

function displayResolutionReason(reason: string | null | undefined): string {
  if (!reason) return "";
  return reason.replace(
    /^SL level breached/,
    "Legacy protection level breached before entry",
  );
}

const LIFECYCLE_REASON_LABELS: Record<string, string> = {
  structural_boundary_breached: "STRUCTURE BROKEN",
  structural_boundary_repaired: "BOUNDARY REPAIRED",
  ttl_expired: "TIME WINDOW EXPIRED",
  manual_dismissal: "DISMISSED",
  pre_zone_handoff: "FRESH ZONE HANDOFF",
  pre_zone_quality_lost: "PRE-ZONE QUALITY LOST",
  qualified: "QUALIFIED",
  blocked_after_qualification: "BLOCKED AFTER QUALIFICATION",
  fresh_direction_disagreement_retained: "DIRECTION DISAGREEMENT — RETAINED",
  fresh_score_below_watch_threshold_retained: "SCORE DROP — RETAINED",
  waiting_for_local_sweep: "WAITING FOR LOCAL SWEEP",
  waiting_for_reconfirmation: "WAITING FOR RECONFIRMATION",
  waiting_for_zone_confirmation: "WAITING FOR ZONE CONFIRMATION",
  monitoring_pre_zone: "MONITORING — NO FROZEN ZONE",
  entry_authorized: "ENTRY AUTHORIZED",
  position_managing: "POSITION MANAGING",
  legacy_transition: "LEGACY RECORD",
};

function lifecycleReasonLabel(code: string | null | undefined): string {
  if (!code) return "UNCLASSIFIED";
  return LIFECYCLE_REASON_LABELS[code] ||
    code.replace(/_/g, " ").toUpperCase();
}

function formatEvidencePrice(value: unknown, symbol: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return formatPrice(parsed, symbol);
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function LifecycleEvidenceSummary({
  symbol,
  evidence,
}: {
  symbol: string;
  evidence: StagedSetup["lifecycle_evidence"];
}) {
  if (!evidence) return null;
  const boundary = evidence.boundary;
  const zone = boundary?.zone;
  const sweep = evidence.sweep || null;
  const sweepReason = sweep && typeof sweep.gateReason === "string"
    ? sweep.gateReason
    : null;
  const milestones = Array.isArray(evidence.milestones)
    ? evidence.milestones
    : [];

  return (
    <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-foreground/60">
      {milestones.length > 0 && (
        <span className="sm:col-span-2">
          Observed chain:{" "}
          {milestones.map(getStagedLifecyclePhaseLabel).join(" → ")}
        </span>
      )}
      {evidence.observedPrice != null && (
        <span>Observed price: <strong className="font-mono text-foreground/80">{formatEvidencePrice(evidence.observedPrice, symbol)}</strong></span>
      )}
      {boundary?.level != null && (
        <span>Boundary: <strong className="font-mono text-destructive">{formatEvidencePrice(boundary.level, symbol)}</strong></span>
      )}
      {zone?.low != null && zone?.high != null && (
        <span>
          Frozen zone:{" "}
          <strong className="font-mono text-foreground/80">
            {formatEvidencePrice(zone.low, symbol)}–{formatEvidencePrice(zone.high, symbol)}
          </strong>
        </span>
      )}
      {boundary?.bufferPrice != null && (
        <span>Boundary buffer: <strong className="font-mono text-foreground/80">{formatEvidencePrice(boundary.bufferPrice, symbol)}</strong></span>
      )}
      {evidence.frozenDirection && (
        <span>
          Frozen direction:{" "}
          <strong className="uppercase text-foreground/80">
            {evidence.frozenDirection}
          </strong>
          {evidence.freshDirection &&
            evidence.freshDirection !== evidence.frozenDirection &&
            ` · fresh scan ${evidence.freshDirection.toUpperCase()}`}
        </span>
      )}
      {evidence.score != null && (
        <span>
          Fresh score: <strong>{formatPct(finiteNumber(evidence.score))}</strong>
          {evidence.threshold != null &&
            ` · threshold ${formatPct(finiteNumber(evidence.threshold))}`}
        </span>
      )}
      {sweepReason && (
        <span className="sm:col-span-2">Liquidity: {sweepReason}</span>
      )}
    </div>
  );
}

function ImpulseEntryLifecycleSummary({
  symbol,
  lifecycle,
}: {
  symbol: string;
  lifecycle: StagedSetup["impulse_entry_lifecycle"];
}) {
  if (!lifecycle || lifecycle.mode === "off") return null;
  const active = lifecycle.candidates.find((candidate) =>
    candidate.id === lifecycle.activeCandidateId
  );
  const deeper = lifecycle.candidates.filter((candidate) =>
    candidate.state === "queued"
  ).length;
  return (
    <div className="mt-1 border-t border-border/30 pt-1 text-[10px] text-foreground/65">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Badge variant="outline" className="h-4 px-1 text-[8px] border-cyan-500/30 text-cyan-400">
          IMPULSE PATH · {lifecycle.mode.toUpperCase()}
        </Badge>
        <span>{lifecycle.impulse.timeframe} impulse</span>
        <span>Protected level <strong className="font-mono">{formatEvidencePrice(lifecycle.impulse.protectedLevel, symbol)}</strong></span>
      </div>
      {active ? (
        <div className="mt-0.5">
          Active {active.timeframe} {active.type.replace(/_/g, " + ").toUpperCase()} zone{" "}
          <strong className="font-mono">{formatEvidencePrice(active.low, symbol)}–{formatEvidencePrice(active.high, symbol)}</strong>
          {deeper > 0 && ` · ${deeper} deeper prequalified zone${deeper === 1 ? "" : "s"} queued`}
        </div>
      ) : (
        <div className="mt-0.5">{lifecycle.lastTransitionReason}</div>
      )}
    </div>
  );
}

// ── Factor pill ──
function FactorPill({ name, tier, present }: { name: string; tier?: string; present: boolean }) {
  const tierColor = tier === "T1" ? "border-warn/40 text-warn"
    : tier === "T2" ? "border-info-c/40 text-info-c"
    : "border-muted-foreground/30 text-muted-foreground";
  return (
    <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border ${present ? tierColor : "border-border/40 text-muted-foreground/40 line-through"}`}>
      {tier && <span className="mr-0.5 font-bold">{tier}</span>}
      {name}
    </span>
  );
}

// ── Single staged setup card ──
export function StagedSetupCard({
  setup,
  onDismiss,
  isDismissing = false,
  defaultExpanded = false,
}: {
  setup: StagedSetup;
  onDismiss?: (id: string) => void;
  isDismissing?: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const ttl = ttlRemaining(setup.staged_at, setup.ttl_minutes);
  const watchlistDisplay = getWatchlistDisplay(setup.execution_eligible);
  const monitoringOnly = watchlistDisplay.state === "monitoring";
  const lifecyclePhase = setup.lifecycle_phase || setup.lifecycle_evidence?.phase;
  const scannerState = setup.authorization_result?.canonicalScannerState ||
    setup.analysis_snapshot?.canonicalScannerState || null;
  const isNearZone = ["approaching_zone", "at_zone", "local_trigger_active", "local_trigger_swept", "sweep_rejected", "confirmation_ready"].includes(lifecyclePhase || "");
  const origin = asRecord(setup.originating_zone);
  const originBounds = asRecord(origin.bounds);
  const originGeometry = asRecord(origin.geometry);
  const evidenceZone = setup.lifecycle_evidence?.boundary?.zone;
  const frozenZoneLow = finiteNumber(originBounds.low) ??
    finiteNumber(origin.low) ??
    finiteNumber(evidenceZone?.low);
  const frozenZoneHigh = finiteNumber(originBounds.high) ??
    finiteNumber(origin.high) ??
    finiteNumber(evidenceZone?.high);
  const plannedEntry = finiteNumber(originGeometry.entry) ??
    finiteNumber(origin.entry);
  const stagedReference = finiteNumber(setup.entry_price);
  const structuralInvalidation = finiteNumber(
    originGeometry.structuralInvalidation,
  ) ?? finiteNumber(origin.structuralInvalidation) ?? finiteNumber(setup.sl_level);
  const plannedPositionStop = finiteNumber(originGeometry.positionStop) ??
    finiteNumber(origin.positionStop) ?? finiteNumber(origin.stopLoss);
  const projectedTarget = finiteNumber(originGeometry.target) ??
    finiteNumber(origin.target) ?? finiteNumber(origin.takeProfit) ??
    finiteNumber(setup.tp_level);
  const stagedReferenceDiffers = stagedReference != null &&
    plannedEntry != null && Math.abs(stagedReference - plannedEntry) > 1e-12;
  const currentScore = finiteNumber(setup.current_score);
  const initialScore = finiteNumber(setup.initial_score);
  const watchThreshold = finiteNumber(setup.watch_threshold);

  return (
    <div className={`border rounded-md p-2 transition-all ${
      monitoringOnly
        ? "border-info-c/35 bg-info-c/5"
        : isNearZone
        ? "border-warn/40 bg-badge-warn"
        : "border-border/60 bg-card/50"
    }`}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {setup.direction === "long"
            ? <TrendingUp className="h-3 w-3 shrink-0 text-success" />
            : <TrendingDown className="h-3 w-3 shrink-0 text-destructive" />
          }
          <span className="font-bold text-[13px] text-foreground">{setup.symbol}</span>
          <Badge variant="outline" className={`text-[9px] h-4 px-1.5 ${
            setup.direction === "long" ? "text-success border-success/30" : "text-destructive border-destructive/30"
          }`}>
            {setup.direction.toUpperCase()}
          </Badge>
          {setup.setup_type && (
            <OverflowText
              text={setup.setup_type.replace(/_/g, " ")}
              className="text-[12px] text-foreground/70"
            />
          )}
          {monitoringOnly && (
            <Badge
              variant="outline"
              className="text-[9px] h-4 px-1.5 border-info-c/40 text-info-c"
            >
              {watchlistDisplay.label}
            </Badge>
          )}
          {setup.status === "qualified" && (
            <Badge
              variant="outline"
              className="text-[9px] h-4 px-1.5 border-emerald-500/40 text-emerald-300"
            >
              QUALIFIED
            </Badge>
          )}
          {scannerState?.stage && (
            <Badge variant="outline" className="h-4 px-1.5 text-[9px] border-cyan-500/40 text-cyan-300">
              {String(scannerState.stage).replace(/_/g, " ").toUpperCase()}
            </Badge>
          )}
          {(setup.lifecycle_phase || setup.lifecycle_evidence?.phase) && (
            <Badge
              variant="outline"
              className="text-[9px] h-4 px-1.5 border-violet-500/40 text-violet-300"
            >
              {getStagedLifecyclePhaseLabel(
                setup.lifecycle_phase || setup.lifecycle_evidence?.phase,
              )}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-foreground/60">
            checked {timeAgo(setup.last_eval_at || setup.updated_at)}
          </span>
          {onDismiss && (
            <button
              onClick={() => onDismiss(setup.id)}
              disabled={isDismissing}
              className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Dismiss this setup"
            >
              {isDismissing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Frozen lifecycle authority */}
      {!monitoringOnly && (
        <div className="mt-1.5 rounded border border-border/40 bg-background/25 px-2 py-1.5 text-[10px] text-foreground/70">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            {frozenZoneLow != null && frozenZoneHigh != null && (
              <span>Frozen zone <strong className="font-mono text-foreground">{formatEvidencePrice(frozenZoneLow, setup.symbol)}–{formatEvidencePrice(frozenZoneHigh, setup.symbol)}</strong></span>
            )}
            {structuralInvalidation != null && (
              <span>Invalidation <strong className="font-mono text-destructive">{formatEvidencePrice(structuralInvalidation, setup.symbol)}</strong></span>
            )}
            {setup.lifecycle_evidence?.observedPrice != null && (
              <span>Last observed <strong className="font-mono text-foreground">{formatEvidencePrice(setup.lifecycle_evidence.observedPrice, setup.symbol)}</strong></span>
            )}
          </div>
        </div>
      )}

      {/* Meta row */}
      <div className="flex items-center justify-between mt-1.5 text-[11px] text-foreground/70">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-0.5">
            <RefreshCw className="h-3 w-3" /> Cycle {setup.scan_cycles}
          </span>
          <span className="flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            <span className={ttl.urgent ? "text-destructive font-medium" : ""}>{ttl.text}</span>
          </span>
        </div>
        <span>{timeAgo(setup.staged_at)}</span>
      </div>

      {/* TTL progress bar */}
      <div className="h-0.5 bg-muted/20 rounded-full mt-1 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${ttl.urgent ? "bg-destructive" : "bg-primary/40"}`}
          style={{ width: `${ttl.pct}%` }}
        />
      </div>



      {/* Narrative sentence */}
      <p className="text-[11px] text-foreground/70 italic mt-1.5 leading-tight">
        {scannerState?.explanation || (monitoringOnly
          ? setup.observation_reason || watchlistDisplay.description
          : getStagedLifecycleStatusText(setup))}
      </p>

      {/* Expand/collapse for factors */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-0.5 text-[11px] text-foreground/60 hover:text-foreground mt-1 transition-colors"
      >
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {expanded ? "Hide legacy diagnostics" : "Show legacy diagnostics"}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 border border-border/40 bg-background/30 p-1.5 text-[10px] text-foreground/65 sm:grid-cols-3">
            <span>Current <strong className="text-foreground/85">{formatPct(currentScore)}</strong></span>
            <span>Initial <strong className="text-foreground/85">{formatPct(initialScore)}</strong></span>
            <span>Watch floor <strong className="text-foreground/85">{formatPct(watchThreshold)}</strong></span>
            <span>Status <strong className="uppercase text-foreground/85">{setup.status.replace(/_/g, " ")}</strong></span>
            <span>Cycles <strong className="text-foreground/85">{setup.scan_cycles} / min {setup.min_cycles}</strong></span>
            <span>Execution <strong className={setup.execution_eligible ? "text-success" : "text-info-c"}>{setup.execution_eligible ? "eligible" : "monitoring only"}</strong></span>
          </div>
          <div className="border border-border/40 bg-background/30 p-1.5 text-[10px] font-mono text-foreground/65 space-y-0.5">
            <div>
              Candidate <span title={setup.candidate_id || undefined}>{setup.candidate_id?.slice(0, 8) || "legacy"}</span>
              {" · "}
              GP v{setup.game_plan_version?.slice(0, 8) || "none"}
              {" · "}
              DV {(setup.direction_verdict?.verdict || "missing").toUpperCase()}
            </div>
            <div>
              Thesis {setup.thesis_version || "legacy"}
              {" · "}
              Confirmation {(setup.confirmation_method || "legacy").replace(/_/g, " ")}
            </div>
            {setup.lifecycle_reason && (
              <div className="font-sans text-foreground/55">
                {setup.lifecycle_reason}
              </div>
            )}
            {setup.lifecycle_reason_code && (
              <div className="font-sans">
                <Badge variant="outline" className="text-[8px] h-4 px-1 border-cyan-500/30 text-cyan-400">
                  {lifecycleReasonLabel(setup.lifecycle_reason_code)}
                </Badge>
              </div>
            )}
            <LifecycleEvidenceSummary
              symbol={setup.symbol}
              evidence={setup.lifecycle_evidence}
            />
            <ImpulseEntryLifecycleSummary
              symbol={setup.symbol}
              lifecycle={setup.impulse_entry_lifecycle}
            />
            {setup.observation_parent_id && (
              <div className="font-sans text-foreground/55">
                Fresh candidate from observation{" "}
                {setup.observation_parent_id.slice(0, 8)}
              </div>
            )}
          </div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Legacy scores and factors — diagnostics only; does not authorize entry</div>
          <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            <span>Score <strong className="text-foreground/80">{formatPct(currentScore)}</strong></span>
            <span>Legacy core <strong className="text-foreground/80">{setup.tier1_count}/4</strong></span>
            <span>Supporting <strong className="text-foreground/80">{setup.tier2_count}/5</strong></span>
            <span>Context <strong className="text-foreground/80">{setup.tier3_count}</strong></span>
          </div>
          {/* Present factors */}
          <div>
            <p className="text-[10px] text-foreground/50 uppercase tracking-wider mb-0.5">Present</p>
            <div className="flex flex-wrap gap-0.5">
              {setup.current_factors.map((f, i) => (
                <FactorPill key={i} name={f.name} tier={f.tier} present />
              ))}
            </div>
          </div>
          {/* Missing factors */}
          {setup.missing_factors.length > 0 && (
            <div>
              <p className="text-[10px] text-foreground/50 uppercase tracking-wider mb-0.5">Missing</p>
              <div className="flex flex-wrap gap-0.5">
                {setup.missing_factors.map((f, i) => (
                  <FactorPill key={i} name={f.name} tier={f.tier} present={false} />
                ))}
              </div>
            </div>
          )}
          {/* Key levels */}
          {(frozenZoneLow != null || frozenZoneHigh != null || plannedEntry != null || stagedReference != null || structuralInvalidation != null || plannedPositionStop != null || projectedTarget != null) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono mt-1">
              {frozenZoneLow != null && frozenZoneHigh != null && (
                <span className="text-foreground/60">Frozen zone: <span className="text-foreground">{formatEvidencePrice(frozenZoneLow, setup.symbol)}–{formatEvidencePrice(frozenZoneHigh, setup.symbol)}</span></span>
              )}
              {plannedEntry != null && <span className="text-foreground/60">Planned entry: <span className="text-foreground">{formatEvidencePrice(plannedEntry, setup.symbol)}</span></span>}
              {stagedReferenceDiffers && (
                <span className="text-foreground/60" title="Price stored when this candidate was staged; it is not necessarily the executable entry.">
                  Latest staged reference: <span className="text-foreground">{formatEvidencePrice(stagedReference, setup.symbol)}</span>
                </span>
              )}
              {plannedEntry == null && stagedReference != null && (
                <span className="text-foreground/60" title="Legacy staged price; no immutable planned-entry value is present in the stored zone contract.">
                  Staged entry/reference: <span className="text-foreground">{formatEvidencePrice(stagedReference, setup.symbol)}</span>
                </span>
              )}
              {structuralInvalidation != null && (
                <span
                  className="text-foreground/60"
                  title="The price that invalidates this Watchlist thesis before a trade opens. It is not an active trade stop loss."
                >
                  Structural invalidation:{" "}
                  <span className="text-destructive">
                    {formatEvidencePrice(structuralInvalidation, setup.symbol)}
                  </span>
                </span>
              )}
              {plannedPositionStop != null && <span className="text-foreground/60">Planned position stop: <span className="text-destructive">{formatEvidencePrice(plannedPositionStop, setup.symbol)}</span></span>}
              {projectedTarget != null && <span className="text-foreground/60">Projected target: <span className="text-success">{formatEvidencePrice(projectedTarget, setup.symbol)}</span></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Watchlist Panel ──
export function WatchlistPanel({ confluenceGate: _confluenceGate }: { confluenceGate: number }) {
  void _confluenceGate;
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data: activeSetups, isLoading: loadingActive } = useQuery({
    queryKey: ["staged-setups-active"],
    queryFn: () => scannerApi.activeStaged(),
    refetchInterval: 15000, // Refresh every 15s to stay current
  });

  const { data: allSetups, isLoading: loadingAll } = useQuery({
    queryKey: ["staged-setups-all"],
    queryFn: () => scannerApi.allStaged(),
    enabled: showHistory,
    refetchInterval: 30000,
  });

  const dismissMut = useMutation({
    mutationFn: (setupId: string) => scannerApi.dismissStaged(setupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staged-setups-active"] });
      queryClient.invalidateQueries({ queryKey: ["staged-setups-all"] });
      toast.success("Setup dismissed");
    },
    onError: (err) => toast.error(
      err instanceof Error ? err.message : "Failed to dismiss",
    ),
  });

  const active = activeSetups || [];
  const history = (allSetups || []).filter(
    s => s.status !== "watching" && s.status !== "qualified",
  );
  const nearZoneCount = active.filter((setup) =>
    ["approaching_zone", "at_zone", "local_trigger_active", "local_trigger_swept", "sweep_rejected", "confirmation_ready"].includes(
      setup.lifecycle_phase || setup.lifecycle_evidence?.phase || "",
    )
  ).length;

  return (
    <Card className="border-amber-500/20">
      <CardContent className="pt-3 pb-2">
        {/* Header */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-between mb-1"
        >
          <div className="flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5 text-warn" />
            <span className="text-xs text-foreground/70 uppercase tracking-wider font-medium">
              Watchlist
            </span>
            {active.length > 0 && (
              <Badge variant="outline" className="text-[10px] h-4 px-1 border-amber-500/30 text-warn">
                {active.length}
              </Badge>
            )}
            {nearZoneCount > 0 && (
              <Badge variant="outline" className="text-[10px] h-4 px-1 border-success/30 text-success animate-pulse">
                <Zap className="h-2 w-2 mr-0.5" /> {nearZoneCount} near zone
              </Badge>
            )}
          </div>
          {collapsed ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronUp className="h-3 w-3 text-muted-foreground" />}
        </button>

        {!collapsed && (
          <div className="space-y-1.5">
            {loadingActive ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : active.length === 0 ? (
              <p className="text-xs text-foreground/50 text-center py-3">
                No setups being watched. Directional candidates above the watch
                floor can appear in monitoring while they wait for a valid
                unified zone. Monitoring candidates cannot execute.
              </p>
            ) : (
              active.map(setup => (
                <StagedSetupCard
                  key={setup.id}
                  setup={setup}
                  onDismiss={(id) => dismissMut.mutate(id)}
                  isDismissing={dismissMut.isPending}
                />
              ))
            )}

            {/* History toggle */}
            <div className="border-t border-border/30 pt-1 mt-1">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-[11px] text-foreground/60 hover:text-foreground transition-colors"
              >
                {showHistory ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                {showHistory ? "Hide history" : "Show resolved setups"}
              </button>

              {showHistory && (
                <div className="mt-1.5 space-y-1 max-h-40 overflow-y-auto">
                  {loadingAll ? (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground mx-auto" />
                  ) : history.length === 0 ? (
                    <p className="text-[11px] text-foreground/50 text-center py-2">No resolved setups yet</p>
                  ) : (
                    history.slice(0, 20).map(s => (
                      <div key={s.id} className="text-[11px] py-0.5 px-1.5 rounded bg-muted/10">
                        <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {s.direction === "long"
                            ? <TrendingUp className="h-2.5 w-2.5 text-success shrink-0" />
                            : <TrendingDown className="h-2.5 w-2.5 text-destructive shrink-0" />
                          }
                          <span className="font-medium text-foreground">{s.symbol}</span>
                          <Badge variant="outline" className={`text-[9px] h-3.5 px-1 ${
                            s.status === "filled" ? "text-success border-success/30"
                            : s.status === "expired" ? "text-muted-foreground border-border"
                            : s.status === "cancelled" ? "text-highlight border-highlight/30"
                            : "text-destructive border-destructive/30"
                          }`}>
                            {s.status === "filled" ? <Target className="h-2 w-2 mr-0.5" /> : s.status === "invalidated" || s.status === "blocked_after_qualification" ? <ShieldX className="h-2 w-2 mr-0.5" /> : <Clock className="h-2 w-2 mr-0.5" />}
                            {s.status.replace(/_/g, " ").toUpperCase()}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="font-mono text-[10px] text-foreground/70">{s.initial_score.toFixed(0)}% → {s.current_score.toFixed(0)}%</span>
                          <span className="font-mono text-[10px] text-foreground/50">#{s.candidate_id?.slice(0, 8) || "legacy"}</span>
                          <span className="text-foreground/50 text-[10px]">{s.scan_cycles} cycles</span>
                          <span className="text-foreground/50 text-[10px]">{timeAgo(s.resolved_at || s.updated_at)}</span>
                        </div>
                        </div>
                        {(s.invalidation_reason || s.lifecycle_reason) && (
                          <div className="mt-0.5 pl-4">
                            <div className="flex flex-wrap items-center gap-1">
                              {s.lifecycle_reason_code && (
                                <Badge variant="outline" className="text-[8px] h-4 px-1 border-cyan-500/30 text-cyan-400">
                                  {lifecycleReasonLabel(s.lifecycle_reason_code)}
                                </Badge>
                              )}
                              <p className="text-[10px] text-foreground/55 leading-tight">
                                {displayResolutionReason(
                                  s.invalidation_reason || s.lifecycle_reason,
                                )}
                              </p>
                            </div>
                            <LifecycleEvidenceSummary
                              symbol={s.symbol}
                              evidence={s.lifecycle_evidence}
                            />
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
