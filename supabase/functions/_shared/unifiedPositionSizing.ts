/**
 * unifiedPositionSizing.ts — Unified Position Sizing Engine
 * ─────────────────────────────────────────────────────────────────────
 * Single source of truth for all position sizing calculations.
 * Wraps the core calculatePositionSize() from smcAnalysis.ts and adds:
 *
 *   1. **Portfolio heat check** — Refuse to size if total portfolio risk exceeds limit
 *   2. **Correlation adjustment** — Reduce size for correlated open positions
 *   3. **Volatility regime scaling** — Scale size down in high-vol regimes
 *   4. **Prop firm compliance** — Apply drawdown-aware size caps
 *   5. **Commission-aware sizing** — Deduct expected round-trip commission from risk budget
 *   6. **Consistent rounding** — All paths produce 0.01 lot increments
 *
 * This module wraps calculatePositionSize() in smcAnalysis.ts with the safety
 * and adjustment layers shared by live execution and historical replay.
 *
 * Usage:
 *   import { computePositionSize } from "../_shared/unifiedPositionSizing.ts";
 *   const result = computePositionSize({ ... });
 *   // result.lots, result.riskUSD, result.adjustments[]
 */

import {
  calculatePositionSize,
  floorLotSize,
  getQuoteToUSDRate,
  normalizeSymKey,
  SPECS,
} from "./smcAnalysis.ts";
import { calculateRoundTripCommission } from "./tradingCosts.ts";

// ─── Types ───────────────────────────────────────────────────────────

export interface SizingInput {
  /** Account balance in USD */
  balance: number;
  /** Risk per trade as percentage (e.g., 1.0 = 1%) */
  riskPercent: number;
  /** Entry price */
  entryPrice: number;
  /** Stop loss price */
  stopLoss: number;
  /** Symbol (e.g., "EUR/USD") */
  symbol: string;
  /** Position sizing method */
  method?: "percent_risk" | "fixed_lot" | "volatility_adjusted";
  /** Fixed lot size (for fixed_lot method) */
  fixedLotSize?: number;
  /** ATR value (for volatility_adjusted method) */
  atrValue?: number;
  /** ATR multiplier for volatility sizing */
  atrVolatilityMultiplier?: number;
  /** Rate map for cross-pair conversion */
  rateMap?: Record<string, number>;
  /** Commission per lot (round-trip) */
  commissionPerLot?: number;
  /** Max lot override */
  maxLot?: number;
}

export interface PortfolioContext {
  /** Currently open positions with their risk */
  openPositions: OpenPositionRisk[];
  /** Maximum portfolio heat (total risk %) allowed (default: 6%) */
  maxPortfolioHeat?: number;
  /** Maximum correlated exposure (default: 3%) */
  maxCorrelatedExposure?: number;
}

export interface OpenPositionRisk {
  symbol: string;
  direction: "long" | "short";
  riskUSD: number;
  lots: number;
}

export interface VolatilityContext {
  /** Current regime: low, normal, high, extreme */
  regime: "low" | "normal" | "high" | "extreme";
  /** ATR percentile (0-100) — where current ATR sits vs history */
  atrPercentile?: number;
}

export interface PropFirmContext {
  /** Whether prop firm mode is active */
  enabled: boolean;
  /** Daily loss limit remaining (USD) */
  dailyLossRemaining?: number;
  /** Max drawdown remaining (USD) */
  maxDrawdownRemaining?: number;
  /** Size multiplier from prop firm gate (0-1) */
  sizeMultiplier?: number;
}

export interface SizingResult {
  /** Final position size in lots */
  lots: number;
  /** All-in stop risk in USD, including round-trip commission */
  riskUSD: number;
  /** All-in stop risk as percentage of balance */
  riskPercent: number;
  /** Base lots before adjustments */
  baseLots: number;
  /** List of adjustments applied */
  adjustments: SizingAdjustment[];
  /** Whether the trade was rejected (lots = 0) */
  rejected: boolean;
  /** Rejection reason (if rejected) */
  rejectionReason?: string;
}

