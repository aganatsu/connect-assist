import { calculateATR, type Candle, detectSwingPoints } from "./smcAnalysis.ts";
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

export const DEFAULT_CONFIRMATION_TRIGGER_LOCK_CONFIG:
  ConfirmationTriggerLockConfig = {
    pivotLookback: 2,
    minDisplacementBodyRatio: 0.55,
    minDisplacementATR: 0.8,
  };

function indexAtOrAfter(candles: Candle[], time: string): number {
  const timestamp = Date.parse(time);
  if (!Number.isFinite(timestamp)) return 0;
  const index = candles.findIndex((candle) =>
    Date.parse(candle.datetime) >= timestamp
  );
  return index < 0 ? Math.max(0, candles.length - 1) : index;
}

function displacementQualified(
  candles: Candle[],
  index: number,
  direction: "long" | "short",
  config: ConfirmationTriggerLockConfig,
): boolean {
  const candle = candles[index];
  const atr = calculateATR(candles, 14);
  if (!candle || !(atr > 0)) return false;
  const range = candle.high - candle.low;
  if (!(range > 0)) return false;
  const body = Math.abs(candle.close - candle.open);
  const aligned = direction === "long"
    ? candle.close > candle.open
    : candle.close < candle.open;
  return aligned && body / range >= config.minDisplacementBodyRatio &&
    range >= atr * config.minDisplacementATR;
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
  if (
    !confirmation || !active || confirmation.candidateId !== active.id ||
    active.state !== "confirming" || candles.length < 8
  ) return null;
  const config = input.config || DEFAULT_CONFIRMATION_TRIGGER_LOCK_CONFIG;
  const startIndex = indexAtOrAfter(candles, confirmation.startedAt);
  const completed = candles.slice(0, -1);
  const contextStart = Math.max(0, startIndex - 12);
  const protectedSlice = completed.slice(startIndex);
  if (protectedSlice.length === 0) return null;
  let protectedPivotIndex = startIndex;
  for (let index = startIndex + 1; index < completed.length; index++) {
    const candidate = completed[index];
    const current = completed[protectedPivotIndex];
    const isDeeper = lifecycle.impulse.direction === "long"
      ? candidate.low < current.low
      : candidate.high > current.high;
    if (isDeeper) protectedPivotIndex = index;
  }
  const protectedLevel = lifecycle.impulse.direction === "long"
    ? completed[protectedPivotIndex].low
    : completed[protectedPivotIndex].high;
  const swings = detectSwingPoints(completed, config.pivotLookback, 0);
  const breakPivot = swings.filter((swing) =>
    swing.index >= contextStart && swing.index < protectedPivotIndex &&
    swing.type === (lifecycle.impulse.direction === "long" ? "high" : "low")
  ).at(-1);
  if (!breakPivot) return null;
  const latestIndex = completed.length - 1;
  const latest = completed[latestIndex]!;
  const breakLevel = breakPivot.price;
  const closeThrough = lifecycle.impulse.direction === "long"
    ? latest.close > breakLevel
    : latest.close < breakLevel;
  const afterLock = confirmation.lockedAt != null &&
    Date.parse(latest.datetime) > Date.parse(confirmation.lockedAt);
  const displacement = displacementQualified(
      completed,
      latestIndex,
      lifecycle.impulse.direction,
      config,
    )
    ? latestIndex
    : null;
  const passed = afterLock && closeThrough && displacement !== null;
  return {
    contractVersion: IMPULSE_CONFIRMATION_LOCK_VERSION,
    candidateId: active.id,
    generation: confirmation.generation,
    protectedLevel,
    breakLevel,
    protectedPivotIndex,
    breakPivotIndex: breakPivot.index,
    displacementIndex: displacement,
    displacementQualified: displacement !== null,
    shouldLock: true,
    confirmationPassed: confirmation.status === "trigger_locked" && passed,
    evaluatedAt: latest.datetime,
    explanation: displacement === null
      ? `Structure frozen: protected pivot ${protectedLevel}, break ${breakLevel}; waiting for a later displaced close`
      : `Close through ${breakLevel} with displacement confirms ${lifecycle.impulse.direction}`,
  };
}
