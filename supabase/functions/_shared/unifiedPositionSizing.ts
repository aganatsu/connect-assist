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
 * This module does NOT replace calculatePositionSize() in smcAnalysis.ts.
 * Instead, it wraps it with additional safety layers. The raw function
 * remains available for backtesting where speed > safety.
 *
 * Usage:
 *   import { computePositionSize } from "../_shared/unifiedPositionSizing.ts";
 *   const result = computePositionSize({ ... });
 *   // result.lots, result.riskUSD, result.adjustments[]
 */

import { SPECS, calculatePositionSize, getQuoteToUSDRate } from "./smcAnalysis.ts";

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
  /** Risk in USD for this position */
  riskUSD: number;
  /** Risk as percentage of balance */
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
  type: "portfolio_heat" | "correlation" | "volatility" | "prop_firm" | "max_lot_cap" | "min_lot_floor";
  /** Multiplier applied (e.g., 0.5 = halved) */
  multiplier: number;
  /** Human-readable reason */
  reason: string;
}

// ─── Correlation Map ─────────────────────────────────────────────────

/** Known high-correlation pairs (|r| > 0.7 historically) */
const CORRELATION_GROUPS: Record<string, string[]> = {
  "USD_STRENGTH": ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"],
  "JPY_WEAKNESS": ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "CAD/JPY", "CHF/JPY", "NZD/JPY"],
  "COMMODITY": ["AUD/USD", "NZD/USD", "AUD/NZD", "AUD/CAD"],
  "EUR_CROSS": ["EUR/USD", "EUR/GBP", "EUR/JPY", "EUR/AUD", "EUR/NZD", "EUR/CAD", "EUR/CHF"],
  "GBP_CROSS": ["GBP/USD", "GBP/JPY", "GBP/AUD", "GBP/NZD", "GBP/CAD", "GBP/CHF", "EUR/GBP"],
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
  low: 1.0,      // Normal sizing in low vol
  normal: 1.0,   // Normal sizing
  high: 0.75,    // Reduce 25% in high vol
  extreme: 0.5,  // Halve size in extreme vol
};

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
  if (portfolio) {
    const maxHeat = portfolio.maxPortfolioHeat ?? 6.0;
    const currentHeat = portfolio.openPositions.reduce((sum, p) => sum + p.riskUSD, 0);
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
      lots = Math.round(lots * heatMultiplier * 100) / 100;
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
      lots = Math.round(lots * corrMultiplier * 100) / 100;
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
      lots = Math.round(lots * volMultiplier * 100) / 100;
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
    if (propFirm.sizeMultiplier !== undefined && propFirm.sizeMultiplier < 1.0) {
      lots = Math.round(lots * propFirm.sizeMultiplier * 100) / 100;
      adjustments.push({
        type: "prop_firm",
        multiplier: propFirm.sizeMultiplier,
        reason: `Prop firm size cap (${(propFirm.sizeMultiplier * 100).toFixed(0)}% multiplier)`,
      });
    }

    // Cap risk to daily loss remaining
    if (propFirm.dailyLossRemaining !== undefined && propFirm.dailyLossRemaining > 0) {
      const slDistance = Math.abs(input.entryPrice - input.stopLoss);
      const quoteToUSD = getQuoteToUSDRate(input.symbol, input.rateMap);
      const riskPerLot = slDistance * spec.lotUnits * quoteToUSD;
      if (riskPerLot > 0) {
        const maxLotsByDaily = propFirm.dailyLossRemaining / riskPerLot;
        if (lots > maxLotsByDaily) {
          const dailyMult = maxLotsByDaily / lots;
          lots = Math.round(maxLotsByDaily * 100) / 100;
          adjustments.push({
            type: "prop_firm",
            multiplier: dailyMult,
            reason: `Capped to daily loss limit ($${propFirm.dailyLossRemaining.toFixed(0)} remaining)`,
          });
        }
      }
    }
  }

  // Step 6: Enforce minimum lot
  if (lots < 0.01 && lots > 0) {
    lots = 0.01;
    adjustments.push({
      type: "min_lot_floor",
      multiplier: 0.01 / baseLots,
      reason: "Rounded up to minimum 0.01 lots",
    });
  }

  // Final rounding
  lots = Math.round(lots * 100) / 100;

  // Calculate actual risk
  const slDistance = Math.abs(input.entryPrice - input.stopLoss);
  const quoteToUSD = getQuoteToUSDRate(input.symbol, input.rateMap);
  const riskUSD = slDistance * spec.lotUnits * lots * quoteToUSD;
  const riskPct = input.balance > 0 ? (riskUSD / input.balance) * 100 : 0;

  return {
    lots,
    riskUSD: Math.round(riskUSD * 100) / 100,
    riskPercent: Math.round(riskPct * 100) / 100,
    baseLots,
    adjustments,
    rejected: lots === 0,
    rejectionReason: lots === 0 ? "Size reduced to zero after adjustments" : undefined,
  };
}

// ─── Utility: Calculate risk for an existing position ────────────────

/**
 * Calculate the current risk in USD for an open position.
 * Useful for building the PortfolioContext.openPositions array.
 */
export function calculatePositionRisk(
  symbol: string,
  entryPrice: number,
  stopLoss: number,
  lots: number,
  rateMap?: Record<string, number>,
): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const slDistance = Math.abs(entryPrice - stopLoss);
  const quoteToUSD = getQuoteToUSDRate(symbol, rateMap);
  return slDistance * spec.lotUnits * lots * quoteToUSD;
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
    return { allowed: false, reason: `Portfolio heat ${currentHeatPercent.toFixed(1)}% >= ${maxPortfolioHeat}%` };
  }

  const correlatedRisk = openPositions
    .filter((p) => areCorrelated(p.symbol, symbol))
    .reduce((sum, p) => sum + p.riskUSD, 0);
  const correlatedPercent = balance > 0 ? (correlatedRisk / balance) * 100 : 0;

  if (correlatedPercent >= maxCorrelatedExposure) {
    return { allowed: false, reason: `Correlated exposure ${correlatedPercent.toFixed(1)}% >= ${maxCorrelatedExposure}%` };
  }

  return { allowed: true };
}
