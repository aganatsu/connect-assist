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
