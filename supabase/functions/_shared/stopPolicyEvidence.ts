import type { StopPolicyShadowResult } from "./smcAnalysis.ts";

export const STOP_POLICY_EVIDENCE_CONTRACT_VERSION = "stop-policy-evidence.v1";
export const STOP_POLICY_EVIDENCE_RETENTION_DAYS = 90;

export interface StopPolicyPlanObservation {
  valid: boolean;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  takeProfitSource: string | null;
  takeProfitFallbackReason: string | null;
  reason: string | null;
}

export interface StopPolicyEvidenceInput {
  userId: string;
  botId: string;
  scanCycleId: string;
  candidateId: string;
  symbol: string;
  direction: "long" | "short";
  tradingStyle: string;
  setupSource: string;
  confirmationTimeframe: string;
  observedAt: string;
  entryPrice: number;
  structuralInvalidation: number;
  confirmationAtr: number;
  pipSize: number;
  spreadPips: number;
  spreadSource: "spec_proxy" | "live";
  spreadSafetyMultiplier: number;
  executionFloorQuoteDistance: number;
  executionFloorSource: "spread_proxy" | "broker_snapshot";
  brokerStopsLevel?: number | null;
  brokerDigits?: number | null;
  tickSize?: number | null;
  currentPlan: StopPolicyPlanObservation;
  shadowPlan: StopPolicyPlanObservation;
  shadow: StopPolicyShadowResult;
}

function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildStopPolicyEvidenceRow(
  input: StopPolicyEvidenceInput,
): Record<string, unknown> {
  return {
    user_id: input.userId,
    bot_id: input.botId,
    scan_cycle_id: input.scanCycleId,
    candidate_id: input.candidateId,
    contract_version: STOP_POLICY_EVIDENCE_CONTRACT_VERSION,
    observed_at: input.observedAt,
    symbol: input.symbol,
    direction: input.direction,
    trading_style: input.tradingStyle,
    setup_source: input.setupSource,
    confirmation_timeframe: input.confirmationTimeframe,
    entry_price: input.entryPrice,
    structural_invalidation: input.structuralInvalidation,
    confirmation_atr: input.confirmationAtr,
    pip_size: input.pipSize,
    spread_pips: input.spreadPips,
    spread_source: input.spreadSource,
    spread_safety_multiplier: input.spreadSafetyMultiplier,
    execution_floor_quote_distance: input.executionFloorQuoteDistance,
    execution_floor_source: input.executionFloorSource,
    broker_stops_level: finiteOrNull(input.brokerStopsLevel),
    broker_digits: finiteOrNull(input.brokerDigits),
    tick_size: finiteOrNull(input.tickSize),
    current_plan_valid: input.currentPlan.valid,
    current_stop_loss: finiteOrNull(input.currentPlan.stopLoss),
    current_take_profit: finiteOrNull(input.currentPlan.takeProfit),
    current_risk_reward: finiteOrNull(input.currentPlan.riskReward),
    current_take_profit_source: input.currentPlan.takeProfitSource,
    current_take_profit_fallback_reason:
      input.currentPlan.takeProfitFallbackReason,
    current_plan_reason: input.currentPlan.reason,
    shadow_plan_valid: input.shadowPlan.valid && input.shadow.valid,
    shadow_stop_loss: finiteOrNull(input.shadowPlan.stopLoss),
    shadow_take_profit: finiteOrNull(input.shadowPlan.takeProfit),
    shadow_risk_reward: finiteOrNull(input.shadowPlan.riskReward),
    shadow_take_profit_source: input.shadowPlan.takeProfitSource,
    shadow_take_profit_fallback_reason:
      input.shadowPlan.takeProfitFallbackReason,
    shadow_plan_reason: input.shadow.reason || input.shadowPlan.reason,
    shadow_measurements: input.shadow,
    observation_only: true,
  };
}

export async function persistStopPolicyEvidence(
  supabase: any,
  input: StopPolicyEvidenceInput,
): Promise<boolean> {
  const row = buildStopPolicyEvidenceRow(input);
  const { data, error } = await supabase
    .from("stop_policy_observations")
    .upsert(row, {
      onConflict: "user_id,bot_id,candidate_id,contract_version",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}
