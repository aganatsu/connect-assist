import { batchGetCachedCandles } from "./candleCache.ts";
import {
  applyFinalCandidateSizeAdjustments,
  computePositionSize,
  type FinalCandidateSizeResult,
  type PropFirmContext,
  resolveSizingVolatilityContext,
} from "./unifiedPositionSizing.ts";
import { averageRoundTripCommission } from "./tradingCosts.ts";

const SIZING_RATE_PAIRS = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];

/** Read the same persisted daily FX conversions without spending market-data credits. */
export async function loadCachedSizingRateMap(supabase: any): Promise<Record<string, number>> {
  const rates: Record<string, number> = {};
  const cached = await batchGetCachedCandles(
    supabase,
    SIZING_RATE_PAIRS.map((symbol) => ({ symbol, interval: "1d" })),
  );
  for (const [key, candles] of cached.entries()) {
    const separator = key.lastIndexOf(":");
    const symbol = separator > 0 ? key.slice(0, separator) : key;
    const close = Number(candles[candles.length - 1]?.close);
    if (symbol && Number.isFinite(close) && close > 0) rates[symbol] = close;
  }
  return rates;
}

export async function loadAverageRoundTripCommission(
  supabase: any,
  userId: string,
  liveMode: boolean,
): Promise<number> {
  if (!liveMode) return 0;
  const { data } = await supabase.from("broker_connections")
    .select("commission_mode, commission_per_lot, detected_commission_per_lot")
    .eq("user_id", userId).eq("is_active", true);
  return averageRoundTripCommission(data || []);
}

/** Position size is calculated only after final entry authorization. */
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
  regimeInfo?: { regime?: string | null; atrTrend?: string | null } | null;
  propFirmSizeMultiplier?: number;
  signalSource?: string | null;
  standaloneMultiplier?: number;
}): FinalCandidateSizeResult {
  const propFirm: PropFirmContext | undefined = input.propFirmSizeMultiplier == null
    ? undefined
    : { enabled: true, sizeMultiplier: input.propFirmSizeMultiplier };
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
  }, undefined, resolveSizingVolatilityContext(input.regimeInfo), propFirm);
  const signalSource = input.signalSource === "cascade" ||
      input.signalSource === "unified" ||
      input.signalSource === "standalone"
    ? input.signalSource
    : null;
  const adjusted = applyFinalCandidateSizeAdjustments({
    sizingResult: result,
    signalSource,
    standaloneMultiplier: input.standaloneMultiplier,
  });
  return adjusted;
}
