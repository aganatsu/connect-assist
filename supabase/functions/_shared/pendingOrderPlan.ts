export interface PendingEntryZone {
  price: number;
  zoneType: string;
  zoneLow: number;
  zoneHigh: number;
}

export interface PendingOrderPlan {
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  zone: PendingEntryZone;
  riskReward: number;
}

export type PendingOrderPlanResult =
  | { valid: true; plan: PendingOrderPlan }
  | { valid: false; reason: string };

export interface PreArmedStopInput {
  direction: "long" | "short";
  zone: PendingEntryZone;
  structuralInvalidation: number;
  preferredPositionStop?: number | null;
  pipSize: number;
  minimumStopPips: number;
  atrValue?: number | null;
  atrFloorMultiplier?: number;
}

export interface PreArmedPositionPlanInput extends PreArmedStopInput {
  /** Fully resolved and buffered stop. Validate it but never widen it. */
  finalPositionStop?: number | null;
  /** Target frozen by the configured TP owner at discovery. */
  frozenTakeProfit?: number | null;
  /** Retained for rr_ratio callers and explicit ratio fallback only. */
  takeProfitRatio?: number;
}

export type PreArmedStopResult =
  | { valid: true; stopLoss: number }
  | { valid: false; reason: string };

/** A frozen target behind the observed price means the planned move is over. */
export function frozenTargetAlreadyReached(
  direction: "long" | "short",
  observedPrice: number,
  frozenTakeProfit: number,
): boolean {
  if (!Number.isFinite(observedPrice) || !Number.isFinite(frozenTakeProfit)) return false;
  return direction === "long"
    ? observedPrice >= frozenTakeProfit
    : observedPrice <= frozenTakeProfit;
}

/** Position-risk geometry is separate from the pre-entry structural boundary. */
export function resolvePreArmedPositionStop(
  input: PreArmedStopInput,
): PreArmedStopResult {
  const entry = Number(input.zone.price);
  const structural = Number(input.structuralInvalidation);
  const pipSize = Math.abs(Number(input.pipSize));
  if (![entry, structural, pipSize].every(Number.isFinite) || !(pipSize > 0)) {
    return { valid: false, reason: "Pre-armed risk geometry contains a non-finite price" };
  }

  const staticFloor = Math.max(0, Number(input.minimumStopPips)) * pipSize;
  const atrFloor = Math.max(0, Number(input.atrValue || 0)) *
    Math.max(0, Number(input.atrFloorMultiplier ?? 1.5));
  const minimumDistance = Math.max(staticFloor, atrFloor, pipSize);
  const beyondStructural = input.direction === "long"
    ? structural - pipSize
    : structural + pipSize;
  const minimumStop = input.direction === "long"
    ? entry - minimumDistance
    : entry + minimumDistance;

  const hasPreferred = input.preferredPositionStop !== null &&
    input.preferredPositionStop !== undefined;
  const preferred = Number(input.preferredPositionStop);
  const preferredIsValid = hasPreferred && Number.isFinite(preferred) && (input.direction === "long"
    ? preferred <= beyondStructural && preferred < entry
    : preferred >= beyondStructural && preferred > entry);
  return {
    valid: true,
    stopLoss: preferredIsValid
      ? preferred
      : input.direction === "long"
      ? Math.min(beyondStructural, minimumStop)
      : Math.max(beyondStructural, minimumStop),
  };
}

export function buildPreArmedPositionPlan(
  input: PreArmedPositionPlanInput,
): PendingOrderPlanResult {
  const finalPositionStop = Number(input.finalPositionStop);
  const hasFinalPositionStop = input.finalPositionStop !== null &&
    input.finalPositionStop !== undefined;
  const finalStopIsValid = hasFinalPositionStop &&
    Number.isFinite(finalPositionStop) &&
    (input.direction === "long"
      ? finalPositionStop < input.zone.price &&
        finalPositionStop <= input.structuralInvalidation
      : finalPositionStop > input.zone.price &&
        finalPositionStop >= input.structuralInvalidation);
  if (hasFinalPositionStop && !finalStopIsValid) {
    return {
      valid: false,
      reason: "Final position stop is unavailable, misoriented, or inside structural invalidation",
    };
  }
  const stop: PreArmedStopResult = hasFinalPositionStop
    ? { valid: true, stopLoss: finalPositionStop }
    : resolvePreArmedPositionStop(input);
  if (!stop.valid) return stop;

  const frozenTakeProfit = Number(input.frozenTakeProfit);
  const hasFrozenTarget = input.frozenTakeProfit !== null &&
    input.frozenTakeProfit !== undefined && Number.isFinite(frozenTakeProfit);
  if (hasFrozenTarget) {
    const entry = Number(input.zone.price);
    if (frozenTargetAlreadyReached(input.direction, entry, frozenTakeProfit)) {
      return {
        valid: false,
        reason: "frozen_target_already_reached: entry=" + entry + " target=" + frozenTakeProfit,
      };
    }
  }
  const ratio = Math.max(1, Number(input.takeProfitRatio || 1));

  return buildPendingOrderPlan({
    direction: input.direction,
    zone: input.zone,
    stopLoss: stop.stopLoss,
    takeProfitFor: (positionEntry, positionStop, direction) => {
      if (hasFrozenTarget) return frozenTakeProfit;
      const risk = Math.abs(positionEntry - positionStop);
      return direction === "long"
        ? positionEntry + risk * ratio
        : positionEntry - risk * ratio;
    },
  });
}

/**
 * Freezes order geometry only. Position size and account/runtime safety are
 * deliberately excluded because they must be evaluated at authorization.
 */
export function buildPendingOrderPlan(input: {
  direction: "long" | "short";
  zone: PendingEntryZone;
  stopLoss: number;
  takeProfitFor: (entry: number, stop: number, direction: "long" | "short") => number;
}): PendingOrderPlanResult {
  const entryPrice = Number(input.zone.price);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = Number(
    input.takeProfitFor(entryPrice, stopLoss, input.direction),
  );
  if (![entryPrice, stopLoss, takeProfit].every(Number.isFinite)) {
    return { valid: false, reason: "Order geometry contains a non-finite price" };
  }
  const oriented = input.direction === "long"
    ? stopLoss < entryPrice && takeProfit > entryPrice
    : stopLoss > entryPrice && takeProfit < entryPrice;
  if (!oriented) {
    return {
      valid: false,
      reason: `SL/TP orientation mismatch for ${input.direction} (entry=${entryPrice} sl=${stopLoss} tp=${takeProfit})`,
    };
  }
  const risk = Math.abs(entryPrice - stopLoss);
  if (!(risk > 0)) return { valid: false, reason: "Order risk distance is zero" };
  return {
    valid: true,
    plan: {
      direction: input.direction,
      entryPrice,
      stopLoss,
      takeProfit,
      zone: { ...input.zone },
      riskReward: Math.abs(takeProfit - entryPrice) / risk,
    },
  };
}
