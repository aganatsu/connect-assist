import {
  analyzeMarketStructure,
  calcPnl,
  type Candle,
  classifyInstrumentRegime,
} from "./smcAnalysis.ts";
import type { StructureCheckResult } from "./computeManagementDecision.ts";

export const EXIT_PARITY_CONTRACT_VERSION = "exit-parity.v1";

export interface PartialCloseInput {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  originalSL: number;
  currentPrice: number;
  favorablePrice: number;
  positionSize: number;
  enabled: boolean;
  alreadyActivated: boolean;
  partialTPPercent: number;
  partialTPLevel: number;
  executionPriceMode: "observed_market" | "threshold";
  rateMap?: Record<string, number>;
  commissionPerLot?: number;
  lotStep?: number;
}

export interface PartialCloseDecision {
  contractVersion: typeof EXIT_PARITY_CONTRACT_VERSION;
  triggered: boolean;
  reason: string;
  rMultiple: number;
  triggerPrice: number | null;
  executionPrice: number | null;
  closeSize: number;
  remainingSize: number;
  pnlPips: number;
  grossPnl: number;
  commission: number;
  netPnl: number;
}

export interface StructureInvalidationInput {
  direction: "long" | "short";
  structureCandles: Candle[];
  regimeCandles?: Candle[] | null;
  evaluatedAt?: string | number | Date;
  structureLookback?: number;
  regimeLookback?: number;
}