export interface SizingAdjustment {
  type:
    | "portfolio_heat"
    | "correlation"
    | "volatility"
    | "prop_firm"
    | "max_lot_cap"
    | "min_lot_floor";
  /** Multiplier applied (e.g., 0.5 = halved) */
  multiplier: number;
  /** Human-readable reason */
  reason: string;
}

export type CandidateSignalSource = "cascade" | "unified" | "standalone";

export interface FinalCandidateSizeInput {
  sizingResult: Pick<SizingResult, "lots" | "rejected" | "rejectionReason">;
  correlationMultiplier?: number;
  signalSource?: CandidateSignalSource | null;
  standaloneMultiplier?: number;
}

export interface FinalCandidateSizeResult {
  lots: number;
  afterCorrelationLots: number;
  correlationMultiplier: number;
  signalSourceMultiplier: number;
  rejected: boolean;
  rejectionReason?: string;
}

export type BrokerVolumeNormalizationResult =
  | { ok: true; volume: number }
  | { ok: false; error: string };

export interface OandaUnitConversionInput {
  symbol: string;
  lots: number;
  direction: "long" | "short";
  tradeUnitsPrecision: number;
  minimumTradeSize: number;
  maximumOrderUnits: number;
}

export type OandaUnitConversionResult =
  | { ok: true; units: string; unsignedUnits: number; lotUnits: number }
  | { ok: false; error: string };

/** Convert the sizing engine's lots into OANDA native instrument units. */
export function convertLotsToOandaUnits(input: OandaUnitConversionInput): OandaUnitConversionResult {
  const normalizedSymbol = normalizeSymKey(input.symbol);
  const specEntry = Object.entries(SPECS).find(([symbol]) => normalizeSymKey(symbol) === normalizedSymbol);
  if (!specEntry) return { ok: false, error: `Unsupported sizing symbol: ${input.symbol}` };
  if (!Number.isFinite(input.lots) || input.lots <= 0) {
    return { ok: false, error: "Lot size must be a positive finite number" };
  }
  if (input.direction !== "long" && input.direction !== "short") {
    return { ok: false, error: `Unsupported direction: ${input.direction}` };
  }
  if (!Number.isInteger(input.tradeUnitsPrecision) || input.tradeUnitsPrecision < 0 || input.tradeUnitsPrecision > 10) {
    return { ok: false, error: "Invalid OANDA trade-units precision" };
  }
  if (!Number.isFinite(input.minimumTradeSize) || input.minimumTradeSize <= 0 ||
      !Number.isFinite(input.maximumOrderUnits) || input.maximumOrderUnits <= 0 ||
      input.maximumOrderUnits < input.minimumTradeSize) {
    return { ok: false, error: "Invalid OANDA trade-size constraints" };
  }

  const lotUnits = specEntry[1].lotUnits;
  const rawUnits = input.lots * lotUnits;
  if (!Number.isFinite(rawUnits) || rawUnits <= 0) {
    return { ok: false, error: "Lot conversion produced invalid OANDA units" };
  }

  const precisionFactor = 10 ** input.tradeUnitsPrecision;
  const scaledUnits = rawUnits * precisionFactor;
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(scaledUnits)) * 4;
  const unsignedUnits = Math.floor(scaledUnits + floatingPointTolerance) / precisionFactor;
  if (unsignedUnits < input.minimumTradeSize) {
    return { ok: false, error: `Converted size ${unsignedUnits} is below OANDA minimum ${input.minimumTradeSize}` };
  }
  if (unsignedUnits > input.maximumOrderUnits) {
    return { ok: false, error: `Converted size ${unsignedUnits} exceeds OANDA maximum ${input.maximumOrderUnits}` };
  }

  const signedUnits = input.direction === "long" ? unsignedUnits : -unsignedUnits;
  const units = input.tradeUnitsPrecision === 0
    ? signedUnits.toFixed(0)
    : signedUnits.toFixed(input.tradeUnitsPrecision).replace(/0+$/, "").replace(/\.$/, "");
  return { ok: true, units, unsignedUnits, lotUnits };
}

