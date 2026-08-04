export interface RejectedSetupAnalyticsRecord {
  id: string;
  rejected_at: string;
  symbol: string;
  direction: string;
  rejection_type: string;
  session_name?: string | null;
  failed_gates?: string[] | null;
  normalized_gates?: string[] | null;
  opportunity_key?: string | null;
  outcome_status: string;
}

export type CollapsedRejectedSetup<T extends RejectedSetupAnalyticsRecord> = T & {
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  normalized_gates: string[];
  mixed_outcome: boolean;
};

export const NORMALIZED_GATE_LABELS: Record<string, string> = {
  duplicate_position: "Duplicate Position",
  direction_verdict: "HTF Bias",
  htf_alignment: "HTF Alignment",
  premium_discount: "Premium/Discount Location",
  structural_conviction: "Structural Conviction",
  reaction_confirmation: "Reaction Confirmation",
  instrument_disabled: "Instrument Disabled",
  portfolio_heat: "Portfolio Heat",
  consecutive_loss_limit: "Consecutive-Loss Limit",
  high_impact_news: "High-Impact News",
  news_alignment: "News Alignment",
  smt_veto: "SMT Veto",
  minimum_score: "Minimum Score",
  invalid_sl_tp: "Invalid SL/TP",
  max_positions: "Max Positions",
  max_per_symbol: "Max Per Symbol",
  cooldown: "Cooldown",
  gameplan_alignment: "Gameplan Alignment",
  correlation: "Correlation",
  opening_range: "Opening Range",
  kill_zone: "Kill Zone",
  minimum_risk_reward: "Minimum Risk/Reward",
  atr_volatility: "ATR Volatility",
  tier1_minimum: "Tier 1 Minimum",
  market_regime: "Market Regime",
  spread: "Spread",
  daily_loss_limit: "Daily-Loss Limit",
  drawdown_limit: "Drawdown Limit",
};

export function normalizeRejectedGate(reason: string): string {
  const gate = reason.trim().toLowerCase();
  if (gate.includes("already long") || gate.includes("already short") || gate.includes("duplicate")) return "duplicate_position";
  if (gate.includes("direction blocked")) return "direction_verdict";
  if (gate.includes("htf hard veto") || gate.includes("htf bias mismatch") || gate.includes("htf regime veto")) return "htf_alignment";
  if (gate.includes("buying in premium") || gate.includes("selling in discount")) return "premium_discount";
  if (gate.includes("structural conviction blocked")) return "structural_conviction";
  if (gate.includes("reaction confirmation blocked")) return "reaction_confirmation";
  if (gate.includes("not in enabled instruments")) return "instrument_disabled";
  if (gate.includes("portfolio heat")) return "portfolio_heat";
  if (gate.includes("consecutive losses")) return "consecutive_loss_limit";
  if (gate.includes("news filter") || gate.includes("high-impact event")) return "high_impact_news";
  if (gate.includes("news conflict")) return "news_alignment";
  if (gate.includes("smt")) return "smt_veto";
  if (gate.includes("score") && (gate.includes("threshold") || gate.includes("<"))) return "minimum_score";
  if (gate.includes("valid sl/tp") || gate.includes("no valid sl") || gate.includes("no valid tp")) return "invalid_sl_tp";
  if (gate.includes("max positions")) return "max_positions";
  if (gate.includes("max per symbol")) return "max_per_symbol";
  if (gate.includes("cooldown")) return "cooldown";
  if (gate.includes("gp alignment") || gate.includes("game plan") || gate.includes("gameplan")) return "gameplan_alignment";
  if (gate.includes("correlation") || gate.includes("correlated") || gate.includes("hedge conflict")) return "correlation";
  if (gate.includes("or not complete")) return "opening_range";
  if (gate.includes("kill zone only")) return "kill_zone";
  if (gate.includes("risk:reward") || gate.includes("risk/reward") || gate.includes("r:r")) return "minimum_risk_reward";
  if (gate.includes("atr") && gate.includes("volatil")) return "atr_volatility";
  if (gate.includes("tier 1") || gate.includes("tier1")) return "tier1_minimum";
  if (gate.includes("regime")) return "market_regime";
  if (gate.includes("spread")) return "spread";
  if (gate.includes("daily loss") || gate.includes("daily net p&l")) return "daily_loss_limit";
  if (gate.includes("drawdown")) return "drawdown_limit";
  return gate
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/[^a-z#]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "other";
}

export function normalizedGateLabel(code: string): string {
  return NORMALIZED_GATE_LABELS[code]
    || code.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function gateCodes(record: RejectedSetupAnalyticsRecord): string[] {
  const stored = record.normalized_gates?.filter(Boolean) || [];
  const normalized = stored.length > 0
    ? stored
    : (record.failed_gates || []).map(normalizeRejectedGate);
  return [...new Set(normalized)].sort();
}

function baseOpportunityKey(record: RejectedSetupAnalyticsRecord): string {
  if (record.opportunity_key) return record.opportunity_key;
  return [
    record.symbol,
    record.direction,
    record.rejection_type,
    record.session_name || "unknown_session",
    gateCodes(record).join("+") || "no_gate",
  ].join("|").toLowerCase();
}

/**
 * Collapse repeated scanner observations into market opportunities.
 *
 * Records with the same stable setup key are one opportunity while consecutive
 * observations remain within `gapMinutes`. A later observation beyond that gap
 * starts a new opportunity.
 */
export function collapseRejectedOpportunities<T extends RejectedSetupAnalyticsRecord>(
  records: T[],
  gapMinutes = 60,
): Array<CollapsedRejectedSetup<T>> {
  const sorted = [...records].sort(
    (a, b) => Date.parse(a.rejected_at) - Date.parse(b.rejected_at),
  );
  const groups: Array<{
    key: string;
    records: T[];
    firstMs: number;
    lastMs: number;
  }> = [];
  const latestByKey = new Map<string, typeof groups[number]>();
  const gapMs = gapMinutes * 60_000;

  for (const record of sorted) {
    const key = baseOpportunityKey(record);
    const timestamp = Date.parse(record.rejected_at);
    const latest = latestByKey.get(key);
    if (latest && Number.isFinite(timestamp) && timestamp - latest.lastMs <= gapMs) {
      latest.records.push(record);
      latest.lastMs = timestamp;
      continue;
    }
    const group = {
      key,
      records: [record],
      firstMs: timestamp,
      lastMs: timestamp,
    };
    groups.push(group);
    latestByKey.set(key, group);
  }

  return groups.map((group) => {
    const representative = group.records[0];
    const resolved = new Set(
      group.records
        .map((record) => record.outcome_status)
        .filter((status) => status === "would_have_won" || status === "would_have_lost"),
    );
    const mixedOutcome = resolved.size > 1;
    const collapsedOutcome = mixedOutcome
      ? "inconclusive"
      : resolved.size === 1
        ? [...resolved][0]
        : representative.outcome_status;

    return {
      ...representative,
      outcome_status: collapsedOutcome,
      occurrence_count: group.records.length,
      first_seen_at: new Date(group.firstMs).toISOString(),
      last_seen_at: new Date(group.lastMs).toISOString(),
      normalized_gates: gateCodes(representative),
      mixed_outcome: mixedOutcome,
    };
  }).sort((a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at));
}
