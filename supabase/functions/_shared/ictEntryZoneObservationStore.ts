import type { BestZone } from "./impulseZoneEngine.ts";
import type {
  ICTEntryZoneSelection,
  ICTStructurePoiEntryZoneSelection,
} from "./ictEntryZoneAuthority.ts";
import { checkMinRR } from "./gateMinRR.ts";

export interface ICTEntryZoneObservationInput {
  setupFamily?: "impulse";
  userId: string;
  botId: string;
  scanCycleId: string;
  symbol: string;
  tradingStyle: string;
  observedAt: string;
  legacyBestZone: BestZone | null;
  authority: ICTEntryZoneSelection;
}

export interface ICTEntryZoneValidationTrade {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export interface ICTCandleSnapshotReference {
  scanCycleId: string;
  symbol: string;
  timeframe: string;
}

export interface ICTStructurePoiForwardObservationInput {
  setupFamily: "structure_poi";
  userId: string;
  botId: string;
  scanCycleId: string;
  symbol: string;
  tradingStyle: string;
  observedAt: string;
  stylePolicyVersion: string | null;
  styleBasePolicyHash: string | null;
  stylePolicyHash: string | null;
  authority: ICTStructurePoiEntryZoneSelection;
  validationTrade: ICTEntryZoneValidationTrade | null;
  geometryFailureReason: string | null;
  minimumRiskReward: number;
  spreadPips: number;
  spreadSource: string;
  commissionPerLot: number;
  rateMap?: Record<string, number>;
  currentImpulseDecision: Record<string, unknown>;
  decisionObservations: Record<string, unknown>;
  timeframeEvidenceId: string | null;
  candleSnapshotRefs: ICTCandleSnapshotReference[];
}

export type AnyICTEntryZoneObservationInput =
  | ICTEntryZoneObservationInput
  | ICTStructurePoiForwardObservationInput;

function buildStructurePoiObservationRow(
  input: ICTStructurePoiForwardObservationInput,
): Record<string, unknown> | null {
  const selected = input.authority.selected;
  if (!selected) return null;
  const trade = input.validationTrade;
  const riskReward = trade
    ? checkMinRR({
      lastPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      symbol: input.symbol,
      minRiskReward: input.minimumRiskReward,
      spreadPipsOverride: input.spreadPips,
      commissionPerLot: input.commissionPerLot,
      rateMap: input.rateMap,
    })
    : null;
  const opportunityKey = [
    "structure_poi",
    input.symbol,
    selected.id,
    input.stylePolicyHash ?? "legacy-policy",
    trade?.entryPrice ?? "no-entry",
    trade?.stopLoss ?? "no-stop",
    trade?.takeProfit ?? input.geometryFailureReason ?? "no-target",
  ].join(":");
  return {
    user_id: input.userId,
    bot_id: input.botId,
    scan_cycle_id: input.scanCycleId,
    symbol: input.symbol,
    trading_style: input.tradingStyle,
    observed_at: input.observedAt,
    direction: selected.direction === "bullish" ? "long" : "short",
    setup_family: "structure_poi",
    opportunity_key: opportunityKey,
    legacy_candidate_id: null,
    legacy_zone_type: null,
    legacy_zone_low: null,
    legacy_zone_high: null,
    authority_candidate_id: selected.id,
    authority_zone_type: selected.type,
    authority_zone_low: selected.low,
    authority_zone_high: selected.high,
    authority_score: selected.score,
    component_ids: selected.componentIds,
    disagreed: true,
    entry_price: trade?.entryPrice ?? null,
    stop_loss: trade?.stopLoss ?? null,
    take_profit: trade?.takeProfit ?? null,
    comparison_status: trade ? "comparable" : "geometry_unavailable",
    geometry_failure_reason: trade ? null : input.geometryFailureReason,
    gross_risk_reward: riskReward?.rawRiskReward ?? null,
    effective_risk_reward: riskReward?.effectiveRiskReward ?? null,
    minimum_risk_reward: input.minimumRiskReward,
    risk_reward_passed: riskReward?.passed ?? null,
    cost_assumptions: {
      spreadPips: riskReward?.spreadPips ?? input.spreadPips,
      spreadSource: input.spreadSource,
      commissionPerLot: riskReward?.commissionPerLot ?? input.commissionPerLot,
      totalCostInPrice: riskReward?.totalCostInPrice ?? null,
    },
    style_policy_version: input.stylePolicyVersion,
    style_base_policy_hash: input.styleBasePolicyHash,
    style_policy_hash: input.stylePolicyHash,
    timeframe_roles: input.authority.timeframes,
    source_evidence_ids: selected.sourceEvidenceIds,
    source_window: selected.sourceWindow,
    current_impulse_decision: input.currentImpulseDecision,
    decision_observations: input.decisionObservations,
    timeframe_evidence_id: input.timeframeEvidenceId,
    candle_snapshot_refs: input.candleSnapshotRefs,
    authority_observation: input.authority,
    outcome_status: trade ? "pending" : "unavailable",
    evidence_source: "forward_observation",
    activation_eligible: true,
  };
}

export function buildICTEntryZoneObservationRow(
  input: AnyICTEntryZoneObservationInput,
): Record<string, unknown> | null {
  if (input.setupFamily === "structure_poi") {
    return buildStructurePoiObservationRow(input);
  }
  const selected = input.authority.selected;
  if (!selected || !selected.validationTrade) return null;
  const legacy = input.legacyBestZone?.zone ?? null;
  const legacyId = legacy?.localConfluence?.candidateId ||
    legacy?.poi.evidence?.entityId ||
    (legacy ? `${legacy.poi.type}:${legacy.poi.low}:${legacy.poi.high}` : null);
  return {
    user_id: input.userId,
    bot_id: input.botId,
    scan_cycle_id: input.scanCycleId,
    symbol: input.symbol,
    trading_style: input.tradingStyle,
    observed_at: input.observedAt,
    direction: selected.direction === "bullish" ? "long" : "short",
    setup_family: "impulse",
    legacy_candidate_id: legacyId,
    legacy_zone_type: legacy?.poi.type ?? null,
    legacy_zone_low: legacy?.poi.low ?? null,
    legacy_zone_high: legacy?.poi.high ?? null,
    authority_candidate_id: selected.id,
    authority_zone_type: selected.type,
    authority_zone_low: selected.low,
    authority_zone_high: selected.high,
    authority_score: selected.score,
    component_ids: selected.componentIds,
    disagreed: legacyId !== selected.id,
    entry_price: selected.validationTrade.entryPrice,
    stop_loss: selected.validationTrade.stopLoss,
    take_profit: selected.validationTrade.takeProfit,
    authority_observation: input.authority,
  };
}

export async function persistICTEntryZoneObservation(
  client: any,
  input: AnyICTEntryZoneObservationInput,
): Promise<boolean> {
  const row = buildICTEntryZoneObservationRow(input);
  if (!row) return false;
  const { error } = await client
    .from("ict_entry_zone_authority_observations")
    .upsert(row, {
      onConflict: input.setupFamily === "structure_poi"
        ? "user_id,bot_id,setup_family,opportunity_key"
        : "user_id,bot_id,scan_cycle_id,symbol,setup_family",
      ignoreDuplicates: true,
    });
  if (error) throw new Error(error.message);
  return true;
}
