import type { RankedPOI } from "./impulseZoneEngine.ts";

export interface ZoneShadowObservationContext {
  userId: string;
  botId: string;
  scanCycleId: string;
  symbol: string;
  tradingStyle: string;
  stylePolicyVersion: string | null;
  styleBasePolicyHash: string | null;
  stylePolicyHash: string | null;
  observedAt: string;
  candidates: RankedPOI[];
}

export function buildZoneShadowObservationRows(
  input: ZoneShadowObservationContext,
): Record<string, unknown>[] {
  const eligible = input.candidates.filter((candidate) =>
    candidate.localConfluence &&
    candidate.shadowRanking &&
    candidate.validationTrade
  );
  const legacyWinner = eligible.find((candidate) =>
    candidate.shadowRanking?.legacyRank === 1
  );
  const shadowWinner = eligible.find((candidate) =>
    candidate.shadowRanking?.shadowRank === 1
  );
  if (
    !legacyWinner ||
    !shadowWinner ||
    legacyWinner.localConfluence?.candidateId ===
      shadowWinner.localConfluence?.candidateId
  ) {
    return [];
  }

  const winners = Array.from(new Set([legacyWinner, shadowWinner]));
  return winners.map((candidate) => {
    const local = candidate.localConfluence!;
    const ranking = candidate.shadowRanking!;
    const trade = candidate.validationTrade!;
    return {
      user_id: input.userId,
      bot_id: input.botId,
      scan_cycle_id: input.scanCycleId,
      observed_at: input.observedAt,
      symbol: input.symbol,
      trading_style: input.tradingStyle,
      style_policy_version: input.stylePolicyVersion,
      style_base_policy_hash: input.styleBasePolicyHash,
      style_policy_hash: input.stylePolicyHash,
      direction: trade.direction,
      candidate_id: local.candidateId,
      zone_type: candidate.poi.type,
      zone_low: candidate.poi.low,
      zone_high: candidate.poi.high,
      entry_price: trade.entryPrice,
      stop_loss: trade.stopLoss,
      take_profit: trade.takeProfit,
      legacy_rank: ranking.legacyRank,
      shadow_rank: ranking.shadowRank,
      rank_delta: ranking.rankDelta,
      legacy_winner: ranking.legacyRank === 1,
      shadow_winner: ranking.shadowRank === 1,
      ranking_disagreed: true,
      legacy_zone_score: ranking.legacyZoneScore,
      legacy_comparable_score: ranking.legacyComparableScore,
      shadow_local_score: ranking.shadowLocalScore,
      local_confluence: local,
      shadow_ranking: ranking,
    };
  });
}

export async function persistZoneShadowObservations(
  supabase: any,
  input: ZoneShadowObservationContext,
): Promise<number> {
  const rows = buildZoneShadowObservationRows(input);
  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from("zone_candidate_shadow_observations")
    .upsert(rows, {
      onConflict: "user_id,bot_id,scan_cycle_id,symbol,candidate_id",
      ignoreDuplicates: true,
    });
  if (error) throw new Error(error.message);
  return rows.length;
}
