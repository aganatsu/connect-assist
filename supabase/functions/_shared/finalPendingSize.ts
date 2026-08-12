import { computePositionSize } from "./unifiedPositionSizing.ts";

/** Position size is intentionally calculated only after final entry authorization. */
export function calculateFinalPendingSize(input: {
  balance: number;
  riskPercent: number;
  fillPrice: number;
  stopLoss: number;
  symbol: string;
  method?: "percent_risk" | "fixed_lot" | "volatility_adjusted";
  fixedLotSize?: number;
  atrValue?: number;
  atrVolatilityMultiplier?: number;
  rateMap?: Record<string, number>;
  commissionPerLot?: number;
}): number {
  const result = computePositionSize({
    balance: input.balance,
    riskPercent: input.riskPercent,
    entryPrice: input.fillPrice,
    stopLoss: input.stopLoss,
    symbol: input.symbol,
    method: input.method || "percent_risk",
    fixedLotSize: input.fixedLotSize,
    atrValue: input.atrValue,
    atrVolatilityMultiplier: input.atrVolatilityMultiplier,
    rateMap: input.rateMap,
    commissionPerLot: input.commissionPerLot,
  });
  if (!Number.isFinite(result.lots) || result.lots <= 0) {
    throw new Error("Final pending-order size is unavailable");
  }
  return result.lots;
}
