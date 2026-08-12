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
