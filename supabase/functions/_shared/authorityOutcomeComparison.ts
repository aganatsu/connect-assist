import { workflowDecisionForStage } from "./canonicalScannerComparison.ts";

type Row = Record<string, any>;
const ROLES = ["direction", "impulse_zone", "location", "liquidity", "confirmation", "thesis", "safety", "execution"] as const;

function object(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

function extract(row: Row, source: "closed" | "rejected") {
  const payload = source === "closed" ? object(row.signal_reason) : object(row.raw_detail);
  const snapshot = object(row.decision_outcome_snapshot);
  const state = object(snapshot.authority).contractVersion === "canonical-scanner-state.v1"
    ? object(snapshot.authority) : object(payload.canonicalScannerState);
  const complete = snapshot.contractVersion === "decision-outcome.v1" && snapshot.compatibility === "complete";
  const compatible = state.contractVersion === "canonical-scanner-state.v1";
  return { snapshot, state, complete, compatible };
}

function outcome(row: Row, source: "closed" | "rejected") {
  if (source === "closed") { const pnl = Number(row.pnl); return pnl > 0 ? "won" : pnl < 0 ? "lost" : "inconclusive"; }
  return row.outcome_status === "would_have_won" ? "won" : row.outcome_status === "would_have_lost" ? "lost" : "inconclusive";
}

export function buildAuthorityOutcomeComparison(closed: Row[], rejected: Row[]) {
  const rows = [...closed.map((row) => ({ row, source: "closed" as const })), ...rejected.map((row) => ({ row, source: "rejected" as const }))]
    .map(({ row, source }) => {
      const evidence = extract(row, source);
      const stage = evidence.compatible ? String(evidence.state.stage) : null;
      const decision = stage ? workflowDecisionForStage(stage as any) : null;
      const authorities = Array.isArray(evidence.state.authorities) ? evidence.state.authorities : [];
      return {
        id: String(row.id), source, symbol: String(row.symbol || ""), direction: String(row.direction || ""),
        observedAt: String(row.closed_at || row.rejected_at || row.created_at || ""), outcome: outcome(row, source),
        outcomeR: Number.isFinite(Number(row.outcome_r)) ? Number(row.outcome_r) : null,
        stage, decision, reasonCode: evidence.state.reasonCode || null, explanation: evidence.state.explanation || null,
        evidenceQuality: evidence.complete ? "complete" : evidence.compatible ? "historical_compatible" : "unavailable",
        authorities,
      };
    }).sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 100);

  const comparable = rows.filter((row) => row.decision !== null);
  const resolved = comparable.filter((row) => row.outcome !== "inconclusive");
  const components = ROLES.map((role) => {
    const observations = resolved.flatMap((row) => {
      const authority = row.authorities.find((item: any) => item.role === role);
      return authority && authority.available && authority.passed !== null ? [{ ...row, passed: authority.passed === true }] : [];
    });
    const passed = observations.filter((item) => item.passed);
    const failed = observations.filter((item) => !item.passed);
    const wins = passed.filter((item) => item.outcome === "won").length;
    const losses = passed.filter((item) => item.outcome === "lost").length;
    const rValues = passed.map((item) => item.outcomeR).filter((value): value is number => value !== null);
    return { role, resolved: observations.length, passed: passed.length, failed: failed.length, wins, losses, winRate: passed.length ? Math.round(wins / passed.length * 1000) / 10 : null, expectancyR: rValues.length ? Math.round(rValues.reduce((sum, value) => sum + value, 0) / rValues.length * 1000) / 1000 : null };
  });
  const allows = (row: typeof comparable[number]) => row.decision === "allow";
  return {
    contractVersion: "authority-outcome-comparison.v1",
    summary: {
      sampleSize: rows.length, complete: rows.filter((row) => row.evidenceQuality === "complete").length,
      historicalCompatible: rows.filter((row) => row.evidenceQuality === "historical_compatible").length,
      unavailable: rows.filter((row) => row.evidenceQuality === "unavailable").length,
      resolved: resolved.length,
      winnersPreserved: resolved.filter((row) => row.outcome === "won" && allows(row)).length,
      winnersBlockedOrWatched: resolved.filter((row) => row.outcome === "won" && !allows(row)).length,
      poorEntriesRejected: resolved.filter((row) => row.outcome === "lost" && row.decision === "block").length,
      poorEntriesWatched: resolved.filter((row) => row.outcome === "lost" && row.decision === "watch").length,
      poorEntriesAllowed: resolved.filter((row) => row.outcome === "lost" && allows(row)).length,
    },
    components, rows,
  };
}
