import type { InstrumentGamePlan, SessionGamePlan } from "./gamePlan.ts";
import type { DirectionVerdictResult } from "./directionVerdict.ts";
import type { DirectionVerdictDecision } from "./decisionContract.ts";

export const DIRECTION_VERDICT_CONTRACT_VERSION = "phase3.v2";
export const DEFAULT_DIRECTION_VERDICT_VALIDITY_MINUTES = 20;

export interface ActiveDirectionVerdictRow {
  id: string;
  verdict_version: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  game_plan_id: string | null;
  game_plan_version: string | null;
  verdict: "long" | "short" | "neutral";
  confidence: number | string;
  agreement: number | string;
  should_block: boolean;
  block_reason: string | null;
  score_adjustment: number | string;
  verdict_json: Record<string, unknown>;
  source_candle_timestamp: string | null;
  evaluated_at: string;
  expires_at: string;
  scan_cycle_id: string | null;
  is_active: boolean;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function directionVerdictRowToDecision(
  row: ActiveDirectionVerdictRow,
): DirectionVerdictDecision {
  return {
    ...(row.verdict_json || {}),
    id: row.id,
    verdictVersion: row.verdict_version,
    gamePlanId: row.game_plan_id,
    gamePlanVersion: row.game_plan_version,
    verdict: row.verdict,
    confidence: asNumber(row.confidence),
    agreement: asNumber(row.agreement),
    shouldBlock: row.should_block,
    blockReason: row.block_reason,
    scoreAdjustment: asNumber(row.score_adjustment),
    evaluatedAt: row.evaluated_at,
    expiresAt: row.expires_at,
    sourceCandleTimestamp: row.source_candle_timestamp,
  };
}

export async function persistActiveDirectionVerdict(
  client: any,
  input: {
    userId: string;
    botId: string;
    symbol: string;
    verdict: DirectionVerdictResult;
    gamePlan: SessionGamePlan | null;
    sourceCandleTimestamp?: string | null;
    scanCycleId?: string | null;
    evaluatedAt?: string;
    validityMinutes?: number;
  },
): Promise<DirectionVerdictDecision> {
  const evaluatedAt = input.evaluatedAt || new Date().toISOString();
  const validityMinutes = Number.isFinite(input.validityMinutes) &&
      Number(input.validityMinutes) > 0
    ? Number(input.validityMinutes)
    : DEFAULT_DIRECTION_VERDICT_VALIDITY_MINUTES;
  const expiresAt = new Date(
    new Date(evaluatedAt).getTime() + validityMinutes * 60_000,
  ).toISOString();
  const pairPlan: InstrumentGamePlan | undefined = input.gamePlan?.plans?.find(
    (plan) => plan.symbol === input.symbol,
  );
  const verdictVersion = crypto.randomUUID();
  const { data, error } = await client.rpc("activate_direction_verdict", {
    p_user_id: input.userId,
    p_bot_id: input.botId,
    p_symbol: input.symbol,
    p_verdict_version: verdictVersion,
    p_game_plan_id: pairPlan?.gamePlanId || null,
    p_game_plan_version: pairPlan?.planVersion ||
      input.gamePlan?.planVersion ||
      null,
    p_verdict: input.verdict.verdict,
    p_confidence: input.verdict.confidence,
    p_agreement: input.verdict.agreement,
    p_should_block: input.verdict.shouldBlock,
    p_block_reason: input.verdict.blockReason,
    p_score_adjustment: input.verdict.scoreAdjustment,
    p_verdict_json: input.verdict,
    p_source_candle_timestamp: input.sourceCandleTimestamp || null,
    p_evaluated_at: evaluatedAt,
    p_expires_at: expiresAt,
    p_scan_cycle_id: input.scanCycleId || null,
  });
  if (error) {
    throw new Error(`Could not activate Direction Verdict: ${error.message}`);
  }
  const row = data?.row as ActiveDirectionVerdictRow | undefined;
  if (!row?.id) {
    throw new Error(
      "Could not activate Direction Verdict: database returned no row",
    );
  }
  return directionVerdictRowToDecision(row);
}

export async function loadActiveDirectionVerdicts(
  client: any,
  userId: string,
  botId: string,
  now = new Date(),
): Promise<Map<string, DirectionVerdictDecision>> {
  const { data, error } = await client
    .from("active_direction_verdicts")
    .select(
      "id,verdict_version,user_id,bot_id,symbol,game_plan_id,game_plan_version,verdict,confidence,agreement,should_block,block_reason,score_adjustment,verdict_json,source_candle_timestamp,evaluated_at,expires_at,scan_cycle_id,is_active",
    )
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .eq("is_active", true)
    .gt("expires_at", now.toISOString());
  if (error) {
    throw new Error(
      `Could not load active Direction Verdicts: ${error.message}`,
    );
  }
  return new Map(
    ((data || []) as ActiveDirectionVerdictRow[]).map((row) => [
      row.symbol,
      directionVerdictRowToDecision(row),
    ]),
  );
}

export function directionVerdictMatchesGamePlan(
  verdict: DirectionVerdictDecision | null,
  gamePlan: SessionGamePlan | null,
  symbol: string,
): boolean {
  if (!verdict) return false;
  const pairPlan = gamePlan?.plans?.find((plan) => plan.symbol === symbol);
  const activeVersion = pairPlan?.planVersion || gamePlan?.planVersion || null;
  return !!activeVersion && verdict.gamePlanVersion === activeVersion;
}
