import type {
  SingleOwnershipDecisionResult,
} from "./singleOwnershipDecision.ts";

function object(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return object(parsed);
  } catch {
    return {};
  }
}

function decisionFrom(row: Record<string, any>) {
  const payload = row.source === "closed"
    ? object(row.signal_reason)
    : object(row.raw_detail);
  const decision = object(payload.singleOwnershipDecision);
  return decision.contractVersion === "single-ownership-decision.v1"
    ? decision as unknown as SingleOwnershipDecisionResult
    : null;
}

export function buildSingleOwnershipComparison(
  closed: Record<string, any>[],
  rejected: Record<string, any>[],
) {
  const sourcedRows: Array<
    Record<string, any> & { source: "closed" | "rejected" }
  > = [
    ...closed.map((row) => ({ ...row, source: "closed" as const })),
    ...rejected.map((row) => ({ ...row, source: "rejected" as const })),
  ];
  const rows = sourcedRows.map((row) => {
    const observation = decisionFrom(row);
    const legacyDecision = row.source === "closed" ? "allow" : "block";
    const proposedDecision = observation?.decision ?? null;
    const comparable = observation?.completeness.complete === true &&
      (proposedDecision === "allow" || proposedDecision === "block");
    const decisionsMatch = comparable
      ? (proposedDecision === "allow") === (legacyDecision === "allow")
      : null;
    const pnl = Number(row.pnl);
    const outcome = row.source === "closed"
      ? pnl > 0 ? "won" : pnl < 0 ? "lost" : "inconclusive"
      : row.outcome_status === "would_have_won" ? "won"
      : row.outcome_status === "would_have_lost" ? "lost"
      : "inconclusive";
    return {
      id: String(row.id), source: row.source,
      symbol: String(row.symbol || ""), direction: String(row.direction || ""),
      observedAt: String(row.closed_at || row.rejected_at || row.created_at || ""),
      legacyDecision, proposedDecision, comparable, decisionsMatch, outcome,
      reasonCodes: observation?.reasonCodes || [],
      unavailable: observation?.completeness.unavailable || [],
      legacyDiagnostics: observation?.legacyDiagnostics || null,
    };
  }).sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 100);

  const comparable = rows.filter((row) => row.comparable);
  return {
    summary: {
      sampleSize: rows.length,
      comparable: comparable.length,
      unavailable: rows.length - comparable.length,
      coveragePercent: rows.length
        ? Math.round(comparable.length / rows.length * 1000) / 10
        : 0,
      agreements: comparable.filter((row) => row.decisionsMatch).length,
      disagreements: comparable.filter((row) => row.decisionsMatch === false).length,
      winnersPreserved: comparable.filter((row) => row.outcome === "won" && row.proposedDecision === "allow").length,
      winnersBlocked: comparable.filter((row) => row.outcome === "won" && row.proposedDecision === "block").length,
      poorEntriesRejected: comparable.filter((row) => row.outcome === "lost" && row.proposedDecision === "block").length,
      poorEntriesAllowed: comparable.filter((row) => row.outcome === "lost" && row.proposedDecision === "allow").length,
    },
    rows,
  };
}
