import type { CanonicalScannerStage, CanonicalScannerState } from "./canonicalScannerState.ts";

export type WorkflowDecision = "allow" | "watch" | "block";

function object(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

function stateFrom(row: Record<string, any>, source: "closed" | "rejected"): CanonicalScannerState | null {
  const payload = source === "closed" ? object(row.signal_reason) : object(row.raw_detail);
  const candidates = [
    payload.canonicalScannerState,
    object(payload.finalAuthorization).canonicalScannerState,
    object(payload.authorization).canonicalScannerState,
    object(payload.tradeDecisionPresentation).canonicalScannerState,
  ];
  const state = candidates.map(object).find((item) => item.contractVersion === "canonical-scanner-state.v1");
  return state ? state as unknown as CanonicalScannerState : null;
}

export function workflowDecisionForStage(stage: CanonicalScannerStage): WorkflowDecision {
  if (["authorized", "entered", "managing", "closed"].includes(stage)) return "allow";
  if (["blocked", "invalidated", "expired"].includes(stage)) return "block";
  return "watch";
}

function outcomeFor(row: Record<string, any>, source: "closed" | "rejected") {
  if (source === "closed") {
    const pnl = Number(row.pnl);
    return pnl > 0 ? "won" : pnl < 0 ? "lost" : "inconclusive";
  }
  return row.outcome_status === "would_have_won" ? "won"
    : row.outcome_status === "would_have_lost" ? "lost" : "inconclusive";
}

export function buildCanonicalScannerComparison(closed: Record<string, any>[], rejected: Record<string, any>[]) {
  const rows = [
    ...closed.map((row) => ({ row, source: "closed" as const })),
    ...rejected.map((row) => ({ row, source: "rejected" as const })),
  ].map(({ row, source }) => {
    const state = stateFrom(row, source);
    const actualDecision = source === "closed" ? "allow" as const : "block" as const;
    const workflowDecision = state ? workflowDecisionForStage(state.stage) : null;
    const missingAuthorities = state?.authorities
      .filter((item) => !item.available)
      .map((item) => item.role) || [];
    const comparable = state !== null;
    const decisionsMatch = comparable ? workflowDecision === actualDecision : null;
    return {
      id: String(row.id), source, symbol: String(row.symbol || ""),
      direction: String(row.direction || ""),
      observedAt: String(row.closed_at || row.rejected_at || row.created_at || ""),
      outcome: outcomeFor(row, source), actualDecision, workflowDecision,
      stage: state?.stage || null, reasonCode: state?.reasonCode || null,
      explanation: state?.explanation || null, comparable, decisionsMatch,
      missingAuthorities, authorities: state?.authorities || [], state,
    };
  }).sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 100);

  const comparable = rows.filter((row) => row.comparable);
  const stageCounts = Object.fromEntries(comparable.reduce((counts, row) => {
    const stage = row.stage || "unavailable";
    counts.set(stage, (counts.get(stage) || 0) + 1);
    return counts;
  }, new Map<string, number>()));
  const workflowAllows = (row: typeof comparable[number]) => row.workflowDecision === "allow";
  return {
    summary: {
      sampleSize: rows.length, comparable: comparable.length,
      unavailable: rows.length - comparable.length,
      coveragePercent: rows.length ? Math.round(comparable.length / rows.length * 1000) / 10 : 0,
      agreements: comparable.filter((row) => row.decisionsMatch).length,
      disagreements: comparable.filter((row) => row.decisionsMatch === false).length,
      workflowAllows: comparable.filter((row) => row.workflowDecision === "allow").length,
      workflowWatches: comparable.filter((row) => row.workflowDecision === "watch").length,
      workflowBlocks: comparable.filter((row) => row.workflowDecision === "block").length,
      winnersPreserved: comparable.filter((row) => row.outcome === "won" && workflowAllows(row)).length,
      winnersBlocked: comparable.filter((row) => row.outcome === "won" && !workflowAllows(row)).length,
      poorEntriesRejected: comparable.filter((row) => row.outcome === "lost" && row.workflowDecision === "block").length,
      poorEntriesWatched: comparable.filter((row) => row.outcome === "lost" && row.workflowDecision === "watch").length,
      poorEntriesAllowed: comparable.filter((row) => row.outcome === "lost" && workflowAllows(row)).length,
      stageCounts,
    },
    rows,
  };
}
