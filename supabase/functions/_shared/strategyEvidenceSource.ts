import type {
  StrategyEvidenceFeature,
  StrategyEvidenceObservation,
  StrategyEvidenceOutcome,
} from "./strategyEvidenceCertificate.ts";

type UnknownRecord = Record<string, unknown>;

export interface StrategyEvidenceRejectedRow {
  id: string;
  symbol: string;
  direction: string;
  rejection_type: string;
  session_name?: string | null;
  failed_gates?: string[] | null;
  opportunity_key?: string | null;
  outcome_status: string;
  confluence_score: number | string | null;
  rr_ratio?: number | string | null;
  shadow_decision?: unknown;
  raw_detail?: unknown;
  rejected_at: string;
}

export interface StrategyEvidenceTradeRow {
  id: string;
  position_id?: string | null;
  symbol: string;
  direction: string;
  pnl: number | string | null;
  size?: number | string | null;
  entry_price?: number | string | null;
  exit_price?: number | string | null;
  stop_loss?: number | string | null;
  signal_score: number | string | null;
  signal_reason: string | null;
  close_reason: string;
  closed_at: string;
}

export interface StrategyEvidenceSourceResult {
  totalCandidates: number;
  observations: StrategyEvidenceObservation[];
  sourceWindow: {
    start: string | null;
    end: string | null;
  };
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
    const record = parseRecord(value);
    if (record) return record;
  }
  return null;
}

function styleFromPayload(payload: UnknownRecord | null): string {
  const style = valueAt(payload, "stylePolicy", "style") ??
    valueAt(payload, "frozenStrategyContext", "stylePolicy", "style") ??
    valueAt(payload, "decisionContext", "stylePolicy", "style");
  return typeof style === "string" && style.length > 0 ? style : "unknown";
}

function thesisFromPayload(
  payload: UnknownRecord | null,
): UnknownRecord | null {
  return firstRecord(
    payload?.thesisConviction,
    valueAt(payload, "decisionContext", "thesisConviction", "evidence"),
  );
}

function thresholdFromPayload(payload: UnknownRecord | null): number | null {
  return finiteNumber(
    valueAt(payload, "shadowEvaluation", "threshold") ??
      valueAt(
        payload,
        "stylePolicy",
        "qualification",
        "effectiveMinConfluence",
      ) ??
      valueAt(
        payload,
        "frozenStrategyContext",
        "stylePolicy",
        "qualification",
        "effectiveMinConfluence",
      ) ??
      valueAt(
        payload,
        "decisionContext",
        "stylePolicy",
        "qualification",
        "effectiveMinConfluence",
      ),
  );
}

function rejectedOutcome(status: string): StrategyEvidenceOutcome {
  if (status === "would_have_won") return "win";
  if (status === "would_have_lost") return "loss";
  return "inconclusive";
}

function rejectedOutcomeR(row: StrategyEvidenceRejectedRow): number | null {
  if (row.outcome_status === "would_have_lost") return -1;
  if (row.outcome_status !== "would_have_won") return null;
  return Math.max(0.1, finiteNumber(row.rr_ratio) ?? 2);
}

function rejectionKey(row: StrategyEvidenceRejectedRow): string {
  if (row.opportunity_key) return row.opportunity_key;
  return [
    row.symbol,
    row.direction,
    row.rejection_type,
    row.session_name || "unknown_session",
    [...(row.failed_gates || [])].sort().join("+"),
  ].join("|").toLowerCase();
}

function collapseRejections(
  rows: StrategyEvidenceRejectedRow[],
): StrategyEvidenceRejectedRow[] {
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.rejected_at) - Date.parse(b.rejected_at)
  );
  const latest = new Map<
    string,
    {
      representative: StrategyEvidenceRejectedRow;
      lastMs: number;
      outcomes: Set<string>;
    }
  >();
  const groups: Array<{
    representative: StrategyEvidenceRejectedRow;
    lastMs: number;
    outcomes: Set<string>;
  }> = [];
  const gapMs = 60 * 60_000;

  for (const row of sorted) {
    const key = rejectionKey(row);
    const timestamp = Date.parse(row.rejected_at);
    const existing = latest.get(key);
    if (
      existing && Number.isFinite(timestamp) &&
      timestamp - existing.lastMs <= gapMs
    ) {
      existing.lastMs = timestamp;
      existing.outcomes.add(row.outcome_status);
      continue;
    }
    const group = {
      representative: row,
      lastMs: timestamp,
      outcomes: new Set([row.outcome_status]),
    };
    groups.push(group);
    latest.set(key, group);
  }

  return groups.map((group) => {
    const resolved = [...group.outcomes].filter((status) =>
      status === "would_have_won" || status === "would_have_lost"
    );
    return {
      ...group.representative,
      outcome_status: new Set(resolved).size > 1
        ? "inconclusive"
        : resolved[0] || group.representative.outcome_status,
    };
  });
}

