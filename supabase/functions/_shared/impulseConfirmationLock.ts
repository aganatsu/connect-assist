import { calculateATR, type Candle, detectSwingPoints } from "./smcAnalysis.ts";
import type { ImpulseEntryLifecycle } from "./impulseEntryLifecycle.ts";

export const IMPULSE_CONFIRMATION_LOCK_VERSION = "impulse-confirmation-lock.v2";

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
  requiresRevision: boolean;
  confirmationPassed: boolean;
  evaluatedAt: string;
  explanation: string;
}

export type ConfirmationBuildReasonCode =
  | "inactive_contract"
  | "insufficient_history"
  | "insufficient_post_touch_bars"
  | "protected_pivot_missing"
  | "break_pivot_missing"
  | "trigger_ready";

export interface ConfirmationBuildDiagnostic {
  contractVersion: typeof IMPULSE_CONFIRMATION_LOCK_VERSION;
  reasonCode: ConfirmationBuildReasonCode;
  evaluatedAt: string | null;
  confirmationTimeframe: string | null;
  barsAfterTouch: number;
  requiredBars: number;
  swingCount: number;
  protectedPivotCount: number;
  breakPivotCount: number;
}

export interface ConfirmationBuildDiagnosticSink {
  current: ConfirmationBuildDiagnostic | null;
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
  diagnosticSink?: ConfirmationBuildDiagnosticSink;
}): ConfirmationTriggerPlan | null {
  const { lifecycle, candles } = input;
  const confirmation = lifecycle.confirmation;
  const active = lifecycle.candidates.find((candidate) =>
    candidate.id === lifecycle.activeCandidateId
  );
  const report = (
    reasonCode: ConfirmationBuildReasonCode,
    barsAfterTouch = 0,
    requiredBars = 0,
    swingCount = 0,
    protectedPivotCount = 0,
    breakPivotCount = 0,
  ) => {
    if (!input.diagnosticSink) return;
    input.diagnosticSink.current = {
      contractVersion: IMPULSE_CONFIRMATION_LOCK_VERSION,
      reasonCode,
      evaluatedAt: candles.at(-1)?.datetime || null,
      confirmationTimeframe: confirmation?.timeframe || null,
      barsAfterTouch,
      requiredBars,
      swingCount,
      protectedPivotCount,
      breakPivotCount,
    };
  };
  if (
    !confirmation || !active || confirmation.candidateId !== active.id ||
    active.state !== "confirming"
  ) {
    report("inactive_contract");
    return null;
  }
  if (candles.length < 8) {
    report("insufficient_history", candles.length, 8);
    return null;
  }
  const config = input.config || DEFAULT_CONFIRMATION_TRIGGER_LOCK_CONFIG;
  const startIndex = indexAtOrAfter(candles, confirmation.startedAt);
  const completed = candles;
  const contextStart = Math.max(0, startIndex - 12);
  const barsAfterTouch = completed.length - startIndex;
  const requiredBars = config.pivotLookback * 2 + 1;
  if (barsAfterTouch < requiredBars) {
    report("insufficient_post_touch_bars", barsAfterTouch, requiredBars);
    return null;
  }

  // The protected pivot must be a confirmed post-touch swing. A raw latest low/high
  // is still forming and cannot own an enforced confirmation contract.
  const swings = detectSwingPoints(completed, config.pivotLookback, 0);
  const protectedType = lifecycle.impulse.direction === "long" ? "low" : "high";
  const protectedPivots = swings.filter((swing) =>
    swing.index >= startIndex && swing.type === protectedType
  );
  if (protectedPivots.length === 0) {
    report(
      "protected_pivot_missing",
      barsAfterTouch,
      requiredBars,
      swings.length,
      0,
      0,
    );
    return null;
  }
  const protectedPivot = protectedPivots.reduce((selected, candidate) => {
    const isDeeper = lifecycle.impulse.direction === "long"
      ? candidate.price < selected.price
      : candidate.price > selected.price;
    return isDeeper ? candidate : selected;
  });
  const protectedPivotIndex = protectedPivot.index;
  const protectedLevel = protectedPivot.price;

  // CHoCH/MSS breaks the most recent opposing pivot before the protected
  // extreme. The bounded pre-touch context supplies the first trigger; later
  // deeper retracements naturally select the newer internal pivot.
  const breakPivot = swings.filter((swing) =>
    swing.index >= contextStart && swing.index < protectedPivotIndex &&
    swing.type === (lifecycle.impulse.direction === "long" ? "high" : "low")
  ).at(-1);
  if (!breakPivot) {
    report(
      "break_pivot_missing",
      barsAfterTouch,
      requiredBars,
      swings.length,
      protectedPivots.length,
      0,
    );
    return null;
  }
  const breakLevel = breakPivot.price;
  const latestIndex = completed.length - 1;
  const latest = completed[latestIndex]!;
  const levelChanged = confirmation.status === "trigger_locked" &&
    confirmation.protectedLevel != null && confirmation.breakLevel != null &&
    (Math.abs(confirmation.protectedLevel - protectedLevel) > 1e-10 ||
      Math.abs(confirmation.breakLevel - breakLevel) > 1e-10);
  const effectiveBreakLevel = confirmation.status === "trigger_locked" &&
      !levelChanged && confirmation.breakLevel != null
    ? confirmation.breakLevel
    : breakLevel;
  const closeThrough = lifecycle.impulse.direction === "long"
    ? latest.close > effectiveBreakLevel
    : latest.close < effectiveBreakLevel;
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
  const passed = !levelChanged && afterLock && closeThrough &&
    displacement !== null;
  report(
    "trigger_ready",
    barsAfterTouch,
    requiredBars,
    swings.length,
    protectedPivots.length,
    1,
  );
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
    requiresRevision: levelChanged,
    confirmationPassed: confirmation.status === "trigger_locked" && passed,
    evaluatedAt: latest.datetime,
    explanation: levelChanged
      ? `Deeper post-touch structure rebuilt protected pivot ${protectedLevel} and break ${breakLevel}`
      : displacement === null
      ? `Structure frozen: protected pivot ${protectedLevel}, break ${breakLevel}; waiting for a later displaced close`
      : `Close through ${effectiveBreakLevel} with displacement confirms ${lifecycle.impulse.direction}`,
  };
}
