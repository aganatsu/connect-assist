import { getAssetType, getPipSize, rawPipsToDisplay } from "@/lib/pipDisplay";

export interface PendingLifecycleRow {
  id: string;
  order_id: string;
  candidate_id: string | null;
  symbol: string;
  direction: string;
  status: string;
  entry_price: number;
  current_price: number | null;
  entry_zone_type?: string | null;
  entry_zone_low?: number | null;
  entry_zone_high?: number | null;
  placed_at: string;
  expires_at: string;
  zone_touch_time: string | null;
  resolved_at: string | null;
  liquidity_confirmation_observation: Record<string, unknown> | null;
  pending_authorization_observation?: Record<string, any> | null;
  signal_reason?: Record<string, unknown> | string | null;
  final_authorization?: Record<string, unknown> | null;
}

export interface PendingLifecycleOutcome {
  source_pending_order_id: string | null;
  position_id: string;
  position_status: string;
  close_reason: string | null;
  pnl?: number | null;
  pnl_pips?: number | null;
}

export interface PendingLifecycleEvidenceRow extends PendingLifecycleRow {
  latestDistancePips: number | null;
  armDistancePips: number | null;
  armDistanceAtr: number | null;
  armTtlMinutes: number | null;
  referenceMaxDistancePips: number | null;
  withinReferenceDistance: boolean | null;
  repeatPlanCount: number;
  touched: boolean;
  sequenceReady: boolean | null;
  sequenceReason: string | null;
  observationVersion: string | null;
  frozenEntryLocationAllowed: boolean | null;
  frozenEntryLocationPercent: number | null;
  linkedPosition: PendingLifecycleOutcome | null;
  confirmationMatrixEvaluations: number;
  confirmationBothPassed: number;
  confirmationDetectorOnly: number;
  confirmationLifecycleOnly: number;
  confirmationNeitherPassed: number;
  missingLifecycleContractSamples: number;
  finalAuthorizationObserved: boolean;
  finalAuthorizationAuthorized: boolean | null;
  finalAuthorizationCode: string | null;
  finalAuthorizationReason: string | null;
  authorizationRiskReward: number | null;
  executionRiskReward: number | null;
  favorableEntryDriftR: number | null;
  effectiveTargetRiskReward: number | null;
  effectiveMinimumRiskReward: number | null;
}

interface ReachabilityObservation {
  contractVersion?: unknown;
  distancePips?: unknown;
  distanceAtr?: unknown;
  ttlMinutes?: unknown;
  referenceMaxDistancePips?: unknown;
  withinReferenceDistance?: unknown;
}