interface CollapsedTrade {
  id: string;
  positionId: string;
  symbol: string;
  direction: string;
  pnl: number;
  outcomeR: number;
  signalScore: number | null;
  payload: UnknownRecord | null;
  observedAt: string;
  hasTerminalClose: boolean;
}

function rowRMultiple(row: StrategyEvidenceTradeRow): number {
  const entry = finiteNumber(row.entry_price);
  const exit = finiteNumber(row.exit_price);
  const stop = finiteNumber(row.stop_loss);
  if (entry !== null && exit !== null && stop !== null) {
    const risk = Math.abs(entry - stop);
    if (risk > 0) {
      const move = row.direction.toLowerCase() === "long"
        ? exit - entry
        : entry - exit;
      return move / risk;
    }
  }
  const pnl = finiteNumber(row.pnl) ?? 0;
  return pnl > 0 ? 1 : pnl < 0 ? -1 : 0;
}

function collapseTrades(rows: StrategyEvidenceTradeRow[]): CollapsedTrade[] {
  const grouped = new Map<
    string,
    CollapsedTrade & { weightedR: number; weight: number }
  >();
  for (const row of rows) {
    const rawKey = row.position_id || row.id;
    const key = rawKey.endsWith("_partial")
      ? rawKey.slice(0, -"_partial".length)
      : rawKey;
    const pnl = finiteNumber(row.pnl) ?? 0;
    const payload = parseRecord(row.signal_reason);
    const weight = Math.max(0.000001, Math.abs(finiteNumber(row.size) ?? 1));
    const weightedR = rowRMultiple(row) * weight;
    const existing = grouped.get(key);
    if (existing) {
      existing.pnl += pnl;
      existing.weightedR += weightedR;
      existing.weight += weight;
      existing.outcomeR = existing.weightedR / existing.weight;
      existing.hasTerminalClose ||= row.close_reason !== "partial_tp";
      if (!existing.payload && payload) existing.payload = payload;
      if (existing.signalScore === null) {
        existing.signalScore = finiteNumber(row.signal_score);
      }
      if (Date.parse(row.closed_at) > Date.parse(existing.observedAt)) {
        existing.observedAt = row.closed_at;
      }
      continue;
    }
    grouped.set(key, {
      id: row.id,
      positionId: key,
      symbol: row.symbol,
      direction: row.direction,
      pnl,
      outcomeR: weightedR / weight,
      signalScore: finiteNumber(row.signal_score),
      payload,
      observedAt: row.closed_at,
      hasTerminalClose: row.close_reason !== "partial_tp",
      weightedR,
      weight,
    });
  }
  return [...grouped.values()].filter((trade) => trade.hasTerminalClose);
}

function pushGameplanObservation(
  observations: StrategyEvidenceObservation[],
  input: {
    sourceId: string;
    source: "rejected_setup" | "closed_trade";
    observedAt: string;
    symbol: string;
    style: string;
    currentDecision: "allow" | "block";
    outcome: StrategyEvidenceOutcome;
    outcomeR: number | null;
    audit: UnknownRecord | null;
  },
) {
  const auditDecision = input.audit?.decision;
  if (
    auditDecision !== "eligible" && auditDecision !== "wait" &&
    auditDecision !== "skip"
  ) return;
  observations.push({
    feature: "gameplan_hierarchy",
    sourceId: input.sourceId,
    source: input.source,
    observedAt: input.observedAt,
    symbol: input.symbol,
    style: input.style,
    currentDecision: input.currentDecision,
    proposedDecision: auditDecision === "eligible" ? "allow" : "block",
    outcome: input.outcome,
    outcomeR: input.outcomeR,
  });
}

