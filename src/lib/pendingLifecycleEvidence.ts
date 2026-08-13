import { rawPipsToDisplay } from "@/lib/pipDisplay";

export interface PendingLifecycleRow {
  id: string;
  order_id: string;
  candidate_id: string | null;
  symbol: string;
  direction: string;
  status: string;
  entry_price: number;
  current_price: number | null;
  placed_at: string;
  expires_at: string;
  zone_touch_time: string | null;
  resolved_at: string | null;
  liquidity_confirmation_observation: Record<string, unknown> | null;
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
  observedDistancePips: number | null;
  touched: boolean;
  sequenceReady: boolean | null;
  sequenceReason: string | null;
  observationVersion: string | null;
  frozenEntryLocationAllowed: boolean | null;
  frozenEntryLocationPercent: number | null;
  linkedPosition: PendingLifecycleOutcome | null;
}

export function buildPendingLifecycleEvidence(
  orders: PendingLifecycleRow[],
  positions: PendingLifecycleOutcome[],
) {
  const positionsByOrder = new Map(
    positions.filter((row) => row.source_pending_order_id)
      .map((row) => [row.source_pending_order_id as string, row]),
  );
  const rows: PendingLifecycleEvidenceRow[] = orders.map((order) => {
    const observation = order.liquidity_confirmation_observation;
    let signalReason: Record<string, any> = {};
    try {
      signalReason = typeof order.signal_reason === "string"
        ? JSON.parse(order.signal_reason)
        : (order.signal_reason || {});
    } catch {
      signalReason = {};
    }
    const location = signalReason.canonicalDealingRangeObservation?.canonical ||
      order.final_authorization?.canonicalDealingRange ||
      null;
    const rawDistance = order.current_price == null
      ? null
      : Math.abs(Number(order.entry_price) - Number(order.current_price));
    return {
      ...order,
      observedDistancePips: rawDistance == null
        ? null
        : rawPipsToDisplay(rawDistance, order.symbol),
      touched: order.zone_touch_time != null,
      sequenceReady: typeof observation?.ready === "boolean"
        ? observation.ready
        : null,
      sequenceReason: typeof observation?.reasonCode === "string"
        ? observation.reasonCode
        : null,
      observationVersion: typeof observation?.contractVersion === "string"
        ? observation.contractVersion
        : null,
      frozenEntryLocationAllowed: typeof location?.allowed === "boolean"
        ? location.allowed
        : null,
      frozenEntryLocationPercent: Number.isFinite(Number(location?.percent))
        ? Number(location.percent)
        : null,
      linkedPosition: positionsByOrder.get(order.id) || null,
    };
  });
  const reasonCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const key = row.sequenceReason || "observation_unavailable";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const distances = rows.map((row) => row.observedDistancePips)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    summary: {
      total: rows.length,
      active: rows.filter((row) => ["pending", "awaiting_confirmation"].includes(row.status)).length,
      touched: rows.filter((row) => row.touched).length,
      expiredUntouched: rows.filter((row) => row.status === "expired" && !row.touched).length,
      sequenceReady: rows.filter((row) => row.sequenceReady === true).length,
      filled: rows.filter((row) => row.status === "filled").length,
      linkedOutcomes: rows.filter((row) => row.linkedPosition != null).length,
      frozenLocationAvailable: rows.filter((row) => row.frozenEntryLocationAllowed != null).length,
      averageObservedDistancePips: distances.length
        ? distances.reduce((sum, value) => sum + value, 0) / distances.length
        : null,
      reasonCounts,
    },
    rows,
  };
}