function parseSignalReason(value: PendingLifecycleRow["signal_reason"]): Record<string, any> {
  try {
    return typeof value === "string" ? JSON.parse(value) : (value || {});
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function executablePlanKey(order: PendingLifecycleRow): string | null {
  const low = finiteNumber(order.entry_zone_low);
  const high = finiteNumber(order.entry_zone_high);
  const entry = finiteNumber(order.entry_price);
  if (!order.entry_zone_type || low == null || high == null || entry == null) return null;
  const stable = (value: number) => value.toPrecision(12);
  return [
    order.symbol,
    order.direction,
    order.entry_zone_type,
    stable(low),
    stable(high),
    stable(entry),
  ].join("|");
}

export function buildPendingLifecycleEvidence(
  orders: PendingLifecycleRow[],
  positions: PendingLifecycleOutcome[],
) {
  const positionsByOrder = new Map(
    positions.filter((row) => row.source_pending_order_id)
      .map((row) => [row.source_pending_order_id as string, row]),
  );
  const planCounts = orders.reduce<Map<string, number>>((counts, order) => {
    const key = executablePlanKey(order);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  const rows: PendingLifecycleEvidenceRow[] = orders.map((order) => {
    const observation = order.liquidity_confirmation_observation;
    const authorizationObservation =
      order.pending_authorization_observation?.contractVersion ===
          "pending-authorization-observation.v1"
        ? order.pending_authorization_observation
        : null;
    const confirmationMatrix = authorizationObservation?.confirmation || null;
    const matrixCounts = confirmationMatrix?.matrixCounts || {};
    const finalAuthorizationObservation =
      authorizationObservation?.finalAuthorization || null;
    const signalReason = parseSignalReason(order.signal_reason);
    const candidateReachability = (signalReason.preArmReachability || null) as ReachabilityObservation | null;
    const reachability = candidateReachability?.contractVersion === "prearm-reachability.v1"
      ? candidateReachability
      : null;
    const location = signalReason.canonicalDealingRangeObservation?.canonical ||
      order.final_authorization?.canonicalDealingRange ||
      null;
    const rawLatestDistance = order.current_price == null
      ? null
      : Math.abs(Number(order.entry_price) - Number(order.current_price));
    const rawArmDistancePips = finiteNumber(reachability?.distancePips);
    const planKey = executablePlanKey(order);

    return {
      ...order,
      latestDistancePips: rawLatestDistance == null
        ? null
        : rawPipsToDisplay(rawLatestDistance / getPipSize(order.symbol), order.symbol),
      armDistancePips: rawArmDistancePips == null
        ? null
        : rawPipsToDisplay(rawArmDistancePips, order.symbol),
      armDistanceAtr: finiteNumber(reachability?.distanceAtr),
      armTtlMinutes: finiteNumber(reachability?.ttlMinutes),
      referenceMaxDistancePips: finiteNumber(reachability?.referenceMaxDistancePips),
      withinReferenceDistance: typeof reachability?.withinReferenceDistance === "boolean"
        ? reachability.withinReferenceDistance
        : null,
      repeatPlanCount: planKey ? (planCounts.get(planKey) || 1) : 1,
      touched: order.zone_touch_time != null,
      sequenceReady: typeof observation?.ready === "boolean" ? observation.ready : null,
      sequenceReason: typeof observation?.reasonCode === "string" ? observation.reasonCode : null,
      observationVersion: typeof observation?.contractVersion === "string"
        ? observation.contractVersion
        : null,
      frozenEntryLocationAllowed: typeof location?.allowed === "boolean" ? location.allowed : null,
      frozenEntryLocationPercent: finiteNumber(location?.percent),
      linkedPosition: positionsByOrder.get(order.id) || null,
      confirmationMatrixEvaluations: nonNegativeCount(
        confirmationMatrix?.evaluations,
      ),
      confirmationBothPassed: nonNegativeCount(matrixCounts.both_passed),
      confirmationDetectorOnly: nonNegativeCount(matrixCounts.detector_only),
      confirmationLifecycleOnly: nonNegativeCount(matrixCounts.lifecycle_only),
      confirmationNeitherPassed: nonNegativeCount(matrixCounts.neither_passed),
      missingLifecycleContractSamples: nonNegativeCount(
        confirmationMatrix?.missingContractSamples,
      ),
      finalAuthorizationObserved: finalAuthorizationObservation != null,
      finalAuthorizationAuthorized:
        typeof finalAuthorizationObservation?.authorized === "boolean"
          ? finalAuthorizationObservation.authorized
          : null,
      finalAuthorizationCode:
        typeof finalAuthorizationObservation?.code === "string"
          ? finalAuthorizationObservation.code
          : null,
      finalAuthorizationReason:
        typeof finalAuthorizationObservation?.reason === "string"
          ? finalAuthorizationObservation.reason
          : null,
      authorizationRiskReward: finiteNumber(
        finalAuthorizationObservation?.authorizationGeometry?.riskReward,
      ),
      executionRiskReward: finiteNumber(
        finalAuthorizationObservation?.wouldBeExecutionGeometry?.riskReward,
      ),
      favorableEntryDriftR: finiteNumber(
        finalAuthorizationObservation?.favorableEntryDriftR,
      ),
      effectiveTargetRiskReward: finiteNumber(
        finalAuthorizationObservation?.effectiveTargetRiskReward,
      ),
      effectiveMinimumRiskReward: finiteNumber(
        finalAuthorizationObservation?.effectiveMinimumRiskReward,
      ),
    };
  });

  const reasonCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const key = row.sequenceReason || "observation_unavailable";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const terminalRows = rows.filter((row) => !["pending", "awaiting_confirmation"].includes(row.status));
  const expiredUntouched = rows.filter((row) => row.status === "expired" && !row.touched).length;
  const armDistances = rows
    .filter((row) => getAssetType(row.symbol) === "forex")
    .map((row) => row.armDistancePips)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const armAtrDistances = rows.map((row) => row.armDistanceAtr)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const repeatedGroups = [...planCounts.values()].filter((count) => count > 1);
  const finalAuthorizationRows = rows.filter((row) => row.finalAuthorizationObserved);
  const favorableEntryDrifts = finalAuthorizationRows
    .map((row) => row.favorableEntryDriftR)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const riskRewardRegimes = finalAuthorizationRows.reduce<Record<string, number>>(
    (counts, row) => {
      if (
        row.effectiveTargetRiskReward == null ||
        row.effectiveMinimumRiskReward == null
      ) return counts;
      const key = row.effectiveTargetRiskReward.toFixed(2) + " target / " +
        row.effectiveMinimumRiskReward.toFixed(2) + " floor";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    },
    {},
  );

  return {
    summary: {
      total: rows.length,
      active: rows.filter((row) => ["pending", "awaiting_confirmation"].includes(row.status)).length,
      touched: rows.filter((row) => row.touched).length,
      expiredUntouched,
      expiredUntouchedRate: terminalRows.length ? expiredUntouched / terminalRows.length : null,
      sequenceReady: rows.filter((row) => row.sequenceReady === true).length,
      filled: rows.filter((row) => row.status === "filled").length,
      linkedOutcomes: rows.filter((row) => row.linkedPosition != null).length,
      frozenLocationAvailable: rows.filter((row) => row.frozenEntryLocationAllowed != null).length,
      reachabilityAvailable: rows.filter((row) => row.armDistancePips != null).length,
      withinReferenceDistance: rows.filter((row) => row.withinReferenceDistance === true).length,
      averageArmDistancePips: armDistances.length
        ? armDistances.reduce((sum, value) => sum + value, 0) / armDistances.length
        : null,
      averageArmDistanceAtr: armAtrDistances.length
        ? armAtrDistances.reduce((sum, value) => sum + value, 0) / armAtrDistances.length
        : null,
      repeatedPlans: repeatedGroups.length,
      repeatedLifecycleRows: repeatedGroups.reduce((sum, count) => sum + count, 0),
      reasonCounts,
      confirmationEvaluations: rows.reduce(
        (sum, row) => sum + row.confirmationMatrixEvaluations,
        0,
      ),
      confirmationBothPassed: rows.reduce(
        (sum, row) => sum + row.confirmationBothPassed,
        0,
      ),
      confirmationDetectorOnly: rows.reduce(
        (sum, row) => sum + row.confirmationDetectorOnly,
        0,
      ),
      confirmationLifecycleOnly: rows.reduce(
        (sum, row) => sum + row.confirmationLifecycleOnly,
        0,
      ),
      confirmationNeitherPassed: rows.reduce(
        (sum, row) => sum + row.confirmationNeitherPassed,
        0,
      ),
      missingLifecycleContractSamples: rows.reduce(
        (sum, row) => sum + row.missingLifecycleContractSamples,
        0,
      ),
      finalAuthorizationObserved: finalAuthorizationRows.length,
      finalAuthorizationBlocked: finalAuthorizationRows.filter((row) =>
        row.finalAuthorizationAuthorized === false
      ).length,
      finalAuthorizationRiskRewardBlocked: finalAuthorizationRows.filter((row) =>
        row.finalAuthorizationCode === "risk_reward" ||
        row.finalAuthorizationReason?.includes("risk_reward")
      ).length,
      averageFavorableEntryDriftR: favorableEntryDrifts.length
        ? favorableEntryDrifts.reduce((sum, value) => sum + value, 0) /
          favorableEntryDrifts.length
        : null,
      riskRewardRegimes,
    },
    rows,
  };
}
