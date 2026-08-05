import type { BestZone } from "./impulseZoneEngine.ts";
import type { ICTEntryZoneSelection } from "./ictEntryZoneAuthority.ts";
import { buildICTEntryZoneObservationRow } from "./ictEntryZoneObservationStore.ts";
import { type OutcomeCandle, simulateOutcome } from "./outcomeSimulation.ts";

export const ICT_ENTRY_ZONE_REPLAY_CONTRACT_VERSION =
  "ict-entry-zone-retrospective-replay.v1";

interface ReplayEvidenceClient {
  from(table: string): any;
}

export interface ICTEntryZoneReplayInput {
  userId: string;
  botId: string;
  replayRunId: string;
  symbol: string;
  tradingStyle: string;
  observedAt: string;
  legacyBestZone: BestZone | null;
  authority: ICTEntryZoneSelection;
  candles: OutcomeCandle[];
  pipSize: number;
}

export interface ICTEntryZoneReplayResult {
  disagreed: boolean;
  inserted: boolean;
  scanCycleId: string | null;
}

export async function deterministicICTEntryZoneReplayScanCycleId(
  replayRunId: string,
  symbol: string,
  observedAt: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${ICT_ENTRY_ZONE_REPLAY_CONTRACT_VERSION}:${replayRunId}:${symbol}:${observedAt}`,
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

function resolvedStatus(result: ReturnType<typeof simulateOutcome>) {
  return result.price_reached_entry ? result.outcome_status : "no_entry";
}

export async function persistICTEntryZoneReplayEvidence(
  client: ReplayEvidenceClient,
  input: ICTEntryZoneReplayInput,
): Promise<ICTEntryZoneReplayResult> {
  if (!Number.isFinite(input.pipSize) || input.pipSize <= 0) {
    throw new Error("A positive pip size is required for ICT entry zone replay");
  }
  const scanCycleId = await deterministicICTEntryZoneReplayScanCycleId(
    input.replayRunId,
    input.symbol,
    input.observedAt,
  );
  const row = buildICTEntryZoneObservationRow({
    userId: input.userId,
    botId: input.botId,
    scanCycleId,
    symbol: input.symbol,
    tradingStyle: input.tradingStyle,
    observedAt: input.observedAt,
    legacyBestZone: input.legacyBestZone,
    authority: input.authority,
  });
  if (!row || row.disagreed !== true) {
    return { disagreed: false, inserted: false, scanCycleId: null };
  }

  const authorityOutcome = simulateOutcome(
    input.candles,
    row.direction as "long" | "short",
    Number(row.entry_price),
    Number(row.stop_loss),
    Number(row.take_profit),
    input.observedAt,
  );
  const legacyTrade = input.legacyBestZone?.zone.validationTrade;
  const legacyOutcome = legacyTrade
    ? simulateOutcome(
      input.candles,
      legacyTrade.direction,
      legacyTrade.entryPrice,
      legacyTrade.stopLoss,
      legacyTrade.takeProfit,
      input.observedAt,
    )
    : null;
  const { data, error } = await client
    .from("ict_entry_zone_authority_observations")
    .upsert({
      ...row,
      evidence_source: "retrospective_replay",
      replay_run_id: input.replayRunId,
      replay_contract_version: ICT_ENTRY_ZONE_REPLAY_CONTRACT_VERSION,
      activation_eligible: false,
      outcome_status: resolvedStatus(authorityOutcome),
      outcome_checked_at: new Date().toISOString(),
      price_reached_entry: authorityOutcome.price_reached_entry,
      tp_hit: authorityOutcome.tp_hit,
      sl_hit: authorityOutcome.sl_hit,
      mfe_pips: Number((authorityOutcome.mfe_pips / input.pipSize).toFixed(2)),
      mae_pips: Number((authorityOutcome.mae_pips / input.pipSize).toFixed(2)),
      legacy_outcome_status: legacyOutcome ? resolvedStatus(legacyOutcome) : null,
    }, {
      onConflict: "user_id,bot_id,scan_cycle_id,symbol",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw new Error(error.message);
  return {
    disagreed: true,
    inserted: Array.isArray(data) && data.length > 0,
    scanCycleId,
  };
}

export async function cleanupICTEntryZoneReplayEvidence(
  client: ReplayEvidenceClient,
  replayRunId: string,
): Promise<void> {
  const { error } = await client
    .from("ict_entry_zone_authority_observations")
    .delete()
    .eq("replay_run_id", replayRunId)
    .eq("evidence_source", "retrospective_replay");
  if (error) throw new Error(error.message);
}
