export interface DealingRangeComparisonRecord {
  id: string;
  source: "closed" | "rejected";
  symbol: string;
  direction: string;
  observedAt: string;
  outcome: "won" | "lost" | "inconclusive";
  rollingAllowed: boolean | null;
  canonicalAllowed: boolean | null;
  canonicalPercent: number | null;
  explanation: string | null;
  decisionsMatch: boolean | null;
}

function record(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function observationFrom(payload: Record<string, any>): Record<string, any> {
  return record(
    payload.canonicalDealingRangeObservation ??
      payload.rawDetail?.canonicalDealingRangeObservation,
  );
}

function canonicalFrom(payload: Record<string, any>): Record<string, any> {
  const observation = observationFrom(payload);
  return record(
    observation.canonical ??
      payload.finalAuthorization?.canonicalDealingRange ??
      payload.canonicalDealingRange,
  );
}

export function comparisonRecordFromClosed(row: Record<string, any>): DealingRangeComparisonRecord {
  const signal = record(row.signal_reason);
  const observation = observationFrom(signal);
  const canonical = canonicalFrom(signal);
  const pnl = finite(row.pnl) ?? 0;
  const rollingAllowed = typeof observation.rollingAllowed === "boolean" ? observation.rollingAllowed : null;
  const canonicalAllowed = canonical.available === true && typeof canonical.allowed === "boolean"
    ? canonical.allowed
    : null;
  return {
    id: String(row.id),
    source: "closed",
    symbol: String(row.symbol || ""),
    direction: String(row.direction || ""),
    observedAt: String(row.closed_at || row.created_at || ""),
    outcome: pnl > 0 ? "won" : pnl < 0 ? "lost" : "inconclusive",
    rollingAllowed,
    canonicalAllowed,
    canonicalPercent: finite(canonical.percent),
    explanation: typeof canonical.explanation === "string" ? canonical.explanation : null,
    decisionsMatch: rollingAllowed == null || canonicalAllowed == null
      ? null
      : rollingAllowed === canonicalAllowed,
  };
}

export function comparisonRecordFromRejected(row: Record<string, any>): DealingRangeComparisonRecord {
  const raw = record(row.raw_detail);
  const observation = observationFrom(raw);
  const canonical = canonicalFrom(raw);
  const rollingAllowed = typeof observation.rollingAllowed === "boolean" ? observation.rollingAllowed : null;
  const canonicalAllowed = canonical.available === true && typeof canonical.allowed === "boolean"
    ? canonical.allowed
    : null;
  const outcome = row.outcome_status === "would_have_won"
    ? "won"
    : row.outcome_status === "would_have_lost"
    ? "lost"
    : "inconclusive";
  return {
    id: String(row.id),
    source: "rejected",
    symbol: String(row.symbol || ""),
    direction: String(row.direction || ""),
    observedAt: String(row.rejected_at || row.created_at || ""),
    outcome,
    rollingAllowed,
    canonicalAllowed,
    canonicalPercent: finite(canonical.percent),
    explanation: typeof canonical.explanation === "string" ? canonical.explanation : null,
    decisionsMatch: rollingAllowed == null || canonicalAllowed == null
      ? null
      : rollingAllowed === canonicalAllowed,
  };
}

export function summarizeDealingRangeComparison(rows: DealingRangeComparisonRecord[]) {
  const available = rows.filter((row) => row.canonicalAllowed != null && row.rollingAllowed != null);
  return {
    sampleSize: rows.length,
    available: available.length,
    unavailable: rows.length - available.length,
    agreements: available.filter((row) => row.decisionsMatch === true).length,
    disagreements: available.filter((row) => row.decisionsMatch === false).length,
    canonicalAllowed: available.filter((row) => row.canonicalAllowed === true).length,
    canonicalBlocked: available.filter((row) => row.canonicalAllowed === false).length,
    winnersPreserved: available.filter((row) => row.outcome === "won" && row.canonicalAllowed === true).length,
    winnersBlocked: available.filter((row) => row.outcome === "won" && row.canonicalAllowed === false).length,
    poorEntriesRejected: available.filter((row) => row.outcome === "lost" && row.canonicalAllowed === false).length,
    poorEntriesAllowed: available.filter((row) => row.outcome === "lost" && row.canonicalAllowed === true).length,
  };
}

export function buildLast100Comparison(closed: Record<string, any>[], rejected: Record<string, any>[]) {
  const rows = [
    ...closed.map(comparisonRecordFromClosed),
    ...rejected.map(comparisonRecordFromRejected),
  ].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 100);
  return { summary: summarizeDealingRangeComparison(rows), rows };
}