/** Normalize lots to broker constraints without ever increasing requested risk. */
export function normalizeBrokerVolumeDown(input: {
  lots: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
}): BrokerVolumeNormalizationResult {
  if (!Number.isFinite(input.lots) || input.lots <= 0) {
    return { ok: false, error: "Broker volume must be a positive finite number" };
  }
  if (
    !Number.isFinite(input.minVolume) || input.minVolume <= 0 ||
    !Number.isFinite(input.maxVolume) || input.maxVolume <= 0 ||
    !Number.isFinite(input.volumeStep) || input.volumeStep <= 0 ||
    input.maxVolume < input.minVolume
  ) {
    return { ok: false, error: "Invalid broker volume constraints" };
  }

  const capped = Math.min(input.lots, input.maxVolume);
  const scaled = capped / input.volumeStep;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;
  const stepped = Math.floor(scaled + tolerance) * input.volumeStep;
  const volume = Number(stepped.toFixed(10));
  if (volume < input.minVolume) {
    return { ok: false, error: `Requested size ${input.lots} is below broker minimum ${input.minVolume}` };
  }
  if (!Number.isFinite(volume) || volume <= 0 || volume > capped) {
    return { ok: false, error: "Broker volume normalization produced an invalid size" };
  }
  return { ok: true, volume };
}

// ─── Correlation Map ─────────────────────────────────────────────────

/** Known high-correlation pairs (|r| > 0.7 historically) */
const CORRELATION_GROUPS: Record<string, string[]> = {
  "USD_STRENGTH": ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"],
  "JPY_WEAKNESS": [
    "USD/JPY",
    "EUR/JPY",
    "GBP/JPY",
    "AUD/JPY",
    "CAD/JPY",
    "CHF/JPY",
    "NZD/JPY",
  ],
  "COMMODITY": ["AUD/USD", "NZD/USD", "AUD/NZD", "AUD/CAD"],
  "EUR_CROSS": [
    "EUR/USD",
    "EUR/GBP",
    "EUR/JPY",
    "EUR/AUD",
    "EUR/NZD",
    "EUR/CAD",
    "EUR/CHF",
  ],
  "GBP_CROSS": [
    "GBP/USD",
    "GBP/JPY",
    "GBP/AUD",
    "GBP/NZD",
    "GBP/CAD",
    "GBP/CHF",
    "EUR/GBP",
  ],
  // Crypto, metals, energy, equities — previously had zero correlation coverage.
  "METALS": ["XAU/USD", "XAG/USD"],
  "CRYPTO_MAJORS": ["BTC/USD", "ETH/USD"],
  "RISK_ON_EQUITY": ["US30", "NAS100", "SPX500"],
  // Gold/oil often move together on USD-strength/risk days; loose but worth capping.
  "USD_HAVENS": ["XAU/USD", "US Oil"],
};

/**
 * Check if two symbols are in the same correlation group.
 */
function areCorrelated(symbolA: string, symbolB: string): boolean {
  for (const group of Object.values(CORRELATION_GROUPS)) {
    if (group.includes(symbolA) && group.includes(symbolB)) return true;
  }
  return false;
}

// ─── Volatility Scaling ──────────────────────────────────────────────

const VOLATILITY_MULTIPLIERS: Record<string, number> = {
  low: 1.0, // Normal sizing in low vol
  normal: 1.0, // Normal sizing
  high: 0.75, // Reduce 25% in high vol
  extreme: 0.5, // Halve size in extreme vol
};

export function resolveSizingVolatilityContext(
  regimeInfo?: {
    regime?: string | null;
    atrTrend?: string | null;
  } | null,
): VolatilityContext | undefined {
  if (!regimeInfo) return undefined;
  return {
    regime: regimeInfo.atrTrend === "expanding" ||
        regimeInfo.regime === "choppy_range"
      ? "high"
      : regimeInfo.atrTrend === "contracting"
      ? "low"
      : "normal",
    atrPercentile: undefined,
  };
}

