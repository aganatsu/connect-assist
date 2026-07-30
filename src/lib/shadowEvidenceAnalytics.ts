type UnknownRecord = Record<string, unknown>;

export type ShadowFeature = "gameplan_hierarchy" | "thesis_conviction";
export type ShadowDecision = "allow" | "block";
export type ShadowOutcome = "win" | "loss" | "inconclusive";
export type ShadowEvidenceStatus =
  | "no_data"
  | "collecting"
  | "paper_candidate"
  | "keep_shadow";

export interface RejectedShadowEvidenceRecord {
  id: string;
  symbol: string;
  direction: string;
  rejection_type: string;
  confluence_score: number;
  outcome_status: string;
  shadow_decision?: unknown;
  raw_detail?: unknown;
}

export interface ClosedTradeShadowEvidenceRecord {
  id: string;
  position_id?: string | null;
  symbol: string;
  pnl: number | string | null;
  signal_score: number | string | null;
  signal_reason: string | null;
  close_reason: string;
  closed_at: string;
}

export interface ShadowEvidenceObservation {
  feature: ShadowFeature;
  sourceId: string;
  source: "rejected_setup" | "closed_trade";
  symbol: string;
  style: string;
  currentDecision: ShadowDecision;
  proposedDecision: ShadowDecision;
  outcome: ShadowOutcome;
  reason: string;
}

export interface ShadowEvidenceBreakdown {
  key: string;
  resolved: number;
  changed: number;
  beneficial: number;
  harmful: number;
  beneficialRate: number | null;
}

export interface ShadowFeatureEvidenceSummary {
  feature: ShadowFeature;
  label: string;
  totalCandidates: number;
  evidenceCount: number;
  coveragePercent: number;
  resolved: number;
  changed: number;
  beneficial: number;
  harmful: number;
  beneficialRate: number | null;
  rescuedWinners: number;
  avoidedLosses: number;
  admittedLosses: number;
  blockedWinners: number;
  status: ShadowEvidenceStatus;
  statusReason: string;
  byStyle: ShadowEvidenceBreakdown[];
  byPair: ShadowEvidenceBreakdown[];
}

