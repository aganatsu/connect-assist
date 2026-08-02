import type { RankedPOI } from "./impulseZoneEngine.ts";
import {
  evaluateCrossTimeframeShadowCandidate,
  type CrossTimeframeShadowPolicy,
} from "./crossTimeframeShadowValidation.ts";

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
  evidenceSource?: "forward_observation" | "retrospective_replay";
  replayRunId?: string | null;
  replayContractVersion?: string | null;
  activationEligible?: boolean;
  crossTimeframePolicy?: CrossTimeframeShadowPolicy;
}

export function zoneShadowDisagreementKey(
  candidates: RankedPOI[],
  policy?: CrossTimeframeShadowPolicy,
): string | null {
  const eligible = candidates.filter((candidate) =>
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
  const legacyId = legacyWinner?.localConfluence?.candidateId;
  const shadowId = shadowWinner?.localConfluence?.candidateId;
  if (legacyId && shadowId && legacyId !== shadowId) {
    return `rank:${legacyId}:${shadowId}`;
  }
  const authorityDisagreements = eligible
    .map((candidate) => ({
      candidate,
      evaluation: evaluateCrossTimeframeShadowCandidate(candidate, policy),
    }))
    .filter((item) => item.evaluation.disagreed)
    .map((item) =>
      `${
        item.candidate.localConfluence!.candidateId
      }:${item.evaluation.legacyDecision}:${item.evaluation.proposedDecision}`
    )
    .sort();
  return authorityDisagreements.length > 0
    ? `authority:${authorityDisagreements.join("|")}`
    : null;
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
  const rankingDisagreed = Boolean(
    legacyWinner &&
      shadowWinner &&
      legacyWinner.localConfluence?.candidateId !==
        shadowWinner.localConfluence?.candidateId,
  );
  const modelTopThree = eligible.filter((candidate) =>
    candidate.candidateModel?.topCandidate === true
  );
  const crossTfEvaluations = new Map(
    eligible.map((candidate) => [
      candidate.localConfluence!.candidateId,
      evaluateCrossTimeframeShadowCandidate(
        candidate,
        input.crossTimeframePolicy,
      ),
    ]),
  );
  const crossTfDisagreed = eligible.some((candidate) =>
    crossTfEvaluations.get(
      candidate.localConfluence!.candidateId,
    )?.disagreed === true
  );
  if (
    modelTopThree.length === 0 && !rankingDisagreed && !crossTfDisagreed
  ) return [];

  const observedCandidates = Array.from(
    new Set([
      ...modelTopThree,
      ...(rankingDisagreed && legacyWinner ? [legacyWinner] : []),
      ...(rankingDisagreed && shadowWinner ? [shadowWinner] : []),
    ]),
  );
  return observedCandidates.map((candidate) => {
    const local = candidate.localConfluence!;
    const ranking = candidate.shadowRanking!;
    const trade = candidate.validationTrade!;
    const crossTf = crossTfEvaluations.get(local.candidateId)!;
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
      ranking_disagreed: rankingDisagreed,
      legacy_zone_score: ranking.legacyZoneScore,
      legacy_comparable_score: ranking.legacyComparableScore,
      shadow_local_score: ranking.shadowLocalScore,
      local_confluence: local,
      shadow_ranking: ranking,
      candidate_model_version: candidate.candidateModel?.contractVersion ??
        null,
      candidate_model_rank: candidate.candidateModel?.rank ?? null,
      candidate_model_winner: candidate.candidateModel?.rank === 1,
      candidate_lifecycle_state: candidate.candidateLifecycle?.state ?? null,
      candidate_lifecycle: candidate.candidateLifecycle ?? null,
      candidate_model: candidate.candidateModel ?? null,
      timeframe_relationship: candidate.timeframeLineage?.relationship ?? null,
      parent_candidate_id: candidate.timeframeLineage?.parentCandidateId ??
        null,
      candidate_lineage: candidate.timeframeLineage ?? null,
      cross_tf_policy_version: crossTf.contractVersion,
      cross_tf_policy: crossTf.policy,
      legacy_execution_decision: crossTf.legacyDecision,
      cross_tf_shadow_decision: crossTf.proposedDecision,
      cross_tf_disagreed: crossTf.disagreed,
      cross_tf_reason_codes: crossTf.reasonCodes,
      cross_tf_evaluation: crossTf,
      evidence_source: input.evidenceSource ?? "forward_observation",
      replay_run_id: input.replayRunId ?? null,
      replay_contract_version: input.replayContractVersion ?? null,
      activation_eligible: input.activationEligible ??
        (input.evidenceSource !== "retrospective_replay"),
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
