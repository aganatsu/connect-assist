export type AuthorityGateOwner =
  | "legacy_diagnostic"
  | "direction"
  | "zone_story"
  | "canonical_location"
  | "confirmation"
  | "thesis"
  | "operational_safety"
  | "unclassified";

const OWNERS: Record<string, AuthorityGateOwner> = {
  minimum_score: "legacy_diagnostic",
  tier1_minimum: "legacy_diagnostic",
  structural_conviction: "legacy_diagnostic",
  reaction_confirmation: "legacy_diagnostic",
  smt_veto: "legacy_diagnostic",
  market_regime: "legacy_diagnostic",
  news_alignment: "legacy_diagnostic",
  gameplan_alignment: "legacy_diagnostic",
  htf_alignment: "legacy_diagnostic",
  opening_range: "legacy_diagnostic",
  kill_zone: "legacy_diagnostic",
  atr_volatility: "legacy_diagnostic",
  conflict_count: "legacy_diagnostic",
  ict_judas: "legacy_diagnostic",
  ict_fvg_invalidation: "legacy_diagnostic",
  ict_mss: "legacy_diagnostic",
  ict_kill_zone: "legacy_diagnostic",
  impulse_zone_score: "legacy_diagnostic",
  premium_discount: "canonical_location",
  direction_verdict: "direction",
  zone_story: "zone_story",
  confirmation: "confirmation",
  thesis: "thesis",
  instrument_disabled: "operational_safety",
  max_positions: "operational_safety",
  max_per_symbol: "operational_safety",
  duplicate_position: "operational_safety",
  portfolio_heat: "operational_safety",
  daily_loss_limit: "operational_safety",
  drawdown_limit: "operational_safety",
  consecutive_loss_limit: "operational_safety",
  cooldown: "operational_safety",
  high_impact_news: "operational_safety",
  correlation: "operational_safety",
  minimum_risk_reward: "operational_safety",
  spread: "operational_safety",
  invalid_sl_tp: "operational_safety",
  account: "operational_safety",
  execution_mode: "operational_safety",
  freshness: "operational_safety",
  prop_firm: "operational_safety",
  cross_timeframe_authority: "zone_story",
};

export function authorityGateOwner(code: string): AuthorityGateOwner {
  return OWNERS[code] ?? "unclassified";
}

export function isLegacyDiagnosticGate(code: string): boolean {
  return authorityGateOwner(code) === "legacy_diagnostic";
}

export function evaluateAuthorityGateDisposition(input: {
  code: string;
  passed: boolean;
  requestedMode?: unknown;
  runtimeTarget: "paper" | "live";
}) {
  const owner = authorityGateOwner(input.code);
  const diagnosticOnly = input.requestedMode === "enforce" &&
    input.runtimeTarget === "paper" && owner === "legacy_diagnostic";
  return {
    code: input.code, owner, passed: input.passed, diagnosticOnly,
    blocksAuthorization: !input.passed && !diagnosticOnly,
  };
}

export function classifyAuthorityGates(
  checks: Array<{ code: string; passed: boolean; reason?: string }>,
) {
  return checks.map((check) => ({
    ...check,
    owner: authorityGateOwner(check.code),
    affectsSingleOwnershipAuthorization: !isLegacyDiagnosticGate(check.code),
  }));
}