export function resolveCorrelationSizeMultiplier(
  concentrationScore: number,
): number {
  if (!Number.isFinite(concentrationScore) || concentrationScore <= 0.5) {
    return 1;
  }
  return Math.max(0.5, 1 - (concentrationScore - 0.5));
}

/**
 * Applies the post-engine candidate adjustments shared by live and replay.
 * Correlation is applied first, then the signal-source multiplier, matching
 * the historical live execution order. A rejected size stays rejected.
 */
export function applyFinalCandidateSizeAdjustments(
  input: FinalCandidateSizeInput,
): FinalCandidateSizeResult {
  const correlationMultiplier = Math.max(
    0,
    Math.min(1, input.correlationMultiplier ?? 1),
  );
  const signalSourceMultiplier = input.signalSource === "unified" ? 1 : Math.max(0.1, Math.min(1, input.standaloneMultiplier ?? 0.5));
  const reject = (reason: string): FinalCandidateSizeResult => ({
    lots: 0,
    afterCorrelationLots: 0,
    correlationMultiplier,
    signalSourceMultiplier,
    rejected: true,
    rejectionReason: reason,
  });
  if (
    input.sizingResult.rejected ||
    !Number.isFinite(input.sizingResult.lots) ||
    input.sizingResult.lots <= 0
  ) {
    return reject(
      input.sizingResult.rejectionReason ||
        "Upstream position sizing rejected the candidate",
    );
  }

  let lots = input.sizingResult.lots;
  if (correlationMultiplier < 1) {
    lots = floorLotSize(lots * correlationMultiplier);
    if (lots < 0.01) {
      return reject("Correlation adjustment reduced size below the executable minimum");
    }
  }
  const afterCorrelationLots = lots;

  if (signalSourceMultiplier < 1) {
    lots = floorLotSize(lots * signalSourceMultiplier);
    if (lots < 0.01) {
      return reject("Signal-source adjustment reduced size below the executable minimum");
    }
  }

  return {
    lots,
    afterCorrelationLots,
    correlationMultiplier,
    signalSourceMultiplier,
    rejected: false,
  };
}

// ─── Main Sizing Function ────────────────────────────────────────────

/**
 * Compute position size with all safety layers applied.
 * This is the SINGLE function all live execution paths should use.
 */
