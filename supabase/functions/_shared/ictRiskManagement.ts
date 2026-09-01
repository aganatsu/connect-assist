/**
 * ictRiskManagement.ts — ICT Risk Management Rules
 * ═════════════════════════════════════════════════
 *
 * ICT Risk Management principles from the 2022 Mentorship:
 *
 * 1. DRAWDOWN HALVING
 *    After a losing trade, cut risk in half for the next trade.
 *    After 2 consecutive losses, cut to 25% of original.
 *    After a winner, restore to normal risk.
 *
 * 2. DAILY LOSS LIMIT
 *    Max 1% account loss per day. Once hit, stop trading for the day.
 *    ICT recommends 0.5% risk per trade, max 2 trades per day.
 *
 * 3. WEEKLY LOSS LIMIT
 *    Max 2.5% account loss per week. Once hit, stop for the week.
 *
 * 4. PARTIAL TAKE PROFIT (ICT's method)
 *    - First partial at 1:1 RR (take 50% off)
 *    - Move SL to break-even after first partial
 *    - Trail remaining with structure (swing lows/highs)
 *    - Final target at opposing liquidity pool or HTF POI
 *
 * 5. FVG RULE OF 2 (Exit rule)
 *    If price returns to the FVG that triggered your entry a SECOND time,
 *    close the trade — the FVG has been "used up."
 *
 * 6. POSITION SIZING
 *    Risk per trade = account equity × risk% / (entry - SL distance)
 *    Never risk more than 1% on a single trade.
 *    ICT recommends 0.5% for learning, 1% max for experienced.
 */

// ─── Configuration ────────────────────────────────────────────────────
export interface ICTRiskConfig {
  enabled: boolean;
  /** Base risk per trade as decimal (0.005 = 0.5%, 0.01 = 1%) */
  baseRiskPercent: number;
  /** Enable drawdown halving after losses */
  drawdownHalving: boolean;
  /** Max consecutive losses before halving resets (stop trading) */
  maxConsecutiveLossesBeforeStop: number;
  /** Daily loss limit as decimal (0.01 = 1%) */
  dailyLossLimit: number;
  /** Weekly loss limit as decimal (0.025 = 2.5%) */
  weeklyLossLimit: number;
  /** Max trades per day */
  maxTradesPerDay: number;
  /** Enable FVG Rule of 2 exit */
  fvgRuleOfTwoExit: boolean;
  /** Partial TP at 1:1 RR (percentage to close) */
  partialTPPercent: number;
  /** Move to BE after first partial */
  moveToBEAfterPartial: boolean;
}

export const DEFAULT_ICT_RISK_CONFIG: ICTRiskConfig = {
  enabled: true,
  baseRiskPercent: 0.01,
  drawdownHalving: true,
  maxConsecutiveLossesBeforeStop: 3,
  dailyLossLimit: 0.01,
  weeklyLossLimit: 0.025,
  maxTradesPerDay: 3,
  fvgRuleOfTwoExit: true,
  partialTPPercent: 50,
  moveToBEAfterPartial: true,
};

// ─── Types ────────────────────────────────────────────────────────────
export interface DrawdownState {
  consecutiveLosses: number;
  currentRiskMultiplier: number;
  effectiveRiskPercent: number;
  shouldStopTrading: boolean;
  reason: string;
}

export interface DailyLimitState {
  tradesToday: number;
  dailyPnLPercent: number;
  canTrade: boolean;
  reason: string;
}

export interface WeeklyLimitState {
  weeklyPnLPercent: number;
  canTrade: boolean;
  reason: string;
}

export interface PositionSizeResult {
  lots: number;
  riskAmount: number;
  effectiveRiskPercent: number;
  slDistancePips: number;
  reason: string;
}

export interface ICTRiskAssessment {
  canTrade: boolean;
  effectiveRiskPercent: number;
  riskMultiplier: number;
  drawdownState: DrawdownState;
  dailyState: DailyLimitState;
  weeklyState: WeeklyLimitState;
  reasons: string[];
}

// ─── Drawdown Halving ─────────────────────────────────────────────────