function pushThesisObservation(
  observations: StrategyEvidenceObservation[],
  input: {
    sourceId: string;
    source: "rejected_setup" | "closed_trade";
    observedAt: string;
    symbol: string;
    style: string;
    currentDecision: "allow" | "block";
    outcome: StrategyEvidenceOutcome;
    outcomeR: number | null;
    payload: UnknownRecord | null;
    score: number | null;
    mayPromote: boolean;
  },
) {
  const thesis = thesisFromPayload(input.payload);
  const adjustment = finiteNumber(thesis?.scoreAdjustment);
  const threshold = thresholdFromPayload(input.payload);
  if (
    adjustment === null || threshold === null || input.score === null
  ) return;
  const proposedDecision = input.currentDecision === "block" &&
      !input.mayPromote
    ? "block"
    : input.score + adjustment >= threshold
    ? "allow"
    : "block";
  observations.push({
    feature: "thesis_conviction",
    sourceId: input.sourceId,
    source: input.source,
    observedAt: input.observedAt,
    symbol: input.symbol,
    style: input.style,
    currentDecision: input.currentDecision,
    proposedDecision,
    outcome: input.outcome,
    outcomeR: input.outcomeR,
  });
}

export function buildStrategyEvidenceSource(
  rejectedRows: StrategyEvidenceRejectedRow[],
  tradeRows: StrategyEvidenceTradeRow[],
): StrategyEvidenceSourceResult {
  const rejected = collapseRejections(rejectedRows);
  const trades = collapseTrades(tradeRows);
  const observations: StrategyEvidenceObservation[] = [];

  for (const row of rejected) {
    const payload = parseRecord(row.raw_detail);
    const style = styleFromPayload(payload);
    const outcome = rejectedOutcome(row.outcome_status);
    const outcomeR = rejectedOutcomeR(row);
    const audit = firstRecord(
      row.shadow_decision,
      payload?.gamePlanShadowAudit,
    );
    pushGameplanObservation(observations, {
      sourceId: row.id,
      source: "rejected_setup",
      observedAt: row.rejected_at,
      symbol: row.symbol,
      style,
      currentDecision: "block",
      outcome,
      outcomeR,
      audit,
    });
    const score = finiteNumber(
      valueAt(payload, "shadowEvaluation", "effectiveScore"),
    ) ?? finiteNumber(row.confluence_score);
    pushThesisObservation(observations, {
      sourceId: row.id,
      source: "rejected_setup",
      observedAt: row.rejected_at,
      symbol: row.symbol,
      style,
      currentDecision: "block",
      outcome,
      outcomeR,
      payload,
      score,
      mayPromote: row.rejection_type === "below_threshold_strong_t1",
    });
  }

  for (const trade of trades) {
    const style = styleFromPayload(trade.payload);
    const outcome: StrategyEvidenceOutcome = trade.pnl > 0
      ? "win"
      : trade.pnl < 0
      ? "loss"
      : "inconclusive";
    const audit = firstRecord(
      trade.payload?.gamePlanShadowAudit,
      valueAt(trade.payload, "gamePlanSnapshot", "shadowAudit"),
    );
    pushGameplanObservation(observations, {
      sourceId: trade.positionId,
      source: "closed_trade",
      observedAt: trade.observedAt,
      symbol: trade.symbol,
      style,
      currentDecision: "allow",
      outcome,
      outcomeR: Number.isFinite(trade.outcomeR) ? trade.outcomeR : null,
      audit,
    });
    pushThesisObservation(observations, {
      sourceId: trade.positionId,
      source: "closed_trade",
      observedAt: trade.observedAt,
      symbol: trade.symbol,
      style,
      currentDecision: "allow",
      outcome,
      outcomeR: Number.isFinite(trade.outcomeR) ? trade.outcomeR : null,
      payload: trade.payload,
      score: trade.signalScore,
      mayPromote: true,
    });
  }

  const timestamps = [
    ...rejected.map((row) => row.rejected_at),
    ...trades.map((trade) => trade.observedAt),
  ].filter((value) => Number.isFinite(Date.parse(value))).sort();

  return {
    totalCandidates: rejected.length + trades.length,
    observations,
    sourceWindow: {
      start: timestamps[0] || null,
      end: timestamps.at(-1) || null,
    },
  };
}

export function observationsForFeature(
  source: StrategyEvidenceSourceResult,
  feature: StrategyEvidenceFeature,
): StrategyEvidenceObservation[] {
  return source.observations.filter((item) => item.feature === feature);
}