export interface ShadowEvidenceReport {
  totalCandidates: number;
  gameplanHierarchy: ShadowFeatureEvidenceSummary;
  thesisConviction: ShadowFeatureEvidenceSummary;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function parseRecord(value: unknown): UnknownRecord | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function valueAt(record: UnknownRecord | null, ...keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    const currentRecord = asRecord(current);
    if (!currentRecord) return undefined;
    current = currentRecord[key];
  }
  return current;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstRecord(...values: unknown[]): UnknownRecord | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

function styleFromPayload(payload: UnknownRecord | null): string {
  const style = valueAt(payload, "stylePolicy", "style")
    ?? valueAt(payload, "frozenStrategyContext", "stylePolicy", "style")
    ?? valueAt(payload, "decisionContext", "stylePolicy", "style");
  return typeof style === "string" && style.length > 0 ? style : "unknown";
}

function thesisFromPayload(payload: UnknownRecord | null): UnknownRecord | null {
  return firstRecord(
    payload?.thesisConviction,
    valueAt(payload, "decisionContext", "thesisConviction", "evidence"),
  );
}

function thresholdFromPayload(payload: UnknownRecord | null): number | null {
  return finiteNumber(
    valueAt(payload, "shadowEvaluation", "threshold")
      ?? valueAt(payload, "stylePolicy", "qualification", "effectiveMinConfluence")
      ?? valueAt(payload, "frozenStrategyContext", "stylePolicy", "qualification", "effectiveMinConfluence")
      ?? valueAt(payload, "decisionContext", "stylePolicy", "qualification", "effectiveMinConfluence"),
  );
}

function rejectedOutcome(status: string): ShadowOutcome {
  if (status === "would_have_won") return "win";
  if (status === "would_have_lost") return "loss";
  return "inconclusive";
}

function tradeOutcome(pnl: number): ShadowOutcome {
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "inconclusive";
}

interface CollapsedTrade {
  id: string;
  positionId: string;
  symbol: string;
  pnl: number;
  score: number | null;
  payload: UnknownRecord | null;
  hasTerminalClose: boolean;
}

function collapseClosedTrades(
  trades: ClosedTradeShadowEvidenceRecord[],
): CollapsedTrade[] {
  const grouped = new Map<string, CollapsedTrade>();
  for (const trade of trades) {
    const rawKey = trade.position_id || trade.id;
    const key = rawKey.endsWith("_partial")
      ? rawKey.slice(0, -"_partial".length)
      : rawKey;
    const pnl = finiteNumber(trade.pnl) ?? 0;
    const payload = parseRecord(trade.signal_reason);
    const existing = grouped.get(key);
    if (existing) {
      existing.pnl += pnl;
      existing.hasTerminalClose ||= trade.close_reason !== "partial_tp";
      if (!existing.payload && payload) existing.payload = payload;
      if (existing.score === null) existing.score = finiteNumber(trade.signal_score);
      continue;
    }
    grouped.set(key, {
      id: trade.id,
      positionId: key,
      symbol: trade.symbol,
      pnl,
      score: finiteNumber(trade.signal_score),
      payload,
      hasTerminalClose: trade.close_reason !== "partial_tp",
    });
  }
  return [...grouped.values()].filter((trade) => trade.hasTerminalClose);
}

function buildRejectedObservations(
  records: RejectedShadowEvidenceRecord[],
): ShadowEvidenceObservation[] {
  const observations: ShadowEvidenceObservation[] = [];
  for (const record of records) {
    const payload = parseRecord(record.raw_detail);
    const style = styleFromPayload(payload);
    const audit = firstRecord(
      asRecord(record.shadow_decision),
      payload?.gamePlanShadowAudit,
    );
    const auditDecision = audit?.decision;
    if (auditDecision === "eligible" || auditDecision === "wait" || auditDecision === "skip") {
      observations.push({
        feature: "gameplan_hierarchy",
        sourceId: record.id,
        source: "rejected_setup",
        symbol: record.symbol,
        style,
        currentDecision: "block",
        proposedDecision: auditDecision === "eligible" ? "allow" : "block",
        outcome: rejectedOutcome(record.outcome_status),
        reason: `Gameplan shadow decision: ${auditDecision}`,
      });
    }

    const thesis = thesisFromPayload(payload);
    const adjustment = finiteNumber(thesis?.scoreAdjustment);
    const threshold = thresholdFromPayload(payload);
    if (adjustment !== null && threshold !== null) {
      const score = finiteNumber(
        valueAt(payload, "shadowEvaluation", "effectiveScore"),
      ) ?? finiteNumber(record.confluence_score);
      if (score !== null) {
        const canPromote = record.rejection_type === "below_threshold_strong_t1";
        const proposedDecision = canPromote && score + adjustment >= threshold
          ? "allow"
          : "block";
        observations.push({
          feature: "thesis_conviction",
          sourceId: record.id,
          source: "rejected_setup",
          symbol: record.symbol,
          style,
          currentDecision: "block",
          proposedDecision,
          outcome: rejectedOutcome(record.outcome_status),
          reason:
            `Score ${score.toFixed(1)} ${adjustment >= 0 ? "+" : ""}${adjustment.toFixed(1)} `
            + `vs ${threshold.toFixed(1)} threshold`,
        });
      }
    }
  }
  return observations;
}

function buildTradeObservations(
  trades: CollapsedTrade[],
): ShadowEvidenceObservation[] {
  const observations: ShadowEvidenceObservation[] = [];
  for (const trade of trades) {
    const payload = trade.payload;
    const style = styleFromPayload(payload);
    const audit = firstRecord(
      payload?.gamePlanShadowAudit,
      valueAt(payload, "gamePlanSnapshot", "shadowAudit"),
    );
    const auditDecision = audit?.decision;
    if (auditDecision === "eligible" || auditDecision === "wait" || auditDecision === "skip") {
      observations.push({
        feature: "gameplan_hierarchy",
        sourceId: trade.positionId,
        source: "closed_trade",
        symbol: trade.symbol,
        style,
        currentDecision: "allow",
        proposedDecision: auditDecision === "eligible" ? "allow" : "block",
        outcome: tradeOutcome(trade.pnl),
        reason: `Gameplan shadow decision: ${auditDecision}`,
      });
    }

    const thesis = thesisFromPayload(payload);
    const adjustment = finiteNumber(thesis?.scoreAdjustment);
    const threshold = thresholdFromPayload(payload);
    if (adjustment !== null && threshold !== null && trade.score !== null) {
      observations.push({
        feature: "thesis_conviction",
        sourceId: trade.positionId,
        source: "closed_trade",
        symbol: trade.symbol,
        style,
        currentDecision: "allow",
        proposedDecision:
          trade.score + adjustment >= threshold ? "allow" : "block",
        outcome: tradeOutcome(trade.pnl),
        reason:
          `Score ${trade.score.toFixed(1)} ${adjustment >= 0 ? "+" : ""}${adjustment.toFixed(1)} `
          + `vs ${threshold.toFixed(1)} threshold`,
      });
    }
  }
  return observations;
}

function changeValue(observation: ShadowEvidenceObservation): "beneficial" | "harmful" | "unchanged" {
  if (observation.currentDecision === observation.proposedDecision) return "unchanged";
  if (
    (observation.currentDecision === "block"
      && observation.proposedDecision === "allow"
      && observation.outcome === "win")
    || (observation.currentDecision === "allow"
      && observation.proposedDecision === "block"
      && observation.outcome === "loss")
  ) {
    return "beneficial";
  }
  return "harmful";
}

function buildBreakdown(
  observations: ShadowEvidenceObservation[],
  keyOf: (observation: ShadowEvidenceObservation) => string,
): ShadowEvidenceBreakdown[] {
  const groups = new Map<string, ShadowEvidenceObservation[]>();
  for (const observation of observations) {
    const key = keyOf(observation);
    groups.set(key, [...(groups.get(key) || []), observation]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const resolved = group.filter((item) => item.outcome !== "inconclusive");
    const changed = resolved.filter((item) => item.currentDecision !== item.proposedDecision);
    const beneficial = changed.filter((item) => changeValue(item) === "beneficial").length;
    const harmful = changed.length - beneficial;
    return {
      key,
      resolved: resolved.length,
      changed: changed.length,
      beneficial,
      harmful,
      beneficialRate: changed.length > 0 ? beneficial / changed.length * 100 : null,
    };
  }).sort((a, b) => b.changed - a.changed || b.resolved - a.resolved);
}

function summarizeFeature(
  feature: ShadowFeature,
  observations: ShadowEvidenceObservation[],
  totalCandidates: number,
): ShadowFeatureEvidenceSummary {
  const featureObservations = observations.filter((item) => item.feature === feature);
  const resolved = featureObservations.filter((item) => item.outcome !== "inconclusive");
  const changed = resolved.filter((item) => item.currentDecision !== item.proposedDecision);
  const rescuedWinners = changed.filter((item) =>
    item.currentDecision === "block"
    && item.proposedDecision === "allow"
    && item.outcome === "win"
  ).length;
  const admittedLosses = changed.filter((item) =>
    item.currentDecision === "block"
    && item.proposedDecision === "allow"
    && item.outcome === "loss"
  ).length;
  const avoidedLosses = changed.filter((item) =>
    item.currentDecision === "allow"
    && item.proposedDecision === "block"
    && item.outcome === "loss"
  ).length;
  const blockedWinners = changed.filter((item) =>
    item.currentDecision === "allow"
    && item.proposedDecision === "block"
    && item.outcome === "win"
  ).length;
  const beneficial = rescuedWinners + avoidedLosses;
  const harmful = admittedLosses + blockedWinners;
  const coveragePercent = totalCandidates > 0
    ? featureObservations.length / totalCandidates * 100
    : 0;
  const beneficialRate = changed.length > 0
    ? beneficial / changed.length * 100
    : null;

  let status: ShadowEvidenceStatus = "collecting";
  let statusReason =
    `Need at least 30 resolved observations, 10 changed decisions, and 50% evidence coverage before a paper-mode screening.`;
  if (featureObservations.length === 0) {
    status = "no_data";
    statusReason = "No usable evidence has been captured for this feature yet.";
  } else if (resolved.length >= 30 && changed.length >= 10 && coveragePercent >= 50) {
    if ((beneficialRate ?? 0) >= 60) {
      status = "paper_candidate";
      statusReason =
        "The observational screening threshold is met. This supports a controlled paper-mode test, not live activation.";
    } else {
      status = "keep_shadow";
      statusReason =
        "The observed changes are not reliably beneficial enough for a paper-mode promotion.";
    }
  }

  return {
    feature,
    label: feature === "gameplan_hierarchy"
      ? "Gameplan Hierarchy"
      : "Thesis Conviction",
    totalCandidates,
    evidenceCount: featureObservations.length,
    coveragePercent,
    resolved: resolved.length,
    changed: changed.length,
    beneficial,
    harmful,
    beneficialRate,
    rescuedWinners,
    avoidedLosses,
    admittedLosses,
    blockedWinners,
    status,
    statusReason,
    byStyle: buildBreakdown(featureObservations, (item) => item.style),
    byPair: buildBreakdown(featureObservations, (item) => item.symbol),
  };
}

export function buildShadowEvidenceReport(
  rejectedSetups: RejectedShadowEvidenceRecord[],
  closedTradeRows: ClosedTradeShadowEvidenceRecord[],
): ShadowEvidenceReport {
  const closedTrades = collapseClosedTrades(closedTradeRows);
  const totalCandidates = rejectedSetups.length + closedTrades.length;
  const observations = [
    ...buildRejectedObservations(rejectedSetups),
    ...buildTradeObservations(closedTrades),
  ];
  return {
    totalCandidates,
    gameplanHierarchy: summarizeFeature(
      "gameplan_hierarchy",
      observations,
      totalCandidates,
    ),
    thesisConviction: summarizeFeature(
      "thesis_conviction",
      observations,
      totalCandidates,
    ),
  };
}
