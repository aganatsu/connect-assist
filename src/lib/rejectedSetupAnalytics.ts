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
  outcome_reason?: string | null;
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

export interface RejectedOutcomeDistributionItem {
  key: string;
  name: string;
  value: number;
  color: string;
  description: string;
}

const OUTCOME_BUCKETS = {
  would_have_won: { name: "Would Have Won", color: "#22c55e", description: "The simulated trade reached its target before its stop." },
  would_have_lost: { name: "Would Have Lost", color: "#ef4444", description: "The simulated trade reached its stop before its target." },
  awaiting_entry: { name: "Developing: Waiting for Entry", color: "#f59e0b", description: "The frozen outcome window is still open and price has not reached entry." },
  position_open: { name: "Developing: Entry Reached", color: "#eab308", description: "Entry was reached, but neither target nor stop has resolved the setup yet." },
  data_retry: { name: "Data Unavailable: Retrying", color: "#0ea5e9", description: "The historical candle request was unavailable; the tracker will retry on a later run." },
  entry_not_reached: { name: "No Entry Before Expiry", color: "#64748b", description: "Price never reached the planned entry before the frozen outcome window ended." },
  open_at_horizon: { name: "Open at Window End", color: "#8b5cf6", description: "Entry was reached, but neither target nor stop was hit before the window ended." },
  ambiguous: { name: "Ambiguous Candle", color: "#a855f7", description: "Candle data cannot prove whether entry, target, or stop happened first." },
  mixed: { name: "Mixed Repeat Outcomes", color: "#ec4899", description: "Repeated scanner observations for one opportunity resolved differently." },
  legacy_inconclusive: { name: "Legacy Result Awaiting Replay", color: "#6b7280", description: "This older result does not yet carry a precise terminal reason." },
} as const;

export function rejectedOutcomeBucket(record: Pick<RejectedSetupAnalyticsRecord, "outcome_status" | "outcome_reason">): keyof typeof OUTCOME_BUCKETS {
  if (record.outcome_status === "would_have_won") return "would_have_won";
  if (record.outcome_status === "would_have_lost") return "would_have_lost";
  if (record.outcome_reason === "mixed_repeated_observations") return "mixed";
  if (record.outcome_reason === "ambiguous_entry_candle" || record.outcome_reason === "ambiguous_same_candle") return "ambiguous";
  if (record.outcome_status === "pending") {
    if (record.outcome_reason === "candle_data_unavailable" || record.outcome_reason === "tracking_error") return "data_retry";
    return record.outcome_reason === "position_open" ? "position_open" : "awaiting_entry";
  }
  if (record.outcome_reason === "entry_not_reached") return "entry_not_reached";
  if (record.outcome_reason === "open_at_horizon") return "open_at_horizon";
  return "legacy_inconclusive";
}

export function rejectedOutcomeLabel(record: Pick<RejectedSetupAnalyticsRecord, "outcome_status" | "outcome_reason">): string {
  return OUTCOME_BUCKETS[rejectedOutcomeBucket(record)].name;
}

export function buildRejectedOutcomeDistribution(records: Array<Pick<RejectedSetupAnalyticsRecord, "outcome_status" | "outcome_reason">>): RejectedOutcomeDistributionItem[] {
  const counts = new Map<keyof typeof OUTCOME_BUCKETS, number>();
  for (const record of records) {
    const key = rejectedOutcomeBucket(record);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (Object.keys(OUTCOME_BUCKETS) as Array<keyof typeof OUTCOME_BUCKETS>)
    .map((key) => ({ key, ...OUTCOME_BUCKETS[key], value: counts.get(key) || 0 }))
    .filter((bucket) => bucket.value > 0);
}

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

export function uniqueRejectionReasons(
  gates: Array<{ passed?: boolean; reason?: string }> | null | undefined,
  reasons: string[] | null | undefined,
): string[] {
  const failedCodes = new Set(
    (gates || [])
      .filter((gate) => gate?.passed === false && gate.reason)
      .map((gate) => normalizeRejectedGate(String(gate.reason))),
  );
  const seen = new Set<string>();
  const visible: string[] = [];
  for (const reason of reasons || []) {
    const code = normalizeRejectedGate(String(reason));
    if (failedCodes.has(code) || seen.has(code)) continue;
    seen.add(code);
    visible.push(reason);
  }
  return visible;
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
    const resolvedRecord = [...group.records].reverse().find(
      (record) => record.outcome_status === "would_have_won" || record.outcome_status === "would_have_lost",
    );
    const collapsedOutcome = mixedOutcome
      ? "inconclusive"
      : resolved.size === 1
        ? [...resolved][0]
        : representative.outcome_status;

    return {
      ...representative,
      outcome_status: collapsedOutcome,
      outcome_reason: mixedOutcome
        ? "mixed_repeated_observations"
        : resolvedRecord?.outcome_reason ?? representative.outcome_reason ?? null,
      occurrence_count: group.records.length,
      first_seen_at: new Date(group.firstMs).toISOString(),
      last_seen_at: new Date(group.lastMs).toISOString(),
      normalized_gates: gateCodes(representative),
      mixed_outcome: mixedOutcome,
    };
  }).sort((a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at));
}