export function computePositionSize(
  input: SizingInput,
  portfolio?: PortfolioContext,
  volatility?: VolatilityContext,
  propFirm?: PropFirmContext,
): SizingResult {
  const adjustments: SizingAdjustment[] = [];
  const spec = SPECS[input.symbol] || SPECS["EUR/USD"];

  // NEW: tightest USD risk budget implied by any hard cap below.
  // Stays Infinity if no cap tighter than the base size ever applied.
  let hardCapUSD = Infinity;

  const reject = (reason: string, baseLots = 0): SizingResult => ({
    lots: 0,
    riskUSD: 0,
    riskPercent: 0,
    baseLots,
    adjustments: [],
    rejected: true,
    rejectionReason: reason,
  });
  if (
    !Number.isFinite(input.balance) || input.balance <= 0 ||
    !Number.isFinite(input.entryPrice) || input.entryPrice <= 0 ||
    !Number.isFinite(input.stopLoss) || input.stopLoss <= 0 ||
    input.entryPrice === input.stopLoss
  ) {
    return reject("Position sizing requires a positive balance and distinct finite entry/stop prices");
  }
  if (input.method !== "fixed_lot" && (!Number.isFinite(input.riskPercent) || input.riskPercent <= 0)) {
    return reject("Position sizing requires a positive finite risk percentage");
  }
  if (
    input.method === "fixed_lot" &&
    (!Number.isFinite(Number(input.fixedLotSize)) || Number(input.fixedLotSize) < 0.01)
  ) {
    return reject("Fixed-lot sizing requires at least the 0.01 executable minimum");
  }
  if (
    input.commissionPerLot !== undefined &&
    (!Number.isFinite(input.commissionPerLot) || input.commissionPerLot < 0)
  ) {
    return reject("Position sizing requires a non-negative finite commission");
  }
  if (input.maxLot !== undefined && (!Number.isFinite(input.maxLot) || input.maxLot < 0.01)) {
    return reject("Position sizing maximum lot must allow the 0.01 executable minimum");
  }

  // Step 1: Calculate base position size using the shared function
  const baseLots = calculatePositionSize(
    input.balance,
    input.riskPercent,
    input.entryPrice,
    input.stopLoss,
    input.symbol,
    {
      positionSizingMethod: input.method || "percent_risk",
      fixedLotSize: input.fixedLotSize,
      atrValue: input.atrValue,
      atrVolatilityMultiplier: input.atrVolatilityMultiplier,
    },
    input.rateMap,
    input.maxLot,
    input.commissionPerLot,
  );

  let lots = baseLots;

  // Step 2: Portfolio heat check
  if (!Number.isFinite(baseLots) || baseLots <= 0) {
    return reject("Base position sizing produced no executable size", baseLots);
  }

  if (portfolio) {
    const maxHeat = portfolio.maxPortfolioHeat ?? 6.0;
    const currentHeat = portfolio.openPositions.reduce(
      (sum, p) => sum + p.riskUSD,
      0,
    );
    const currentHeatPercent = input.balance > 0 ? (currentHeat / input.balance) * 100 : 0;

    if (currentHeatPercent >= maxHeat) {
      return {
        lots: 0,
        riskUSD: 0,
        riskPercent: 0,
        baseLots,
        adjustments: [{
          type: "portfolio_heat",
          multiplier: 0,
          reason: `Portfolio heat ${currentHeatPercent.toFixed(1)}% >= max ${maxHeat}%`,
        }],
        rejected: true,
        rejectionReason: `Portfolio heat limit reached (${currentHeatPercent.toFixed(1)}% >= ${maxHeat}%)`,
      };
    }

    // Reduce size if approaching heat limit
    const remainingHeatPercent = maxHeat - currentHeatPercent;
    const thisTradeHeatPercent = input.riskPercent;
    if (thisTradeHeatPercent > remainingHeatPercent) {
      const heatMultiplier = remainingHeatPercent / thisTradeHeatPercent;
      lots = floorLotSize(lots * heatMultiplier);
      // This cap represents a real USD ceiling — remember it.
      hardCapUSD = Math.min(
        hardCapUSD,
        (remainingHeatPercent / 100) * input.balance,
      );
      adjustments.push({
        type: "portfolio_heat",
        multiplier: heatMultiplier,
        reason: `Reduced to fit remaining heat budget (${remainingHeatPercent.toFixed(1)}% remaining)`,
      });
    }
  }

  // Step 3: Correlation adjustment
  if (portfolio && portfolio.openPositions.length > 0) {
    const maxCorrelated = portfolio.maxCorrelatedExposure ?? 3.0;
    const correlatedRisk = portfolio.openPositions
      .filter((p) => areCorrelated(p.symbol, input.symbol))
      .reduce((sum, p) => sum + p.riskUSD, 0);
    const correlatedPercent = input.balance > 0 ? (correlatedRisk / input.balance) * 100 : 0;

    if (correlatedPercent >= maxCorrelated) {
      return {
        lots: 0,
        riskUSD: 0,
        riskPercent: 0,
        baseLots,
        adjustments: [{
          type: "correlation",
          multiplier: 0,
          reason: `Correlated exposure ${correlatedPercent.toFixed(1)}% >= max ${maxCorrelated}%`,
        }],
        rejected: true,
        rejectionReason: `Correlated exposure limit (${correlatedPercent.toFixed(1)}% in same group)`,
      };
    }

    // Reduce if approaching correlated limit
    const remainingCorrelated = maxCorrelated - correlatedPercent;
    if (input.riskPercent > remainingCorrelated && remainingCorrelated > 0) {
      const corrMultiplier = remainingCorrelated / input.riskPercent;
      lots = floorLotSize(lots * corrMultiplier);
      hardCapUSD = Math.min(
        hardCapUSD,
        (remainingCorrelated / 100) * input.balance,
      );
      adjustments.push({
        type: "correlation",
        multiplier: corrMultiplier,
        reason: `Correlated pairs at ${correlatedPercent.toFixed(1)}%, reducing to fit ${maxCorrelated}% cap`,
      });
    }
  }

  // Step 4: Volatility regime scaling
  if (volatility) {
    const volMultiplier = VOLATILITY_MULTIPLIERS[volatility.regime] ?? 1.0;
    if (volMultiplier < 1.0) {
      lots = floorLotSize(lots * volMultiplier);
      adjustments.push({
        type: "volatility",
        multiplier: volMultiplier,
        reason: `${volatility.regime} volatility regime (ATR percentile: ${volatility.atrPercentile ?? "?"}%)`,
      });
    }
  }

  // Step 5: Prop firm compliance
  if (propFirm?.enabled) {
    // Apply size multiplier from prop firm gate
    if (
      propFirm.sizeMultiplier !== undefined && propFirm.sizeMultiplier < 1.0
    ) {
      lots = floorLotSize(lots * propFirm.sizeMultiplier);
      adjustments.push({
        type: "prop_firm",
        multiplier: propFirm.sizeMultiplier,
        reason: `Prop firm size cap (${(propFirm.sizeMultiplier * 100).toFixed(0)}% multiplier)`,
      });
    }

    // Cap risk to daily loss remaining
    if (
      propFirm.dailyLossRemaining !== undefined &&
      propFirm.dailyLossRemaining > 0
    ) {
      const slDistance = Math.abs(input.entryPrice - input.stopLoss);
      const quoteToUSD = getQuoteToUSDRate(input.symbol, input.rateMap);
      const riskPerLot = slDistance * spec.lotUnits * quoteToUSD +
        (input.commissionPerLot ?? 0);
      if (riskPerLot > 0) {
        const maxLotsByDaily = propFirm.dailyLossRemaining / riskPerLot;
        if (lots > maxLotsByDaily) {
          const dailyMult = maxLotsByDaily / lots;
          lots = floorLotSize(maxLotsByDaily);
          // This is a hard USD ceiling by definition — remember it.
          hardCapUSD = Math.min(hardCapUSD, propFirm.dailyLossRemaining);
          adjustments.push({
            type: "prop_firm",
            multiplier: dailyMult,
            reason: `Capped to daily loss limit ($${propFirm.dailyLossRemaining.toFixed(0)} remaining)`,
          });
        }
      }
    }
  }

  // Step 6: Enforce minimum lot — but never past a hard budget cap.
  // Check both: lots that are positive but below 0.01, AND lots that rounded
  // to 0.00 due to 2-decimal rounding but had a hard cap applied (meaning the
  // intent was to size down, not reject outright).
  if ((lots < 0.01 && lots > 0) || (lots === 0 && hardCapUSD < Infinity)) {
    const slDistance = Math.abs(input.entryPrice - input.stopLoss);
    const quoteToUSD = getQuoteToUSDRate(input.symbol, input.rateMap);
    const riskAtMinLot = slDistance * spec.lotUnits * 0.01 * quoteToUSD +
      calculateRoundTripCommission(0.01, input.commissionPerLot ?? 0);

    if (riskAtMinLot > hardCapUSD) {
      // Flooring to 0.01 lots would breach the tightest hard cap that applied
      // (portfolio heat, correlation, or prop-firm daily loss). Reject instead
      // of silently taking on more risk than that cap allows.
      return {
        lots: 0,
        riskUSD: 0,
        riskPercent: 0,
        baseLots,
        adjustments: [...adjustments, {
          type: "min_lot_floor",
          multiplier: 0,
          reason: `Min lot (0.01) would risk $${riskAtMinLot.toFixed(2)}, exceeding remaining budget of $${hardCapUSD.toFixed(2)}`,
        }],
        rejected: true,
        rejectionReason: `Cannot size down to fit remaining risk budget ($${hardCapUSD.toFixed(2)}) without going below min lot`,
      };
    }

    lots = 0.01;
    adjustments.push({
      type: "min_lot_floor",
      multiplier: 0.01 / baseLots,
      reason: "Rounded up to minimum 0.01 lots",
    });
  }

  // Final rounding
  lots = floorLotSize(lots);

  // Calculate actual risk
  const slDistance = Math.abs(input.entryPrice - input.stopLoss);
  const quoteToUSD = getQuoteToUSDRate(input.symbol, input.rateMap);
  const priceRiskUSD = slDistance * spec.lotUnits * lots * quoteToUSD;
  const totalRiskUSD = priceRiskUSD + calculateRoundTripCommission(
    lots,
    input.commissionPerLot ?? 0,
  );
  const riskPct = input.balance > 0
    ? (totalRiskUSD / input.balance) * 100
    : 0;
  if (!Number.isFinite(totalRiskUSD) || !Number.isFinite(riskPct)) {
    return reject("Position sizing produced non-finite risk", baseLots);
  }
  if (input.method !== "fixed_lot" && lots === 0.01) {
    const riskBudgetUSD = input.balance * (input.riskPercent / 100);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(riskBudgetUSD)) * 8;
    if (totalRiskUSD > riskBudgetUSD + tolerance) {
      return {
        lots: 0,
        riskUSD: 0,
        riskPercent: 0,
        baseLots,
        adjustments: [...adjustments, {
          type: "min_lot_floor",
          multiplier: 0,
          reason: `Min lot would risk $${totalRiskUSD.toFixed(2)}, above the $${riskBudgetUSD.toFixed(2)} trade budget`,
        }],
        rejected: true,
        rejectionReason: "Minimum executable lot exceeds the configured trade risk budget",
      };
    }
  }

  return {
    lots,
    riskUSD: Math.round(totalRiskUSD * 100) / 100,
    riskPercent: Math.round(riskPct * 100) / 100,
    baseLots,
    adjustments,
    rejected: lots === 0,
    rejectionReason: lots === 0 ? "Size reduced to zero after adjustments" : undefined,
  };
}

