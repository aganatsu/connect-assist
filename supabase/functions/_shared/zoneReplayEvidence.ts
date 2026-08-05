import type { RankedPOI } from "./impulseZoneEngine.ts";
import { cleanupICTEntryZoneReplayEvidence } from "./ictEntryZoneReplayEvidence.ts";
import { type OutcomeCandle, simulateOutcome } from "./outcomeSimulation.ts";
import {
  buildZoneShadowObservationRows,
  zoneShadowDisagreementKey,
} from "./zoneShadowObservationStore.ts";
import type {
  CrossTimeframeShadowPolicy,
} from "./crossTimeframeShadowValidation.ts";

export const ZONE_LOCAL_REPLAY_CONTRACT_VERSION =
  "zone-local-retrospective-replay.v1";

interface ReplayEvidenceClient {
  from(table: string): any;
}

export interface ZoneReplayEvidenceInput {
  userId: string;
  botId: string;
  replayRunId: string;
  symbol: string;
  tradingStyle: string;
  stylePolicyVersion: string | null;
  styleBasePolicyHash: string | null;
  stylePolicyHash: string | null;
  observedAt: string;
  candidates: RankedPOI[];
  candles: OutcomeCandle[];
  pipSize: number;
  crossTimeframePolicy?: CrossTimeframeShadowPolicy;
}

export interface ZoneReplayEvidenceResult {
  disagreement: boolean;
  attempted: number;
  inserted: number;
  scanCycleId: string | null;
}

export async function deterministicReplayScanCycleId(
  replayRunId: string,
  symbol: string,
  disagreementKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${ZONE_LOCAL_REPLAY_CONTRACT_VERSION}:${replayRunId}:${symbol}:${disagreementKey}`,
    ),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export async function persistZoneReplayEvidence(
  client: ReplayEvidenceClient,
  input: ZoneReplayEvidenceInput,
): Promise<ZoneReplayEvidenceResult> {
  const disagreementKey = zoneShadowDisagreementKey(
    input.candidates,
    input.crossTimeframePolicy,
  );
  if (!disagreementKey) {
    return {
      disagreement: false,
      attempted: 0,
      inserted: 0,
      scanCycleId: null,
    };
  }
  if (!Number.isFinite(input.pipSize) || input.pipSize <= 0) {
    throw new Error("A positive pip size is required for zone replay");
  }

  const scanCycleId = await deterministicReplayScanCycleId(
    input.replayRunId,
    input.symbol,
    disagreementKey,
  );
  const rows = buildZoneShadowObservationRows({
    userId: input.userId,
    botId: input.botId,
    scanCycleId,
    symbol: input.symbol,
    tradingStyle: input.tradingStyle,
    stylePolicyVersion: input.stylePolicyVersion,
    styleBasePolicyHash: input.styleBasePolicyHash,
    stylePolicyHash: input.stylePolicyHash,
    observedAt: input.observedAt,
    candidates: input.candidates,
    evidenceSource: "retrospective_replay",
    replayRunId: input.replayRunId,
    replayContractVersion: ZONE_LOCAL_REPLAY_CONTRACT_VERSION,
    activationEligible: false,
    crossTimeframePolicy: input.crossTimeframePolicy,
  });
  const checkedAt = new Date().toISOString();
  const resolvedRows = rows.map((row) => {
    const outcome = simulateOutcome(
      input.candles,
      row.direction as "long" | "short",
      Number(row.entry_price),
      row.stop_loss == null ? null : Number(row.stop_loss),
      row.take_profit == null ? null : Number(row.take_profit),
      input.observedAt,
    );
    return {
      ...row,
      outcome_status: outcome.price_reached_entry
        ? outcome.outcome_status
        : "no_entry",
      outcome_checked_at: checkedAt,
      price_reached_entry: outcome.price_reached_entry,
      tp_hit: outcome.tp_hit,
      sl_hit: outcome.sl_hit,
      tp_hit_time_minutes: outcome.tp_hit_time_minutes,
      mfe_pips: Number(
        (outcome.mfe_pips / input.pipSize).toFixed(2),
      ),
      mae_pips: Number(
        (outcome.mae_pips / input.pipSize).toFixed(2),
      ),
    };
  });

  const { data, error } = await client
    .from("zone_candidate_shadow_observations")
    .upsert(resolvedRows, {
      onConflict: "user_id,bot_id,scan_cycle_id,symbol,candidate_id",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw new Error(error.message);

  return {
    disagreement: true,
    attempted: resolvedRows.length,
    inserted: Array.isArray(data) ? data.length : 0,
    scanCycleId,
  };
}

export async function cleanupZoneReplayEvidence(
  client: ReplayEvidenceClient,
  replayRunId: string,
): Promise<void> {
  const { error } = await client
    .from("zone_candidate_shadow_observations")
    .delete()
    .eq("replay_run_id", replayRunId)
    .eq("evidence_source", "retrospective_replay");
  if (error) throw new Error(error.message);
  await cleanupICTEntryZoneReplayEvidence(client, replayRunId);
}