export interface StructureInvalidationEvidence {
  contractVersion: typeof EXIT_PARITY_CONTRACT_VERSION;
  structureCheck: StructureCheckResult | null;
  trend: "bullish" | "bearish" | "ranging" | "unknown";
  trendBasis: string;
  chochAgainstCount: number;
  regime: string;
  regimeSuppressed: boolean;
  structureCandleCount: number;
  regimeCandleCount: number;
  reason: string;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function roundToStep(value: number, step: number): number {
  const safeStep = step > 0 ? step : 0.01;
  const decimals = Math.max(
    0,
    Math.ceil(-Math.log10(safeStep)),
  );
  const factor = 10 ** decimals;
  return Math.round(
    Math.round(value / safeStep) * safeStep * factor,
  ) / factor;
}

/**
 * Pure partial-close authority used by live management and backtests.
 *
 * The trigger always uses the favorable observed price. The execution price is
 * explicit: live positions settle at the observed market price, while a
 * candle-based backtest settles at the exact threshold to avoid granting the
 * full candle excursion as fill improvement.
 */
export function computePartialCloseDecision(
  input: PartialCloseInput,
): PartialCloseDecision {
  const noAction = (
    reason: string,
    rMultiple = 0,
    triggerPrice: number | null = null,
  ): PartialCloseDecision => ({
    contractVersion: EXIT_PARITY_CONTRACT_VERSION,
    triggered: false,
    reason,
    rMultiple,
    triggerPrice,
    executionPrice: null,
    closeSize: 0,
    remainingSize: finite(input.positionSize, 0),
    pnlPips: 0,
    grossPnl: 0,
    commission: 0,
    netPnl: 0,
  });

  if (!input.enabled) return noAction("Partial TP is disabled");
  if (input.alreadyActivated) {
    return noAction("Partial TP already executed");
  }

  const entryPrice = finite(input.entryPrice, 0);
  const originalSL = finite(input.originalSL, 0);
  const positionSize = finite(input.positionSize, 0);
  const percent = finite(input.partialTPPercent, 0);
  const level = finite(input.partialTPLevel, 0);
  if (
    entryPrice <= 0 ||
    originalSL <= 0 ||
    positionSize <= 0 ||
    percent <= 0 ||
    percent >= 100 ||
    level <= 0
  ) {
    return noAction("Partial TP inputs are invalid");
  }

  const riskDistance = Math.abs(entryPrice - originalSL);
  if (riskDistance <= 0) return noAction("Original risk is zero");

  const favorableMove = input.direction === "long"
    ? input.favorablePrice - entryPrice
    : entryPrice - input.favorablePrice;
  const rMultiple = favorableMove / riskDistance;
  const triggerPrice = input.direction === "long"
    ? entryPrice + (riskDistance * level)
    : entryPrice - (riskDistance * level);
  if (rMultiple < level) {
    return noAction(
      `Partial TP waiting at ${rMultiple.toFixed(2)}R/${level.toFixed(2)}R`,
      rMultiple,
      triggerPrice,
    );
  }

  const lotStep = finite(input.lotStep ?? 0.01, 0.01);
  const closeSize = roundToStep(positionSize * (percent / 100), lotStep);
  const remainingSize = roundToStep(positionSize - closeSize, lotStep);
  if (closeSize < lotStep || remainingSize < lotStep) {
    return noAction(
      "Partial TP would leave an invalid position size",
      rMultiple,
      triggerPrice,
    );
  }

  const executionPrice = input.executionPriceMode === "threshold"
    ? triggerPrice
    : finite(input.currentPrice, triggerPrice);
  const pnlResult = calcPnl(
    input.direction,
    entryPrice,
    executionPrice,
    closeSize,
    input.symbol,
    input.rateMap,
  );
  if (!pnlResult.valid) {
    return noAction(
      `Partial TP P&L is invalid: ${pnlResult.reason}`,
      rMultiple,
      triggerPrice,
    );
  }
  const { pnl: grossPnl, pnlPips } = pnlResult;
  const commission = closeSize * finite(input.commissionPerLot ?? 0, 0) * 2;
  const netPnl = grossPnl - commission;

  return {
    contractVersion: EXIT_PARITY_CONTRACT_VERSION,
    triggered: true,
    reason: `Partial TP reached ${rMultiple.toFixed(2)}R — close ${percent}% ` +
      `(${closeSize} lots), retain ${remainingSize} lots`,
    rMultiple,
    triggerPrice,
    executionPrice,
    closeSize,
    remainingSize,
    pnlPips,
    grossPnl,
    commission,
    netPnl,
  };
}

/**
 * Builds identical structure-invalidation input for the live and historical
 * management engines. Both use the latest 120 entry-timeframe candles and the
 * latest 252 completed daily candles. Ranging/internal-only CHoCH is
 * deliberately suppressed as noise before it reaches the SL calculator.
 */
export function buildStructureInvalidationEvidence(
  input: StructureInvalidationInput,
): StructureInvalidationEvidence {
  const structureLookback = Math.max(20, input.structureLookback ?? 120);
  const regimeLookback = Math.max(20, input.regimeLookback ?? 252);
  const structureCandles = input.structureCandles.slice(-structureLookback);
  const evaluatedAt = input.evaluatedAt === undefined
    ? null
    : new Date(input.evaluatedAt);
  const evaluatedDate = evaluatedAt && !Number.isNaN(evaluatedAt.getTime())
    ? evaluatedAt.toISOString().slice(0, 10)
    : null;
  const regimeCandles = (input.regimeCandles || [])
    .filter((candle) =>
      !evaluatedDate ||
      typeof candle.datetime !== "string" ||
      candle.datetime.slice(0, 10) < evaluatedDate
    )
    .slice(-regimeLookback);

  const unavailable = (
    reason: string,
  ): StructureInvalidationEvidence => ({
    contractVersion: EXIT_PARITY_CONTRACT_VERSION,
    structureCheck: null,
    trend: "unknown",
    trendBasis: "none",
    chochAgainstCount: 0,
    regime: "unknown",
    regimeSuppressed: false,
    structureCandleCount: structureCandles.length,
    regimeCandleCount: regimeCandles.length,
    reason,
  });

  if (structureCandles.length < 20) {
    return unavailable("Insufficient structure candles");
  }

  const structure = analyzeMarketStructure(structureCandles);
  const chochAgainst = structure.choch.filter((event) =>
    (input.direction === "long" && event.type === "bearish") ||
    (input.direction === "short" && event.type === "bullish")
  );
  const structureAgainst =
    (input.direction === "long" && structure.trend === "bearish") ||
    (input.direction === "short" && structure.trend === "bullish");
  const regime = regimeCandles.length >= 20
    ? classifyInstrumentRegime(regimeCandles).regime
    : "unknown";
  const rangingRegime = regime === "choppy_range" ||
    regime === "mild_range" ||
    regime === "transitional";
  const trendBasis = structure.trendBasis || "none";
  const internalOnly = trendBasis === "internal" || trendBasis === "none";
  const regimeSuppressed = rangingRegime &&
    internalOnly &&
    structureAgainst &&
    chochAgainst.length > 0;
  const structureCheck = regimeSuppressed ? null : {
    trend: structure.trend,
    chochAgainstCount: chochAgainst.length,
  };

  return {
    contractVersion: EXIT_PARITY_CONTRACT_VERSION,
    structureCheck,
    trend: structure.trend,
    trendBasis,
    chochAgainstCount: chochAgainst.length,
    regime,
    regimeSuppressed,
    structureCandleCount: structureCandles.length,
    regimeCandleCount: regimeCandles.length,
    reason: regimeSuppressed
      ? `Suppressed ${chochAgainst.length} opposing CHoCH event(s): ` +
        `${regime} regime with ${trendBasis} structure basis`
      : structureAgainst && chochAgainst.length > 0
      ? `Confirmed ${chochAgainst.length} opposing CHoCH event(s) in ` +
        `${structure.trend} structure`
      : "No confirmed structure invalidation",
  };
}
