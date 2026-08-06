import { calculateATR, detectSwingPoints, type Candle } from "./smcAnalysis.ts";
import type { ImpulseEntryLifecycle } from "./impulseEntryLifecycle.ts";

export const IMPULSE_CONFIRMATION_LOCK_VERSION = "impulse-confirmation-lock.v1";

export interface ConfirmationTriggerPlan {
  contractVersion: typeof IMPULSE_CONFIRMATION_LOCK_VERSION;
  candidateId: string;
  generation: number;
  protectedLevel: number;
  breakLevel: number;
  protectedPivotIndex: number;
  breakPivotIndex: number;
  displacementIndex: number | null;
  displacementQualified: boolean;
  shouldLock: boolean;
  confirmationPassed: boolean;
  evaluatedAt: string;
  explanation: string;
}

export interface ConfirmationTriggerLockConfig {
  pivotLookback: number;
  minDisplacementBodyRatio: number;
  minDisplacementATR: number;
}

export const DEFAULT_CONFIRMATION_TRIGGER_LOCK_CONFIG: ConfirmationTriggerLockConfig = {
  pivotLookback: 2,
  minDisplacementBodyRatio: 0.55,
  minDisplacementATR: 0.8,
};

function indexAtOrAfter(candles: Candle[], time: string): number {
  const timestamp = Date.parse(time);
  if (!Number.isFinite(timestamp)) return 0;
  const index = candles.findIndex((candle) => Date.parse(candle.datetime) >= timestamp);
  return index < 0 ? Math.max(0, candles.length - 1) : index;
}

function findDisplacementIndex(
  candles: Candle[],
  startIndex: number,
  direction: "long" | "short",
  config: ConfirmationTriggerLockConfig,
): number | null {
  const atr = calculateATR(candles, 14);
  if (!(atr > 0)) return null;
  for (let index = startIndex; index < candles.length; index++) {
    const candle = candles[index];
    const range = candle.high - candle.low;
    if (!(range > 0)) continue;
    const body = Math.abs(candle.close - candle.open);
    const aligned = direction === "long"
      ? candle.close > candle.open
      : candle.close < candle.open;
    if (aligned && body / range >= config.minDisplacementBodyRatio &&
      range >= atr * config.minDisplacementATR) return index;
  }
  return null;
}

export function deriveConfirmationTriggerPlan(input: {
  lifecycle: ImpulseEntryLifecycle;
  candles: Candle[];
  config?: ConfirmationTriggerLockConfig;
}): ConfirmationTriggerPlan | null {
  const { lifecycle, candles } = input;
  const confirmation = lifecycle.confirmation;
  const active = lifecycle.candidates.find((candidate) =>
    candidate.id === lifecycle.activeCandidateId
  );
  if (!confirmation || !active || confirmation.candidateId !== active.id ||
    active.state !== "confirming" || candles.length < 8) return null;
  const config = input.config || DEFAULT_CONFIRMATION_TRIGGER_LOCK_CONFIG;
  const startIndex = indexAtOrAfter(candles, confirmation.startedAt);
  const completed = candles.slice(0, -1);
  const swings = detectSwingPoints(completed, config.pivotLookback, 0)
    .filter((swing) => swing.index >= startIndex);
  const lows = swings.filter((swing) => swing.type === "low");
  const highs = swings.filter((swing) => swing.type === "high");
  const protectedPivot = lifecycle.impulse.direction === "long"
    ? lows.at(-1)
    : highs.at(-1);
  if (!protectedPivot) return null;
  const opposing = lifecycle.impulse.direction === "long"
    ? highs.filter((swing) => swing.index > protectedPivot.index)
    : lows.filter((swing) => swing.index > protectedPivot.index);
  const breakPivot = opposing.at(-1);
  if (!breakPivot) return null;
  const displacement = findDisplacementIndex(
    completed,
    Math.max(protectedPivot.index, breakPivot.index),
    lifecycle.impulse.direction,
    config,
  );
  const latest = completed.at(-1)!;
  const breakLevel = breakPivot.price;
  const passed = lifecycle.impulse.direction === "long"
    ? latest.close > breakLevel
    : latest.close < breakLevel;
  return {
    contractVersion: IMPULSE_CONFIRMATION_LOCK_VERSION,
    candidateId: active.id,
    generation: confirmation.generation,
    protectedLevel: protectedPivot.price,
    breakLevel,
    protectedPivotIndex: protectedPivot.index,
    breakPivotIndex: breakPivot.index,
    displacementIndex: displacement,
    displacementQualified: displacement !== null,
    shouldLock: displacement !== null,
    confirmationPassed: confirmation.status === "trigger_locked" && passed,
    evaluatedAt: latest.datetime,
    explanation: displacement === null
      ? `Structure building: protected pivot ${protectedPivot.price}, break ${breakLevel}; waiting for displacement`
      : `Trigger locked by displacement: close through ${breakLevel} confirms ${lifecycle.impulse.direction}`,
  };
}
