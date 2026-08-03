import type { TradeDecisionSummary } from "./streamlinedTradeDecision.ts";

export interface StreamlinedReplayRow {
  id: string;
  source: "closed" | "rejected";
  symbol: string;
  direction: string;
  observedAt: string;
  outcome: "won" | "lost" | "inconclusive";
  currentDecision: "allow" | "block";
  proposedDecision: TradeDecisionSummary["proposedDecision"]["decision"] | null;
  comparable: boolean;
  disagreementReasons: string[];
  summary: TradeDecisionSummary | null;
}

function object(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

function summaryFrom(row: Record<string, any>): TradeDecisionSummary | null {
  const payload = object(row.streamlined_decision_origin).summary ||
    object(object(row.signal_reason).streamlinedDecisionOrigin).summary ||
    object(object(row.raw_detail).streamlinedDecisionOrigin).summary ||
    object(row.raw_detail).streamlinedTradeDecision;
  return payload?.contractVersion === "streamlined-trade-decision.v1"
    ? payload as TradeDecisionSummary
    : null;
}

function replayRow(row: Record<string, any>, source: "closed" | "rejected"): StreamlinedReplayRow {
  const summary = summaryFrom(row);
  const currentDecision = source === "closed" ? "allow" : "block";
  const proposedDecision = summary?.proposedDecision.decision ?? null;
  const comparable = summary?.completeness.complete === true &&
    (proposedDecision === "allow" || proposedDecision === "block");
  const proposedAllowed = proposedDecision === "allow";
  const decisionsMatch = comparable && proposedAllowed === (currentDecision === "allow");
  const pnl = Number(row.pnl);
  const outcome = source === "closed"
    ? (pnl > 0 ? "won" : pnl < 0 ? "lost" : "inconclusive")
    : row.outcome_status === "would_have_won" ? "won"
    : row.outcome_status === "would_have_lost" ? "lost" : "inconclusive";
  return {
    id: String(row.id), source, symbol: String(row.symbol || ""),
    direction: String(row.direction || ""),
    observedAt: String(row.closed_at || row.rejected_at || row.created_at || ""),
    outcome, currentDecision, proposedDecision, comparable,
    disagreementReasons: decisionsMatch || !summary
      ? []
      : summary.proposedDecision.reasonCodes,
    summary,
  };
}

export function buildStreamlinedReplay(closed: Record<string, any>[], rejected: Record<string, any>[]) {
  const rows = [
    ...closed.map((row) => replayRow(row, "closed")),
    ...rejected.map((row) => replayRow(row, "rejected")),
  ].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 100);
  const comparable = rows.filter((row) => row.comparable);
  const agrees = (row: StreamlinedReplayRow) =>
    (row.proposedDecision === "allow") === (row.currentDecision === "allow");
  return { summary: {
    sampleSize: rows.length,
    comparable: comparable.length,
    unavailable: rows.length - comparable.length,
    agreements: comparable.filter(agrees).length,
    disagreements: comparable.filter((row) => !agrees(row)).length,
    winnersPreserved: comparable.filter((row) => row.outcome === "won" && row.proposedDecision === "allow").length,
    winnersBlocked: comparable.filter((row) => row.outcome === "won" && row.proposedDecision === "block").length,
    poorEntriesRejected: comparable.filter((row) => row.outcome === "lost" && row.proposedDecision === "block").length,
    poorEntriesAllowed: comparable.filter((row) => row.outcome === "lost" && row.proposedDecision === "allow").length,
    coveragePercent: rows.length ? Math.round(comparable.length / rows.length * 1000) / 10 : 0,
  }, rows };
}