// ─── Utility: Calculate risk for an existing position ────────────────

/**
 * Calculate the current all-in risk in USD for an open position.
 * Useful for building the PortfolioContext.openPositions array.
 */
export function calculatePositionRisk(
  symbol: string,
  entryPrice: number,
  stopLoss: number,
  lots: number,
  rateMap?: Record<string, number>,
  commissionPerLot?: number,
): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const slDistance = Math.abs(entryPrice - stopLoss);
  const quoteToUSD = getQuoteToUSDRate(symbol, rateMap);
  return slDistance * spec.lotUnits * lots * quoteToUSD +
    calculateRoundTripCommission(lots, commissionPerLot ?? 0);
}

// ─── Utility: Check if new trade would breach portfolio limits ───────

/**
 * Quick pre-check before running full sizing.
 * Returns true if the trade is allowed, false if it would breach limits.
 */
export function canOpenNewTrade(
  balance: number,
  riskPercent: number,
  openPositions: OpenPositionRisk[],
  symbol: string,
  maxPortfolioHeat: number = 6.0,
  maxCorrelatedExposure: number = 3.0,
): { allowed: boolean; reason?: string } {
  const currentHeat = openPositions.reduce((sum, p) => sum + p.riskUSD, 0);
  const currentHeatPercent = balance > 0 ? (currentHeat / balance) * 100 : 0;

  if (currentHeatPercent >= maxPortfolioHeat) {
    return {
      allowed: false,
      reason: `Portfolio heat ${currentHeatPercent.toFixed(1)}% >= ${maxPortfolioHeat}%`,
    };
  }

  const correlatedRisk = openPositions
    .filter((p) => areCorrelated(p.symbol, symbol))
    .reduce((sum, p) => sum + p.riskUSD, 0);
  const correlatedPercent = balance > 0 ? (correlatedRisk / balance) * 100 : 0;

  if (correlatedPercent >= maxCorrelatedExposure) {
    return {
      allowed: false,
      reason: `Correlated exposure ${correlatedPercent.toFixed(1)}% >= ${maxCorrelatedExposure}%`,
    };
  }

  return { allowed: true };
}
