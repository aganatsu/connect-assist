/**
 * rejectedSetupLogger.ts — Rejected Setup Logging
 * ────────────────────────────────────────────────
 * Logs setups that passed confluence threshold but were blocked by gates,
 * plus below-threshold setups with strong Tier 1 factors (≥2 T1 present).
 *
 * Non-fatal: all operations are wrapped in try/catch. A logging failure
 * must never prevent the scanner from continuing.
 *
 * Run: deno test --allow-all supabase/functions/_shared/rejectedSetupLogger.test.ts
 */

// ── Public types ──

export type RejectionType = "gate_blocked" | "below_threshold_strong_t1";

export interface RejectedSetupParams {
  /** Supabase client instance */
  supabase: any;
  /** User ID */
  userId: string;
  /** Bot ID (default: 'smc') */
  botId?: string;
  /** Symbol (e.g. "EUR/USD") */
  symbol: string;
  /** Trade direction */
  direction: "long" | "short";
  /** Why this setup was rejected */
  rejectionType: RejectionType;
  /** Gate reasons that blocked (for gate_blocked type) */
  failedGates?: string[];
  /** Confluence score achieved */
  confluenceScore: number;
  /** Number of Tier 1 factors present */
  tier1Count: number;
  /** Names of present Tier 1 factors */
  tier1Factors?: string[];
  /** Entry price (zone level or last price) */
  entryPrice: number;
  /** Stop loss level */
  stopLoss?: number;
  /** Take profit level */
  takeProfit?: number;
  /** Risk:Reward ratio */
  rrRatio?: number;
  /** Current session name */
  sessionName?: string;
  /** Market regime */
  regime?: string;
  /** Game plan bias for this pair */
  gpBias?: string;
  /** Game plan bias confidence (0-100) */
  gpBiasConfidence?: number;
  /** FOTSI base currency TSI */
  fotsiBaseTsi?: number;
  /** FOTSI quote currency TSI */
  fotsiQuoteTsi?: number;
  /** Current market price at rejection time */
  priceAtRejection?: number;
  /** Full detail blob for debugging */
  rawDetail?: Record<string, any>;
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

export function buildRejectedOpportunityKey(params: {
  symbol: string;
  direction: "long" | "short";
  rejectionType: RejectionType;
  failedGates?: string[];
  sessionName?: string;
}): string {
  const gates = [...new Set((params.failedGates || []).map(normalizeRejectedGate))].sort();
  return [
    params.symbol,
    params.direction,
    params.rejectionType,
    params.sessionName || "unknown_session",
    gates.length > 0 ? gates.join("+") : "no_gate",
  ].join("|").toLowerCase();
}

// ── Main logging function ──

/**
 * Log a rejected setup to the rejected_setups table.
 *
 * Non-fatal: returns true on success, false on failure.
 * Never throws — all errors are caught and logged to console.
 */
export async function logRejectedSetup(params: RejectedSetupParams): Promise<boolean> {
  try {
    const {
      supabase,
      userId,
      botId = "smc",
      symbol,
      direction,
      rejectionType,
      failedGates,
      confluenceScore,
      tier1Count,
      tier1Factors,
      entryPrice,
      stopLoss,
      takeProfit,
      rrRatio,
      sessionName,
      regime,
      gpBias,
      gpBiasConfidence,
      fotsiBaseTsi,
      fotsiQuoteTsi,
      priceAtRejection,
      rawDetail,
    } = params;

    const normalizedGates = [...new Set((failedGates || []).map(normalizeRejectedGate))].sort();
    const row: Record<string, any> = {
      user_id: userId,
      bot_id: botId,
      symbol,
      direction,
      rejection_type: rejectionType,
      failed_gates: failedGates ?? [],
      confluence_score: confluenceScore,
      tier1_count: tier1Count,
      tier1_factors: tier1Factors ?? [],
      entry_price: entryPrice,
      price_at_rejection: priceAtRejection ?? entryPrice,
      outcome_status: "pending",
      normalized_gates: normalizedGates,
      opportunity_key: buildRejectedOpportunityKey({
        symbol,
        direction,
        rejectionType,
        failedGates,
        sessionName,
      }),
      shadow_decision: rawDetail?.gamePlanShadowAudit || null,
    };

    // Optional fields — only include if defined
    if (stopLoss !== undefined) row.stop_loss = stopLoss;
    if (takeProfit !== undefined) row.take_profit = takeProfit;
    if (rrRatio !== undefined) row.rr_ratio = rrRatio;
    if (sessionName !== undefined) row.session_name = sessionName;
    if (regime !== undefined) row.regime = regime;
    if (gpBias !== undefined) row.gp_bias = gpBias;
    if (gpBiasConfidence !== undefined) row.gp_bias_confidence = gpBiasConfidence;
    if (fotsiBaseTsi !== undefined) row.fotsi_base_tsi = fotsiBaseTsi;
    if (fotsiQuoteTsi !== undefined) row.fotsi_quote_tsi = fotsiQuoteTsi;
    if (rawDetail !== undefined) row.raw_detail = rawDetail;

    const { error } = await supabase.from("rejected_setups").insert(row);

    if (error) {
      console.warn(`[rejected-setup-logger] DB insert error for ${symbol}: ${error.message}`);
      return false;
    }

    return true;
  } catch (e) {
    console.warn(`[rejected-setup-logger] Unexpected error: ${(e as Error)?.message}`);
    return false;
  }
}

/**
 * Determine if a below-threshold setup should be logged.
 * Criteria: ≥2 Tier 1 factors present.
 */
export function shouldLogBelowThreshold(tier1Count: number): boolean {
  return tier1Count >= 2;
}
