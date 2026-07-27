/**
 * Shared Min R:R gate check.
 *
 * Computes effective risk:reward after deducting spread cost (and optionally
 * commission cost) from the raw reward. Returns a gate result indicating
 * pass/fail with a descriptive reason string.
 *
 * Used by both bot-scanner (live) and backtest-engine.
 *
 * Bot-scanner supplies commissionPerLot + rateMap for full cost accounting.
 * Backtest-engine supplies only spreadPips (commission not modeled in backtest).
 */

import { SPECS } from "./smcAnalysis.ts";
import { getQuoteToUSDRate } from "./smcAnalysis.ts";

export interface MinRRGateInput {
  /** Current price */
  lastPrice: number;
  /** Stop loss price */
  stopLoss: number | null | undefined;
  /** Take profit price */
  takeProfit: number | null | undefined;
  /** Symbol (e.g. "EUR/USD", "XAU/USD") */
  symbol: string;
  /** Minimum acceptable effective R:R */
  minRiskReward: number;
  /**
   * Spread in pips to use. If provided and > 0, overrides the symbol's
   * typicalSpread from SPECS. Used by backtest-engine which has per-candle
   * spread data.
   */
  spreadPipsOverride?: number;
  /**
   * Average commission per standard lot in USD. When provided (> 0),
   * commission cost is converted to price-movement equivalent and added
   * to the spread cost. Used by bot-scanner (live).
   */
  commissionPerLot?: number;
  /**
   * Rate map for converting commission from USD to price terms.
   * Required when commissionPerLot > 0.
   */
  rateMap?: Record<string, number>;
}

export interface MinRRGateResult {
  passed: boolean;
  reason: string;
}

/**
 * Check whether the effective R:R (after spread + optional commission costs)
 * meets the minimum threshold.
 */
export function checkMinRR(input: MinRRGateInput): MinRRGateResult {
  const { lastPrice, stopLoss, takeProfit, symbol, minRiskReward } = input;

  if (!stopLoss || !takeProfit) {
    return { passed: false, reason: "No valid SL/TP for R:R check" };
  }

  const pairSpec = SPECS[symbol] || SPECS["EUR/USD"];
  const risk = Math.abs(lastPrice - stopLoss);
  const rawReward = Math.abs(takeProfit - lastPrice);

  // Spread cost in price terms
  const effectiveSpreadPips = (input.spreadPipsOverride && input.spreadPipsOverride > 0)
    ? input.spreadPipsOverride
    : (pairSpec.typicalSpread ?? 1);
  const spreadCostInPrice = effectiveSpreadPips * pairSpec.pipSize;

  // Commission cost in price terms (optional — live path only)
  let commCostInPrice = 0;
  const commPerLot = input.commissionPerLot ?? 0;
  if (commPerLot > 0) {
    const quoteToUSD = getQuoteToUSDRate(symbol, input.rateMap);
    commCostInPrice = commPerLot / (pairSpec.lotUnits * quoteToUSD);
  }

  const totalCostInPrice = spreadCostInPrice + commCostInPrice;
  const effectiveReward = Math.max(0, rawReward - totalCostInPrice);
  const rawRR = risk > 0 ? rawReward / risk : 0;
  const effectiveRR = risk > 0 ? effectiveReward / risk : 0;

  // Build cost detail string
  let costDetail: string;
  if (commPerLot > 0) {
    costDetail = `spread ${effectiveSpreadPips}p + comm $${commPerLot.toFixed(1)}/lot`;
  } else {
    costDetail = `spread ${effectiveSpreadPips.toFixed(1)}p`;
  }

  if (effectiveRR < minRiskReward) {
    return {
      passed: false,
      reason: `R:R ${rawRR.toFixed(2)} raw, ${effectiveRR.toFixed(2)} effective (${costDetail}) < ${minRiskReward} min`,
    };
  }

  return {
    passed: true,
    reason: `R:R ${effectiveRR.toFixed(2)} effective (${rawRR.toFixed(2)} raw, ${costDetail})`,
  };
}
