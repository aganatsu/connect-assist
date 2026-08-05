import type { BestZone } from "./impulseZoneEngine.ts";
import type { ICTEntryZoneSelection } from "./ictEntryZoneAuthority.ts";

export interface ICTEntryZoneObservationInput {
  userId: string;
  botId: string;
  scanCycleId: string;
  symbol: string;
  tradingStyle: string;
  observedAt: string;
  legacyBestZone: BestZone | null;
  authority: ICTEntryZoneSelection;
}

export function buildICTEntryZoneObservationRow(
  input: ICTEntryZoneObservationInput,
): Record<string, unknown> | null {
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
  input: ICTEntryZoneObservationInput,
): Promise<boolean> {
  const row = buildICTEntryZoneObservationRow(input);
  if (!row) return false;
  const { error } = await client
    .from("ict_entry_zone_authority_observations")
    .upsert(row, {
      onConflict: "user_id,bot_id,scan_cycle_id,symbol",
      ignoreDuplicates: true,
    });
  if (error) throw new Error(error.message);
  return true;
}