/**
 * Calculate the effective risk based on consecutive losses (ICT drawdown halving).
 *
 * @param consecutiveLosses - Number of consecutive losing trades
 * @param config - Risk configuration
 */
export function calculateDrawdownRisk(
  consecutiveLosses: number,
  config: ICTRiskConfig = DEFAULT_ICT_RISK_CONFIG,
): DrawdownState {
  if (!config.drawdownHalving || consecutiveLosses === 0) {
    return {
      consecutiveLosses,
      currentRiskMultiplier: 1.0,
      effectiveRiskPercent: config.baseRiskPercent,
      shouldStopTrading: false,
      reason: consecutiveLosses === 0 ? "No consecutive losses — full risk" : "Drawdown halving disabled",
    };
  }

  if (consecutiveLosses >= config.maxConsecutiveLossesBeforeStop) {
    return {
      consecutiveLosses,
      currentRiskMultiplier: 0,
      effectiveRiskPercent: 0,
      shouldStopTrading: true,
      reason: `${consecutiveLosses} consecutive losses — STOP TRADING (max: ${config.maxConsecutiveLossesBeforeStop})`,
    };
  }

  // Halve risk for each consecutive loss: 1 loss = 50%, 2 losses = 25%, etc.
  const multiplier = Math.pow(0.5, consecutiveLosses);
  const effectiveRisk = config.baseRiskPercent * multiplier;

  return {
    consecutiveLosses,
    currentRiskMultiplier: multiplier,
    effectiveRiskPercent: effectiveRisk,
    shouldStopTrading: false,
    reason: `${consecutiveLosses} consecutive loss${consecutiveLosses > 1 ? "es" : ""} — risk halved to ${(effectiveRisk * 100).toFixed(2)}%`,
  };
}

// ─── Daily/Weekly Limits ──────────────────────────────────────────────

/**
 * Check if daily trading limits have been reached.
 *
 * @param tradesToday - Number of trades taken today
 * @param dailyPnLPercent - Today's P&L as decimal (negative = loss)
 * @param config - Risk configuration
 */
export function checkDailyLimit(
  tradesToday: number,
  dailyPnLPercent: number,
  config: ICTRiskConfig = DEFAULT_ICT_RISK_CONFIG,
): DailyLimitState {
  if (!config.enabled) {
    return { tradesToday, dailyPnLPercent, canTrade: true, reason: "Risk management disabled" };
  }

  if (dailyPnLPercent <= -config.dailyLossLimit) {
    return {
      tradesToday,
      dailyPnLPercent,
      canTrade: false,
      reason: `Daily loss limit hit: ${(dailyPnLPercent * 100).toFixed(2)}% (limit: -${(config.dailyLossLimit * 100).toFixed(1)}%)`,
    };
  }

  if (tradesToday >= config.maxTradesPerDay) {
    return {
      tradesToday,
      dailyPnLPercent,
      canTrade: false,
      reason: `Max trades per day reached: ${tradesToday}/${config.maxTradesPerDay}`,
    };
  }

  return {
    tradesToday,
    dailyPnLPercent,
    canTrade: true,
    reason: `Daily OK: ${tradesToday}/${config.maxTradesPerDay} trades, PnL: ${(dailyPnLPercent * 100).toFixed(2)}%`,
  };
}

/**
 * Check if weekly trading limits have been reached.
 *
 * @param weeklyPnLPercent - This week's P&L as decimal (negative = loss)
 * @param config - Risk configuration
 */
export function checkWeeklyLimit(
  weeklyPnLPercent: number,
  config: ICTRiskConfig = DEFAULT_ICT_RISK_CONFIG,
): WeeklyLimitState {
  if (!config.enabled) {
    return { weeklyPnLPercent, canTrade: true, reason: "Risk management disabled" };
  }

  if (weeklyPnLPercent <= -config.weeklyLossLimit) {
    return {
      weeklyPnLPercent,
      canTrade: false,
      reason: `Weekly loss limit hit: ${(weeklyPnLPercent * 100).toFixed(2)}% (limit: -${(config.weeklyLossLimit * 100).toFixed(1)}%)`,
    };
  }

  return {
    weeklyPnLPercent,
    canTrade: true,
    reason: `Weekly OK: PnL ${(weeklyPnLPercent * 100).toFixed(2)}% (limit: -${(config.weeklyLossLimit * 100).toFixed(1)}%)`,
  };
}

