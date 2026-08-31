/**
 * ZoneStoryPanel — Consolidated zone display that tells the full trade story.
 *
 * Table-based layout for quick scanning:
 * Impulse → Zone → Price → Liquidity → Confirmation → Entry
 *
 * Data comes from detail.unifiedZone (the story) and detail.impulseZone (gate data).
 */

import { formatPipDisplay } from "@/lib/pipDisplay";
import { TimeframeEvidencePanel } from "@/components/TimeframeEvidencePanel";

/** Format ISO timestamp to readable AM/PM format: "Jul 15, 8:00 PM" */
function formatTraceDate(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    const hasTime = iso.includes("T");
    if (!hasTime) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

interface ZoneStoryData {
  hasZone: boolean;
  state: string;
  selectedTF: string | null;
  unifiedScore: number;
  scoreBreakdown: {
    baseScore: number;
    liquidityBonus: number;
    confirmationBonus: number;
    tfBonus: number;
    total: number;
  };
  impulse: {
    direction: "bullish" | "bearish";
    breakType?: "bos" | "choch" | null;
    high: number;
    low: number;
    pips: number;
    timeframe: string;
    startDate: string | null;
    endDate: string | null;
    breakDate?: string | null;
    extendedBeyondBreak?: boolean;
    spanBars: number;
    qualification?: {
      state:
        | "forming"
        | "completed_unqualified"
        | "qualified"
        | "stale"
        | "invalidated"
        | "developing";
      reasons: string[];
      measurements: Record<string, unknown>;
    } | null;
    bosPrice: number;
  } | null;
  zone: {
    type: "OB" | "FVG";
    high: number;
    low: number;
    fibLevel: number;
    fibLabel: string;
    srConfirmed: boolean;
    srLevel?: number;
    htfLayers: string[];
    ltfRefined: boolean;
    totalScore: number;
    zonesFound: number;
  } | null;
  entryZoneQualification?: {
    state:
      | "not_evaluated"
      | "missing"
      | "rejected"
      | "candidate_available"
      | "selected";
    stage: string;
    qualified: boolean;
    reasons: string[];
    measurements?: Record<string, unknown>;
  } | null;
  price: {
    currentPrice: number;
    atZone: boolean;
    atZoneStrict: boolean;
    insideZone: boolean;
    distancePips: number;
    sideOk: boolean;
  };
  liquidity: {
    liquidityScore: number;
    summary: string;
    nearbyPools: number;
    entryTriggerState?: "unswept" | "swept_rejected" | "swept_absorbed" | "none";
    hasUnsweptEntryTrigger?: boolean;
    gateReason?: string;
    entryTrigger?: {
      level: number;
      type: "buy-side" | "sell-side";
      nearEdge: "above_high" | "below_low" | "inside";
      distanceToZone: number;
      maxDistance: number;
      state: "unswept" | "swept_rejected" | "swept_absorbed" | "none";
    } | null;
    sweepEvent: {
      level: number;
      type: string;
      rejected: boolean;
    } | null;
  } | null;
  confirmation: {
    type: string;
    score: number;
    entryReady: boolean;
    direction: string;
    detail: string;
  } | null;
  entry: {
    direction: "long" | "short";
    entryPrice: number;
    slPrice: number;
    tpPrice: number | null;
    riskPips: number;
    rewardPips: number | null;
    rrRatio: number | null;
  } | null;
  storySummary: string;
  reason: string;
}

interface ImpulseGateData {
  hasZone: boolean;
  selectedTF: string | null;
  bestZone: {
    type: string;
    totalScore: number;
    srConfirmed: boolean;
    ltfRefined: boolean;
    ltfType: string | null;
    refinedEntry: number | null;
    refinedSL: number | null;
    priceAtZone: boolean;
    priceInsideZone?: boolean;
    priceAtZoneStrict?: boolean;
    sideOk?: boolean;
    distancePips?: number;
    localConfluence?: {
      policyVersion: string;
      enforcement: "observe_only";
      candidateId: string;
      items: Array<{
        source: string;
        label: string;
        legacyScoreContribution: number;
        measurement: {
          proximityClass: string;
          qualifiedLocally: boolean;
          fullCreditEligible: boolean;
          distancePips: number;
          overlapPercent: number;
          permittedBufferPips: number;
          reasonCode: string;
        } | null;
        qualification: {
          qualified: boolean;
          role: string;
          proximityClass: string;
        } | null;
      }>;
    } | null;
    shadowRanking?: {
      enforcement: "observe_only";
      legacyRank: number;
      shadowRank: number;
      legacyComparableScore: number;
      shadowLocalScore: number;
      summary: {
        observedItems: number;
        locallyQualifiedItems: number;
        contextOnlyItems: number;
        creditedFamilies: number;
      };
    } | null;
    candidateLifecycle?: {
      state:
        | "fresh"
        | "tapped_and_held"
        | "partially_mitigated"
        | "violated";
      retestCount: number;
      maxPenetrationPercent: number;
      explanation: string;
    } | null;
    candidateModel?: {
      enforcement: "observe_only";
      rank: number;
      topCandidate: boolean;
      eligible: boolean;
      totalScore: number;
      distanceATR: number | null;
      factors: {
        zoneLocalConfluence: number;
        proximityToCurrentPrice: number;
        sweepQuality: number;
        retestQuality: number;
        displacementQuality: number;
        structuralImportance: number;
      };
    } | null;
    timeframeLineage?: {
      relationship:
        | "qualified_nested"
        | "context_only"
        | "standalone_lower_tf"
        | "timeframe_conflict"
        | "no_parent_context";
      candidateTimeframe: string;
      parentCandidateId: string | null;
      parentTimeframe: string | null;
      overlapPercentOfChild: number;
      parentDistanceATR: number | null;
      explanation: string;
    } | null;
  } | null;
  scoringEnabled?: boolean;
  directionDetail?: {
    bias: "bullish" | "bearish" | null;
    biasSource: "daily" | "4h" | null;
    h4Retrace: boolean;
    h4ChochAgainst: boolean;
    h1Confirmed: boolean;
  } | null;
}

interface ZoneLocalEnforcementData {
  mode: {
    requestedMode: "observe" | "soft" | "hard";
    effectiveMode: "observe" | "soft" | "hard";
    certifiedMaximum: "observe" | "soft" | "hard";
    activationTrusted: boolean;
    reason: string;
  };
  allowed: boolean;
  scoreAdjustment: number;
  minimumLocalScore: number;
  reason: string;
}

interface FrozenCrossTimeframeContextData {
  contractVersion: string;
  enforcement: "observe_only";
  gamePlan: { id: string | null; version: string | null };
  directionVerdict: { id: string | null; version: string | null };
  stylePolicy: {
    version: string;
    basePolicyHash: string;
    policyHash: string;
  };
  selectedZone: {
    candidateId: string | null;
    timeframe: string | null;
  } | null;
  relationship: {
    classification: string;
    parentTimeframe: string | null;
  } | null;
  evidenceCertificates: Array<{
    featureKey: string;
    certificateHash: string;
  }>;
}

interface Props {
  unifiedData: ZoneStoryData | null | undefined;
  gateData?: ImpulseGateData | null | undefined;
  zoneLocalEnforcement?: ZoneLocalEnforcementData | null | undefined;
  isLiveContext?: boolean;
  symbol?: string;
  direction?: string | null;
  timeframeEvidenceId?: string | null;
  frozenCrossTimeframeContext?: FrozenCrossTimeframeContextData | null;
  frozenExecutablePlan?: { entryPrice: number; stopLoss: number | null; takeProfit: number | null } | null;
}

const STATE_COLORS: Record<string, string> = {
  triggered: "text-green-400",
  confirmed: "text-cyan-400",
  at_zone: "text-yellow-400",
  watching: "text-orange-400",
  waiting_for_sweep: "text-purple-400",
  waiting_for_reconfirmation: "text-orange-400",
  no_zone: "text-zinc-400",
  no_impulse: "text-zinc-400",
  error: "text-red-400",
};

const STATE_LABELS: Record<string, string> = {
  triggered: "⚡ TRIGGERED",
  confirmed: "✓ Confirmed",
  at_zone: "📍 Near Zone",
  watching: "⏳ Watching",
  waiting_for_sweep: "⏳ Sweep Wait",
  waiting_for_reconfirmation: "⏳ Reconfirmation Wait",
  no_zone: "— No Entry Zone",
  no_impulse: "— No Impulse",
  error: "⚠ Error",
};

export function ZoneStoryPanel({
  unifiedData,
  gateData,
  zoneLocalEnforcement,
  isLiveContext = false,
  symbol,
  direction,
  timeframeEvidenceId,
  frozenCrossTimeframeContext,
  frozenExecutablePlan,
}: Props) {
  if (!unifiedData) {
    return (
      <TimeframeEvidencePanel
        symbol={symbol}
        direction={direction}
        evidenceId={timeframeEvidenceId}
        isLiveContext={isLiveContext}
      />
    );
  }

  const fmtPips = (raw: number | null | undefined, opts: { showSign?: boolean; absolute?: boolean; decimals?: number } = {}) => {
    if (raw == null) return "—";
    if (symbol) {
      return formatPipDisplay(raw, symbol, { showSign: opts.showSign ?? false, absolute: opts.absolute });
    }
    const d = opts.decimals ?? 1;
    const v = opts.absolute ? Math.abs(raw) : raw;
    return `${v.toFixed(d)} pips`;
  };

  const stateColor = STATE_COLORS[unifiedData.state] ?? "text-zinc-400";
  const stateLabel = STATE_LABELS[unifiedData.state] ?? unifiedData.state;
  const hasEntryZone = unifiedData.hasZone === true && unifiedData.zone != null;
  const impulseStartPrice = unifiedData.impulse?.direction === "bearish"
    ? unifiedData.impulse.high
    : unifiedData.impulse?.low;
  const impulseEndPrice = unifiedData.impulse?.direction === "bearish"
    ? unifiedData.impulse.low
    : unifiedData.impulse?.high;
  const impulseQualificationState = unifiedData.impulse?.qualification?.state;
  const impulseIsQualified = Boolean(
    unifiedData.impulse &&
      (!impulseQualificationState || impulseQualificationState === "qualified"),
  );
  const impulseIsForming = Boolean(
    unifiedData.impulse &&
      (impulseQualificationState === "forming" ||
        impulseQualificationState === "developing"),
  );
  const impulseQualificationLabel = impulseQualificationState === "forming" ||
      impulseQualificationState === "developing"
    ? "FORMING"
    : impulseQualificationState === "completed_unqualified"
    ? "COMPLETED — NOT QUALIFIED"
    : impulseQualificationState === "stale"
    ? "STALE"
    : impulseQualificationState?.toUpperCase();
  const impulseQualificationColor = impulseQualificationState === "qualified"
    ? "text-emerald-400"
    : impulseQualificationState === "forming" ||
        impulseQualificationState === "developing"
    ? "text-amber-400"
    : impulseQualificationState === "completed_unqualified"
    ? "text-orange-400"
    : "text-red-400";
  const entryZoneQualification = unifiedData.entryZoneQualification;
  const missingZoneLabel = entryZoneQualification?.state === "missing"
    ? "No entry-zone candidate mapped"
    : entryZoneQualification?.state === "rejected"
    ? `Entry-zone candidates rejected at ${entryZoneQualification.stage.replace(/_/g, " ")}`
    : entryZoneQualification?.state === "candidate_available"
    ? "Entry-zone candidate available; setup blocked before selection"
    : entryZoneQualification?.state === "not_evaluated"
    ? "Entry zone not evaluated"
    : "No qualified entry zone";
  const impulseBreakType = String(
    unifiedData.impulse?.breakType ??
      unifiedData.impulse?.qualification?.measurements?.breakType ??
      "bos",
  ).toLowerCase();
  const impulseBreakLabel = impulseBreakType === "choch"
    ? "CHoCH"
    : impulseBreakType === "bos"
    ? "BOS"
    : "Structure";

  // Error state
  if (unifiedData.state === "error") {
    return (
      <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-red-900/50">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">ICT Setup Model</span>
          <span className="text-xs font-bold text-red-400">⚠ Error</span>
        </div>
        <p className="text-[10px] text-red-400">{unifiedData.reason}</p>
        <TimeframeEvidencePanel
          symbol={symbol}
          direction={direction}
          evidenceId={timeframeEvidenceId}
          isLiveContext={isLiveContext}
        />
      </div>
    );
  }

  // No impulse / no zone — show direction detail if available
  if (unifiedData.state === "no_impulse" || (unifiedData.state === "no_zone" && !unifiedData.impulse)) {
    return (
      <div className="mt-3 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">ICT Setup Model</span>
          <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
        {gateData?.directionDetail ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1 flex-wrap">
              {gateData.directionDetail.bias && (
                <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  gateData.directionDetail.bias === "bullish" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                }`}>
                  {gateData.directionDetail.biasSource?.toUpperCase()} {gateData.directionDetail.bias === "bullish" ? "↑ BULL" : "↓ BEAR"}
                </span>
              )}
              {!gateData.directionDetail.bias && (
                <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-500">
                  NO BIAS
                </span>
              )}
              <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                gateData.directionDetail.h4Retrace ? "bg-yellow-500/15 text-yellow-400" : "bg-zinc-500/10 text-zinc-500"
              }`}>
                4H {gateData.directionDetail.h4ChochAgainst ? "✗ CHoCH AGAINST" : gateData.directionDetail.h4Retrace ? "↩ RETRACE" : "— intact"}
              </span>
              <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                gateData.directionDetail.h1Confirmed ? "bg-green-500/15 text-green-400" : "bg-zinc-500/10 text-zinc-500"
              }`}>
                1H {gateData.directionDetail.h1Confirmed ? "✓ CONFIRMED" : "✗ waiting"}
              </span>
            </div>
            <p className="text-[10px] text-zinc-300 leading-tight">{unifiedData.reason}</p>
          </div>
        ) : (
          <p className="text-[10px] text-zinc-300">{unifiedData.reason}</p>
        )}
        <TimeframeEvidencePanel
          symbol={symbol}
          direction={direction}
          evidenceId={timeframeEvidenceId}
          isLiveContext={isLiveContext}
        />
      </div>
    );
  }

  // ─── Main Zone Story Table Layout ───
  return (
    <div className="mt-3 p-3 rounded-lg bg-zinc-900/80 border border-zinc-700">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">ICT Setup Model</span>
          {unifiedData.selectedTF && (
            <span className="px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 text-[10px] font-bold">
              {hasEntryZone ? `via ${unifiedData.selectedTF}` : `impulse via ${unifiedData.selectedTF}`}
            </span>
          )}
          {unifiedData.unifiedScore > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-400 text-[10px] font-bold">
              Score {unifiedData.unifiedScore.toFixed(1)}/14
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isLiveContext && gateData?.bestZone && (gateData.bestZone.priceInsideZone || gateData.bestZone.priceAtZoneStrict) && !unifiedData.confirmation?.entryReady && unifiedData.state !== "triggered" && unifiedData.state !== "confirmed" && (
            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 animate-pulse">
              ⏳ Awaiting Confirmation
            </span>
          )}
          <span className={`text-xs font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
      </div>

      {/* Table */}
      <table className="w-full text-[11px] border-collapse">
        <tbody>
          {/* Impulse Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top w-5">
              <Bullet filled={impulseIsQualified} partial={impulseIsForming} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap w-24">
              Impulse
            </td>
            <td className="py-1.5 text-zinc-200">
              {unifiedData.impulse ? (
                <div>
                  <span className={unifiedData.impulse.direction === "bullish" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {unifiedData.impulse.direction === "bullish" ? "↑" : "↓"} {unifiedData.impulse.direction.toUpperCase()}
                  </span>
                  <span className="ml-2">{fmt(impulseStartPrice)} → {fmt(impulseEndPrice)}</span>
                  <span className="text-cyan-400 ml-2">({fmtPips(unifiedData.impulse.pips, { absolute: true })})</span>
                  {unifiedData.impulse.extendedBeyondBreak && (
                    <span className="ml-2 font-mono text-[10px] uppercase text-cyan-300">
                      Extended after {impulseBreakLabel}
                    </span>
                  )}
                  {unifiedData.impulse.qualification && (
                    <span className={`ml-2 font-mono text-[10px] uppercase ${impulseQualificationColor}`}>
                      {impulseQualificationLabel}
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-zinc-400">None found</span>
              )}
            </td>
          </tr>

          {/* Trace Row */}
          {unifiedData.impulse?.startDate && unifiedData.impulse?.endDate && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">Trace</td>
              <td className="py-1">
                <span className="text-green-400 font-mono">{formatTraceDate(unifiedData.impulse.startDate)}</span>
                <span className="text-zinc-500 mx-1">→</span>
                <span className="text-red-400 font-mono">{formatTraceDate(unifiedData.impulse.endDate)}</span>
                <span className="text-zinc-400 ml-2">({unifiedData.impulse.spanBars} {unifiedData.impulse.timeframe} bars)</span>
              </td>
            </tr>
          )}

          {/* BOS Row */}
          {unifiedData.impulse && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">{impulseBreakLabel}</td>
              <td className="py-1 font-mono text-zinc-200">
                {fmt(unifiedData.impulse.bosPrice)}
                {unifiedData.impulse.breakDate && (
                  <span className="ml-2 text-zinc-500">
                    confirmed {formatTraceDate(unifiedData.impulse.breakDate)}
                  </span>
                )}
              </td>
            </tr>
          )}

          {/* Zone Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet filled={hasEntryZone} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Zone</td>
            <td className="py-1.5 text-zinc-200">
              {hasEntryZone ? (
                <div>
                  <span>{unifiedData.zone.type} @ Fib {unifiedData.zone.fibLabel}</span>
                  <span className="text-zinc-400 ml-1">
                    (Legacy S/R {unifiedData.zone.srConfirmed ? `detected ${unifiedData.zone.srLevel ? fmt(unifiedData.zone.srLevel) : ""}` : "not detected"})
                  </span>
                  <span className="text-zinc-300 ml-1">[{fmt(unifiedData.zone.low)}–{fmt(unifiedData.zone.high)}]</span>
                </div>
              ) : (
                <div>
                  <span className="text-zinc-400">{missingZoneLabel}</span>
                  {entryZoneQualification?.reasons?.[0] && (
                    <p className="mt-0.5 text-[9px] text-zinc-500">
                      {entryZoneQualification.reasons[0]}
                    </p>
                  )}
                </div>
              )}
            </td>
          </tr>

          {/* Legacy HTF Row */}
          {unifiedData.zone && unifiedData.zone.htfLayers.length > 0 && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">Legacy HTF</td>
              <td className="py-1 text-blue-400 font-mono text-[10px]">{unifiedData.zone.htfLayers.join(" + ")}</td>
            </tr>
          )}

          {/* LTF + Legacy Gate Score Row */}
          {gateData?.bestZone && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">Legacy score</td>
              <td className="py-1">
                <span className={`font-mono px-1 py-0.5 rounded text-[10px] ${
                  gateData.bestZone.totalScore >= 5 ? "bg-green-500/15 text-green-400"
                  : gateData.bestZone.totalScore >= 3 ? "bg-cyan-500/15 text-cyan-400"
                  : "bg-zinc-500/15 text-zinc-500"
                }`}>
                  {gateData.bestZone.totalScore.toFixed(1)}/9
                </span>
                {gateData.bestZone.ltfRefined && (
                  <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-green-500/15 text-green-400 ml-1">
                    LTF ✓ {gateData.bestZone.ltfType?.toUpperCase() || ""}
                  </span>
                )}
                {gateData.bestZone.refinedEntry && (
                  <span className="text-[10px] font-mono text-zinc-400 ml-2">
                    Entry: {fmt(gateData.bestZone.refinedEntry)}
                  </span>
                )}
                {gateData.bestZone.refinedSL && (
                  <span className="text-[10px] font-mono text-zinc-400 ml-2">
                    SL: {fmt(gateData.bestZone.refinedSL)}
                  </span>
                )}
              </td>
            </tr>
          )}

          {/* Canonical zone-local evidence. This is the trustworthy proximity
              explanation; legacy labels above remain visible for comparison. */}
          {gateData?.bestZone?.localConfluence && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1.5 pr-2 align-top">
                <Bullet
                  filled={gateData.bestZone.localConfluence.items.some(
                    (item) => item.measurement?.qualifiedLocally === true,
                  )}
                />
              </td>
              <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">
                Local evidence
              </td>
              <td className="py-1.5">
                {gateData.bestZone.localConfluence.items.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {gateData.bestZone.localConfluence.items.map((item, index) => {
                      const display = localEvidenceDisplay(item);
                      const distance = item.measurement?.distancePips ?? null;
                      const overlap = item.measurement?.overlapPercent ?? null;
                      return (
                        <span
                          key={`${item.source}:${item.label}:${index}`}
                          className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${display.className}`}
                          title={`Legacy contribution: ${item.legacyScoreContribution}; local policy: ${item.measurement?.reasonCode || "context only"}`}
                        >
                          {item.label}: {display.label}
                          {distance != null && distance > 0
                            ? ` · ${fmtPips(distance, { absolute: true })} away`
                            : overlap != null && overlap > 0 && overlap < 100
                              ? ` · ${overlap.toFixed(0)}% overlap`
                              : ""}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-zinc-400">No local evidence measured</span>
                )}
                <p className="mt-1 text-[9px] text-zinc-400">
                  Only evidence inside, overlapping, or within the local buffer supports this exact zone.
                </p>
              </td>
            </tr>
          )}

          {gateData?.bestZone?.shadowRanking && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">Candidate rank</td>
              <td className="py-1">
                <span className="text-[10px] font-mono text-zinc-300">
                  Legacy #{gateData.bestZone.shadowRanking.legacyRank}
                </span>
                <span className="mx-1 text-zinc-500">→</span>
                <span className={`text-[10px] font-mono font-bold ${
                  gateData.bestZone.shadowRanking.shadowRank === 1
                    ? "text-green-400"
                    : "text-orange-400"
                }`}>
                  Local #{gateData.bestZone.shadowRanking.shadowRank}
                </span>
                <span className="ml-2 text-[10px] font-mono text-zinc-400">
                  local score {gateData.bestZone.shadowRanking.shadowLocalScore.toFixed(1)}
                </span>
                {gateData.bestZone.shadowRanking.legacyRank !==
                    gateData.bestZone.shadowRanking.shadowRank && (
                  <span className="ml-2 rounded bg-orange-500/15 px-1 py-0.5 text-[9px] font-bold text-orange-400">
                    RANK DISAGREEMENT
                  </span>
                )}
              </td>
            </tr>
          )}

          {gateData?.bestZone?.candidateModel && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">
                Candidate model
              </td>
              <td className="py-1">
                <span className="text-[10px] font-mono text-zinc-300">
                  Observe-only #{gateData.bestZone.candidateModel.rank} · score{" "}
                  {gateData.bestZone.candidateModel.totalScore.toFixed(2)}
                </span>
                <span className="ml-2 rounded bg-cyan-500/15 px-1 py-0.5 text-[9px] text-cyan-300">
                  {gateData.bestZone.candidateLifecycle?.state
                    ?.replace(/_/g, " ") ?? "lifecycle unavailable"}
                </span>
                <div className="mt-1 text-[9px] text-zinc-400">
                  Local{" "}
                  {gateData.bestZone.candidateModel.factors.zoneLocalConfluence
                    .toFixed(1)} · proximity{" "}
                  {gateData.bestZone.candidateModel.factors
                    .proximityToCurrentPrice.toFixed(1)} · sweep{" "}
                  {gateData.bestZone.candidateModel.factors.sweepQuality
                    .toFixed(1)} · retest{" "}
                  {gateData.bestZone.candidateModel.factors.retestQuality
                    .toFixed(1)} · displacement{" "}
                  {gateData.bestZone.candidateModel.factors.displacementQuality
                    .toFixed(1)} · structure{" "}
                  {gateData.bestZone.candidateModel.factors
                    .structuralImportance.toFixed(1)}
                </div>
                {gateData.bestZone.candidateLifecycle?.explanation && (
                  <div className="mt-1 text-[9px] text-zinc-500">
                    {gateData.bestZone.candidateLifecycle.explanation}
                  </div>
                )}
              </td>
            </tr>
          )}

          {gateData?.bestZone?.timeframeLineage && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">
                TF lineage
              </td>
              <td className="py-1">
                <span className="rounded bg-violet-500/15 px-1 py-0.5 text-[9px] font-mono text-violet-300">
                  {gateData.bestZone.timeframeLineage.relationship.replace(/_/g, " ")}
                </span>
                <span className="ml-2 text-[10px] font-mono text-zinc-300">
                  {gateData.bestZone.timeframeLineage.candidateTimeframe}
                  {gateData.bestZone.timeframeLineage.parentTimeframe
                    ? ` → parent ${gateData.bestZone.timeframeLineage.parentTimeframe}`
                    : " → no parent"}
                </span>
                <div className="mt-1 text-[9px] text-zinc-500">
                  {gateData.bestZone.timeframeLineage.explanation}
                </div>
              </td>
            </tr>
          )}

          {frozenCrossTimeframeContext && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">
                Frozen authority
              </td>
              <td className="py-1">
                <div className="flex flex-wrap gap-1 text-[9px] font-mono">
                  <span className="rounded bg-primary/10 px-1 py-0.5 text-primary">
                    GP {frozenCrossTimeframeContext.gamePlan.version?.slice(0, 8) || "none"}
                  </span>
                  <span className="rounded bg-cyan-500/10 px-1 py-0.5 text-cyan-300">
                    DV {frozenCrossTimeframeContext.directionVerdict.version?.slice(0, 8) || "none"}
                  </span>
                  <span className="rounded bg-violet-500/10 px-1 py-0.5 text-violet-300">
                    {frozenCrossTimeframeContext.relationship?.classification
                      ?.replace(/_/g, " ") || "no lineage"}
                  </span>
                  <span className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">
                    policy {frozenCrossTimeframeContext.stylePolicy.policyHash.slice(0, 8)}
                  </span>
                  {frozenCrossTimeframeContext.evidenceCertificates.map(
                    (certificate) => (
                      <span
                        key={`${certificate.featureKey}:${certificate.certificateHash}`}
                        className="rounded bg-emerald-500/10 px-1 py-0.5 text-emerald-300"
                      >
                        cert {certificate.featureKey}{" "}
                        {certificate.certificateHash.slice(0, 8)}
                      </span>
                    ),
                  )}
                </div>
                <div className="mt-1 text-[9px] text-zinc-500">
                  Immutable setup evidence · {frozenCrossTimeframeContext.contractVersion}
                </div>
              </td>
            </tr>
          )}

          {zoneLocalEnforcement && (
            <tr className="border-b border-zinc-800/50">
              <td className="py-1 pr-2"></td>
              <td className="py-1 pr-2 align-top text-zinc-400 whitespace-nowrap">Local policy</td>
              <td className="py-1">
                <span className="text-[10px] text-zinc-300">
                  Requested <strong>{zoneLocalEnforcement.mode.requestedMode.toUpperCase()}</strong>
                  {" · "}Effective{" "}
                  <strong className={
                    zoneLocalEnforcement.mode.effectiveMode === "observe"
                      ? "text-cyan-400"
                      : zoneLocalEnforcement.mode.effectiveMode === "soft"
                        ? "text-yellow-400"
                        : "text-red-400"
                  }>
                    {zoneLocalEnforcement.mode.effectiveMode.toUpperCase()}
                  </strong>
                  {" · "}Certified max {zoneLocalEnforcement.mode.certifiedMaximum.toUpperCase()}
                </span>
                <span className={`ml-2 rounded px-1 py-0.5 text-[9px] font-bold ${
                  !hasEntryZone
                    ? "bg-zinc-500/15 text-zinc-400"
                    : zoneLocalEnforcement.allowed
                    ? "bg-green-500/15 text-green-400"
                    : "bg-red-500/15 text-red-400"
                }`}>
                  {!hasEntryZone
                    ? "NOT APPLIED"
                    : zoneLocalEnforcement.allowed
                    ? "ALLOWED"
                    : "BLOCKED"}
                </span>
                {hasEntryZone && zoneLocalEnforcement.scoreAdjustment !== 0 && (
                  <span className="ml-2 text-[10px] font-mono text-orange-400">
                    score {zoneLocalEnforcement.scoreAdjustment}
                  </span>
                )}
                <p className="mt-1 text-[9px] text-zinc-400">
                  {hasEntryZone
                    ? humanizePolicyReason(zoneLocalEnforcement.reason)
                    : "No qualified entry zone exists in this scan, so the zone-local policy has nothing to evaluate."}
                </p>
              </td>
            </tr>
          )}

          {/* Price Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet filled={!!unifiedData.zone && (unifiedData.price.atZone || unifiedData.price.insideZone)} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Price</td>
            <td className="py-1.5">
              {/* Distance is measured against a zone. With none found the engine
                  leaves distancePips at 0, which rendered as "0.0 pips away" —
                  indistinguishable from price sitting exactly on the zone, and
                  shown directly beneath a Zone row with no qualified entry zone. */}
              {!hasEntryZone ? (
                <span className="text-zinc-400">No entry zone to measure against</span>
              ) : unifiedData.price.insideZone ? (
                <span className="text-green-400">Inside zone</span>
              ) : unifiedData.price.atZone ? (
                <span className={unifiedData.price.sideOk ? "text-yellow-400" : "text-orange-400"}>
                  Near zone{!unifiedData.price.sideOk && " (wrong side)"}
                </span>
              ) : (
                <span className="text-orange-400">{fmtPips(unifiedData.price.distancePips, { absolute: true })} away</span>
              )}
            </td>
          </tr>

          {/* Liquidity Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet
                filled={unifiedData.liquidity?.entryTriggerState === "swept_rejected"}
                partial={
                  unifiedData.liquidity?.entryTriggerState === "unswept" ||
                  unifiedData.liquidity?.entryTriggerState === "swept_absorbed"
                }
              />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Liquidity</td>
            <td className="py-1.5">
              {!hasEntryZone ? (
                <span className="text-zinc-400">Not evaluated — no entry zone</span>
              ) : unifiedData.liquidity ? (
                <span className="text-zinc-200">
                  <span className={
                    unifiedData.liquidity.entryTriggerState === "swept_rejected"
                      ? "text-green-400"
                      : unifiedData.liquidity.entryTriggerState === "unswept"
                      ? "text-purple-400"
                      : unifiedData.liquidity.entryTriggerState === "swept_absorbed"
                      ? "text-orange-400"
                      : "text-zinc-400"
                  }>
                    {unifiedData.liquidity.gateReason || unifiedData.liquidity.summary}
                  </span>
                  {unifiedData.liquidity.sweepEvent && (
                    <span className={unifiedData.liquidity.sweepEvent.rejected ? "text-green-400 ml-1" : "text-yellow-400 ml-1"}>
                      [{unifiedData.liquidity.sweepEvent.type} swept{unifiedData.liquidity.sweepEvent.rejected ? " + rejected" : ""}]
                    </span>
                  )}
                  <span className="text-zinc-400 ml-1">
                    ({unifiedData.liquidity.nearbyPools} nearby; {
                      unifiedData.liquidity.entryTrigger ? "1 gating" : "0 gating"
                    })
                  </span>
                </span>
              ) : (
                <span className="text-zinc-400">No significant pools near zone</span>
              )}
            </td>
          </tr>

          {/* Confirmation Row */}
          <tr className="border-b border-zinc-800/50">
            <td className="py-1.5 pr-2 align-top">
              <Bullet
                filled={!!unifiedData.confirmation?.entryReady}
                partial={!!unifiedData.confirmation && unifiedData.confirmation.score > 0 && !unifiedData.confirmation.entryReady}
              />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Confirmation</td>
            <td className="py-1.5">
              {!hasEntryZone ? (
                <span className="text-zinc-400">Not evaluated — no entry zone</span>
              ) : unifiedData.confirmation?.entryReady ? (
                <span className="text-zinc-200">
                  {unifiedData.confirmation.detail}
                  <span className="text-cyan-400 ml-1">(+{unifiedData.confirmation.score.toFixed(1)})</span>
                </span>
              ) : unifiedData.confirmation && unifiedData.confirmation.score > 0 ? (
                <span className="text-yellow-400">
                  {unifiedData.confirmation.detail} (partial — not entry-ready)
                </span>
              ) : (
                <span className="text-zinc-400">
                  Waiting for confirmation in {unifiedData.impulse?.direction ?? "—"} direction
                </span>
              )}
            </td>
          </tr>

          {/* Entry Row */}
          <tr>
            <td className="py-1.5 pr-2 align-top">
              <Bullet filled={!!unifiedData.entry} />
            </td>
            <td className="py-1.5 pr-2 align-top text-zinc-200 font-medium whitespace-nowrap">Entry</td>
            <td className="py-1.5">
              {frozenExecutablePlan ? (
                <div>
                  <span className={direction === "long" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {String(direction || unifiedData.entry?.direction || "entry").toUpperCase()}
                  </span>
                  <span className="font-mono ml-2">@ {fmt(frozenExecutablePlan.entryPrice)}</span>
                  <span className="text-red-400 font-mono ml-2">SL: {fmt(frozenExecutablePlan.stopLoss)}</span>
                  <span className="text-green-400 font-mono ml-2">TP: {fmt(frozenExecutablePlan.takeProfit)}</span>
                  <span className="ml-2 text-[10px] font-mono text-cyan-400">FROZEN PLAN</span>
                </div>
              ) : unifiedData.entry ? (
                <div>
                  <span className={unifiedData.entry.direction === "long" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {unifiedData.entry.direction.toUpperCase()}
                  </span>
                  <span className="font-mono ml-2">@ {fmt(unifiedData.entry.entryPrice)}</span>
                  <span className="text-red-400 font-mono ml-2">SL: {fmt(unifiedData.entry.slPrice)}</span>
                  {unifiedData.entry.tpPrice && (
                    <span className="text-green-400 font-mono ml-2">TP: {fmt(unifiedData.entry.tpPrice)}</span>
                  )}
                  {unifiedData.entry.rrRatio && (
                    <span className={`ml-2 font-bold ${unifiedData.entry.rrRatio >= 3 ? "text-green-400" : unifiedData.entry.rrRatio >= 2 ? "text-cyan-400" : "text-orange-400"}`}>
                      R:R {unifiedData.entry.rrRatio}:1
                    </span>
                  )}
                </div>
              ) : unifiedData.state === "confirmed" || unifiedData.state === "triggered" ? (
                <span className="text-orange-400">R:R below minimum — no entry</span>
              ) : unifiedData.state === "waiting_for_sweep" ? (
                <span className="text-purple-400">Waiting for qualified local/internal sweep</span>
              ) : unifiedData.state === "waiting_for_reconfirmation" ? (
                <span className="text-orange-400">Sweep was not rejected — waiting for a fresh trigger and confirmation</span>
              ) : !hasEntryZone ? (
                <span className="text-zinc-400">Unavailable — no entry zone</span>
              ) : (
                <span className="text-zinc-400">Not yet</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Score breakdown footer */}
      {hasEntryZone && (
        <div className="mt-2 pt-2 border-t border-zinc-800 flex flex-wrap gap-2 text-[10px]">
          <span className="text-zinc-300">Base: {unifiedData.scoreBreakdown.baseScore.toFixed(1)}/9</span>
          {unifiedData.scoreBreakdown.liquidityBonus > 0 && (
            <span className="text-purple-400">Liq: +{unifiedData.scoreBreakdown.liquidityBonus.toFixed(1)}</span>
          )}
          {unifiedData.scoreBreakdown.confirmationBonus > 0 && (
            <span className="text-cyan-400">Conf: +{unifiedData.scoreBreakdown.confirmationBonus.toFixed(1)}</span>
          )}
          {unifiedData.scoreBreakdown.tfBonus > 0 && (
            <span className="text-blue-400">TF: +{unifiedData.scoreBreakdown.tfBonus.toFixed(1)}</span>
          )}
          {gateData?.scoringEnabled && (
            <span className={`font-mono font-bold px-1 py-0.5 rounded ${
              gateData.bestZone?.priceAtZone
                ? "bg-green-500/15 text-green-400"
                : !gateData.hasZone
                  ? "bg-red-500/15 text-red-400"
                  : "bg-zinc-500/10 text-zinc-500"
            }`}>
              {gateData.bestZone?.priceAtZone ? "+bonus" : !gateData.hasZone ? "−penalty" : "neutral"}
            </span>
          )}
        </div>
      )}

      {/* Story summary */}
      <p className="text-[10px] text-zinc-300 mt-2 leading-relaxed">
        {hasEntryZone
          ? `${unifiedData.selectedTF ?? "—"} zone selected${
            unifiedData.scoreBreakdown.tfBonus >= 2.0
              ? " (A+ setup)"
              : unifiedData.scoreBreakdown.tfBonus >= 1.0
              ? " (B+ setup)"
              : ""
          }: ${unifiedData.reason}`
          : `${unifiedData.selectedTF ?? unifiedData.impulse?.timeframe ?? "—"} impulse candidate inspected; no entry zone selected: ${unifiedData.reason}`}
      </p>

      {/* Observation-only per-timeframe evidence */}
      <TimeframeEvidencePanel
        symbol={symbol}
        direction={direction}
        evidenceId={timeframeEvidenceId}
        isLiveContext={isLiveContext}
      />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fmt(price: number | null | undefined): string {
  if (price == null) return "—";
  return price > 10 ? price.toFixed(3) : price.toFixed(5);
}

function Bullet({ filled, partial }: { filled: boolean; partial?: boolean }) {
  const color = filled ? "text-green-400" : partial ? "text-yellow-400" : "text-zinc-400";
  const char = filled ? "●" : partial ? "◐" : "○";
  return <span className={`${color} text-[11px]`}>{char}</span>;
}

function localEvidenceDisplay(item: {
  measurement: {
    proximityClass: string;
    qualifiedLocally: boolean;
    fullCreditEligible: boolean;
  } | null;
}): { label: string; className: string } {
  if (!item.measurement) {
    return {
      label: "context only · 0 local credit",
      className: "border-zinc-700 bg-zinc-800/50 text-zinc-400",
    };
  }
  if (!item.measurement.qualifiedLocally) {
    return {
      label: "outside · 0 local credit",
      className: "border-red-500/30 bg-red-500/10 text-red-300",
    };
  }
  if (item.measurement.fullCreditEligible) {
    return {
      label: item.measurement.proximityClass === "inside"
        ? "inside · full credit"
        : "local overlap · full credit",
      className: "border-green-500/30 bg-green-500/10 text-green-300",
    };
  }
  return {
    label: item.measurement.proximityClass === "buffered"
      ? "near · partial credit"
      : "partial overlap · partial credit",
    className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-300",
  };
}

function humanizePolicyReason(reason: string): string {
  const labels: Record<string, string> = {
    observe_only: "Observation only: local evidence is recorded but does not change the trade.",
    locally_supported: "The selected legacy zone is also the top locally supported candidate.",
    soft_penalty_missing_evidence: "Soft penalty: no canonical local evidence was available.",
    soft_penalty_rank_disagreement: "Soft penalty: the legacy winner was not the local-evidence winner.",
    soft_penalty_insufficient_local_score: "Soft penalty: local evidence did not reach the configured minimum.",
    hard_block_missing_evidence: "Hard block: canonical local evidence was missing.",
    hard_block_rank_disagreement: "Hard block: the legacy winner was not the local-evidence winner.",
    hard_block_insufficient_local_score: "Hard block: local evidence did not reach the configured minimum.",
  };
  return labels[reason] || reason.replace(/_/g, " ");
}

export default ZoneStoryPanel;