// ─── Position Sizing ──────────────────────────────────────────────────

/**
 * Calculate position size using ICT's method.
 *
 * @param accountEquity - Account equity in base currency
 * @param entryPrice - Entry price
 * @param stopLossPrice - Stop loss price
 * @param effectiveRiskPercent - Risk per trade (after drawdown halving)
 * @param pipValue - Value per pip per lot (depends on pair and account currency)
 */
export function calculatePositionSize(
  accountEquity: number,
  entryPrice: number,
  stopLossPrice: number,
  effectiveRiskPercent: number,
  pipValue: number,
): PositionSizeResult {
  if (accountEquity <= 0 || pipValue <= 0 || effectiveRiskPercent <= 0) {
    return { lots: 0, riskAmount: 0, effectiveRiskPercent, slDistancePips: 0, reason: "Invalid inputs" };
  }

  const slDistance = Math.abs(entryPrice - stopLossPrice);
  if (slDistance <= 0) {
    return { lots: 0, riskAmount: 0, effectiveRiskPercent, slDistancePips: 0, reason: "SL distance is zero" };
  }

  // Convert SL distance to pips (assuming 4/5 decimal places for forex)
  const pipSize = entryPrice > 10 ? 0.01 : 0.0001; // JPY pairs vs others
  const slDistancePips = slDistance / pipSize;

  const riskAmount = accountEquity * effectiveRiskPercent;
  const lots = riskAmount / (slDistancePips * pipValue);

  return {
    lots: Math.round(lots * 100) / 100, // Round to 2 decimal places
    riskAmount,
    effectiveRiskPercent,
    slDistancePips,
    reason: `${(effectiveRiskPercent * 100).toFixed(2)}% risk = $${riskAmount.toFixed(2)} / ${slDistancePips.toFixed(1)} pips = ${lots.toFixed(2)} lots`,
  };
}

// ─── Full Risk Assessment ─────────────────────────────────────────────

/**
 * Comprehensive risk assessment combining all ICT risk rules.
 *
 * @param params - All parameters needed for risk assessment
 */
export function assessRisk(params: {
  consecutiveLosses: number;
  tradesToday: number;
  dailyPnLPercent: number;
  weeklyPnLPercent: number;
  config: ICTRiskConfig;
}): ICTRiskAssessment {
  const { consecutiveLosses, tradesToday, dailyPnLPercent, weeklyPnLPercent, config } = params;

  if (!config.enabled) {
    return {
      canTrade: true,
      effectiveRiskPercent: config.baseRiskPercent,
      riskMultiplier: 1.0,
      drawdownState: calculateDrawdownRisk(0, config),
      dailyState: checkDailyLimit(0, 0, config),
      weeklyState: checkWeeklyLimit(0, config),
      reasons: ["Risk management disabled"],
    };
  }

  const drawdownState = calculateDrawdownRisk(consecutiveLosses, config);
  const dailyState = checkDailyLimit(tradesToday, dailyPnLPercent, config);
  const weeklyState = checkWeeklyLimit(weeklyPnLPercent, config);

  const reasons: string[] = [];
  let canTrade = true;

  if (drawdownState.shouldStopTrading) {
    canTrade = false;
    reasons.push(drawdownState.reason);
  }
  if (!dailyState.canTrade) {
    canTrade = false;
    reasons.push(dailyState.reason);
  }
  if (!weeklyState.canTrade) {
    canTrade = false;
    reasons.push(weeklyState.reason);
  }

  if (canTrade) {
    reasons.push(`OK: ${drawdownState.effectiveRiskPercent * 100}% risk, ${tradesToday}/${config.maxTradesPerDay} trades today`);
  }

  return {
    canTrade,
    effectiveRiskPercent: drawdownState.effectiveRiskPercent,
    riskMultiplier: drawdownState.currentRiskMultiplier,
    drawdownState,
    dailyState,
    weeklyState,
    reasons,
  };
}
