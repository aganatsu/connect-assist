/**
 * Prop Firm Risk Management — Pure Calculation Library
 *
 * Implements FTMO 2-Step Swing compliance logic:
 * - Equity-based daily loss (from day-start BALANCE, measured against current EQUITY)
 * - Fixed max drawdown (from initial balance, never trails)
 * - Profit target detection
 * - Graduated position size reduction near limits
 * - Emergency close-all threshold
 *
 * All functions are pure (no side effects, no DB calls) for testability.
 * The bot-scanner and scannerManagement modules call these and handle persistence.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type FirmType = "ftmo_2step" | "ftmo_1step" | "generic";
export type AccountStage = "challenge" | "verification" | "funded";
export type EventSeverity = "info" | "warning" | "critical";
export type CheckSeverity = "ok" | "warning" | "soft_lock" | "hard_lock";

export type PropFirmEventType =
  | "daily_warning"
  | "daily_soft_lock"
  | "daily_hard_lock"
  | "drawdown_warning"
  | "drawdown_breach"
  | "target_reached"
  | "target_warning"
  | "emergency_close"
  | "size_reduction"
  | "day_reset"
  | "best_day_warning";

export interface PropFirmConfig {
  id: string;
  user_id: string;
  bot_id: string;
  firm_type: FirmType;
  account_stage: AccountStage;
  initial_balance: number;
  account_currency: string;
  max_daily_loss_pct: number;       // e.g., 0.05 = 5%
  max_overall_loss_pct: number;     // e.g., 0.10 = 10%
  profit_target_pct: number | null; // e.g., 0.10 = 10%, null for funded
  best_day_rule_pct: number | null; // e.g., 0.50, null unless 1-step
  trailing_drawdown: boolean;
  safety_buffer_pct: number;        // e.g., 0.008 = 0.8%
  emergency_close_pct: number;      // e.g., 0.002 = 0.2%
  close_on_breach: boolean;
  reduce_size_near_limit: boolean;
  size_reduction_threshold_pct: number; // e.g., 0.6 = reduce at 60% of limit used
  day_reset_hour_utc: number;       // e.g., 22 (00:00 CEST summer)
  is_active: boolean;
}

export interface PropFirmDailyState {
  id: string;
  config_id: string;
  trading_day: string;              // ISO date string "YYYY-MM-DD"
  day_start_balance: number;
  day_start_equity: number;
  highest_equity_today: number;
  lowest_equity_today: number;
  current_equity: number | null;
  end_of_day_balance: number | null;
  highest_eod_balance_ever: number;
  realized_pnl_today: number;
  trade_count_today: number;
  is_locked: boolean;
  locked_at: string | null;
  lock_reason: string | null;
}

export interface PropFirmCheckResult {
  allowed: boolean;
  reason: string;
  severity: CheckSeverity;
  maxPositionSizeMultiplier: number; // 1.0 = full, 0.5 = half, 0 = blocked
  shouldCloseAll: boolean;
  event?: {
    type: PropFirmEventType;
    severity: EventSeverity;
    message: string;
  };
}

export interface PropFirmComplianceResult {
  dailyLoss: PropFirmCheckResult;
  maxDrawdown: PropFirmCheckResult;
  profitTarget: PropFirmCheckResult | null;
  overall: PropFirmCheckResult;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** FTMO 2-Step defaults */
export const FTMO_2STEP_DEFAULTS: Omit<PropFirmConfig, "id" | "user_id" | "bot_id"> = {
  firm_type: "ftmo_2step",
  account_stage: "challenge",
  initial_balance: 100_000,
  account_currency: "USD",
  max_daily_loss_pct: 0.05,
  max_overall_loss_pct: 0.10,
  profit_target_pct: 0.10,
  best_day_rule_pct: null,
  trailing_drawdown: false,
  safety_buffer_pct: 0.008,
  emergency_close_pct: 0.002,
  close_on_breach: true,
  reduce_size_near_limit: true,
  size_reduction_threshold_pct: 0.60,
  day_reset_hour_utc: 22, // 00:00 CEST (summer) = 22:00 UTC
  is_active: true,
};

/** FTMO 1-Step defaults */
export const FTMO_1STEP_DEFAULTS: Omit<PropFirmConfig, "id" | "user_id" | "bot_id"> = {
  ...FTMO_2STEP_DEFAULTS,
  firm_type: "ftmo_1step",
  max_daily_loss_pct: 0.03,
  trailing_drawdown: true,
  best_day_rule_pct: 0.50,
};

// ─── Core Calculation Functions ───────────────────────────────────────────────

/**
 * Calculate the current daily loss as a fraction of initial balance.
 *
 * FTMO formula: dailyLoss = dayStartBalance - currentEquity
 * The starting reference is the ACCOUNT BALANCE at 00:00 CEST (not equity).
 * The current measurement uses EQUITY (includes floating P&L).
 *
 * Returns a positive number when in loss (e.g., 0.03 = 3% daily loss).
 */
export function calculateDailyLoss(
  dayStartBalance: number,
  currentEquity: number,
): number {
  if (dayStartBalance <= 0) return 0;
  const loss = dayStartBalance - currentEquity;
  return Math.max(0, loss / dayStartBalance);
}

/**
 * Calculate the daily loss limit in absolute dollars.
 *
 * FTMO uses initial_balance as the denominator for the percentage,
 * NOT the day-start balance. So 5% of $100K = $5,000 always.
 */
export function calculateDailyLossLimit(config: PropFirmConfig): number {
  return config.initial_balance * config.max_daily_loss_pct;
}

/**
 * Calculate the max drawdown floor (the equity level that must never be touched).
 *
 * For 2-Step (fixed): floor = initialBalance * (1 - maxOverallLossPct)
 * For 1-Step (trailing): floor = highestEODBalance - (initialBalance * maxOverallLossPct)
 *
 * The floor never moves down.
 */
export function calculateDrawdownFloor(
  config: PropFirmConfig,
  highestEODBalance: number,
): number {
  if (config.trailing_drawdown) {
    // 1-Step: trails highest end-of-day balance
    return highestEODBalance - (config.initial_balance * config.max_overall_loss_pct);
  }
  // 2-Step: fixed from initial balance
  return config.initial_balance * (1 - config.max_overall_loss_pct);
}

/**
 * Calculate the profit target level.
 * Returns null if no target (funded accounts).
 */
export function calculateProfitTarget(config: PropFirmConfig): number | null {
  if (config.profit_target_pct == null) return null;
  return config.initial_balance * (1 + config.profit_target_pct);
}

/**
 * Determine the current CEST trading day for a given UTC timestamp.
 *
 * FTMO resets at 00:00 CE(S)T:
 * - Summer (CEST, UTC+2): reset at 22:00 UTC
 * - Winter (CET, UTC+1): reset at 23:00 UTC
 *
 * The `resetHourUTC` parameter controls this (22 for summer, 23 for winter).
 * Returns the trading day as "YYYY-MM-DD" in CEST timezone.
 */
export function getCESTTradingDay(utcDate: Date, resetHourUTC: number): string {
  const utcHour = utcDate.getUTCHours();
  const utcDay = new Date(utcDate);

  // If we're past the reset hour, we're in the NEXT trading day
  if (utcHour >= resetHourUTC) {
    utcDay.setUTCDate(utcDay.getUTCDate() + 1);
  }

  return utcDay.toISOString().slice(0, 10);
}

/**
 * Determine if we're currently in European Summer Time (CEST) or Winter Time (CET).
 * CEST runs from last Sunday of March to last Sunday of October.
 *
 * Returns the appropriate reset hour in UTC (22 for CEST, 23 for CET).
 */
export function getResetHourUTC(utcDate: Date): number {
  const year = utcDate.getUTCFullYear();

  // Last Sunday of March (CEST starts)
  const marchLast = new Date(Date.UTC(year, 2, 31)); // March 31
  while (marchLast.getUTCDay() !== 0) marchLast.setUTCDate(marchLast.getUTCDate() - 1);
  const cestStart = new Date(Date.UTC(year, marchLast.getUTCMonth(), marchLast.getUTCDate(), 1, 0, 0)); // 01:00 UTC

  // Last Sunday of October (CET starts)
  const octLast = new Date(Date.UTC(year, 9, 31)); // October 31
  while (octLast.getUTCDay() !== 0) octLast.setUTCDate(octLast.getUTCDate() - 1);
  const cetStart = new Date(Date.UTC(year, octLast.getUTCMonth(), octLast.getUTCDate(), 1, 0, 0)); // 01:00 UTC

  // If between CEST start and CET start → summer time → reset at 22:00 UTC
  if (utcDate >= cestStart && utcDate < cetStart) {
    return 22;
  }
  // Otherwise winter time → reset at 23:00 UTC
  return 23;
}

// ─── Check Functions ──────────────────────────────────────────────────────────

/**
 * Check daily loss compliance.
 *
 * Thresholds:
 * - OK: loss < safetyBuffer threshold (60% of limit by default)
 * - Warning: loss >= 60% of limit
 * - Soft lock: loss >= (limit - safetyBuffer) → block new entries
 * - Hard lock: loss >= (limit - emergencyClose) → close all positions
 */
export function checkDailyLoss(
  config: PropFirmConfig,
  dailyState: PropFirmDailyState,
  currentEquity: number,
): PropFirmCheckResult {
  const dailyLossAbsolute = dailyState.day_start_balance - currentEquity;
  const dailyLossLimit = calculateDailyLossLimit(config);
  const dailyLossPct = dailyState.day_start_balance > 0
    ? dailyLossAbsolute / dailyState.day_start_balance
    : 0;

  // If in profit or no loss, all clear
  if (dailyLossAbsolute <= 0) {
    return {
      allowed: true,
      reason: `Daily P&L: +$${Math.abs(dailyLossAbsolute).toFixed(2)} (limit: -$${dailyLossLimit.toFixed(2)})`,
      severity: "ok",
      maxPositionSizeMultiplier: 1.0,
      shouldCloseAll: false,
    };
  }

  const usageRatio = dailyLossAbsolute / dailyLossLimit; // 0 to 1+

  // Hard lock: within emergency_close_pct of actual breach
  const emergencyThreshold = dailyLossLimit * (1 - config.emergency_close_pct / config.max_daily_loss_pct);
  if (dailyLossAbsolute >= emergencyThreshold) {
    return {
      allowed: false,
      reason: `DAILY LOSS EMERGENCY: -$${dailyLossAbsolute.toFixed(2)} (${(dailyLossPct * 100).toFixed(2)}%) — limit $${dailyLossLimit.toFixed(2)} (${(config.max_daily_loss_pct * 100).toFixed(1)}%)`,
      severity: "hard_lock",
      maxPositionSizeMultiplier: 0,
      shouldCloseAll: config.close_on_breach,
      event: {
        type: "daily_hard_lock",
        severity: "critical",
        message: `Daily loss -$${dailyLossAbsolute.toFixed(2)} hit emergency threshold. All positions closed.`,
      },
    };
  }

  // Soft lock: within safety_buffer_pct of breach
  const safetyThreshold = dailyLossLimit * (1 - config.safety_buffer_pct / config.max_daily_loss_pct);
  if (dailyLossAbsolute >= safetyThreshold) {
    return {
      allowed: false,
      reason: `Daily loss soft lock: -$${dailyLossAbsolute.toFixed(2)} (${(dailyLossPct * 100).toFixed(2)}%) — safety buffer reached`,
      severity: "soft_lock",
      maxPositionSizeMultiplier: 0,
      shouldCloseAll: false,
      event: {
        type: "daily_soft_lock",
        severity: "warning",
        message: `Daily loss -$${dailyLossAbsolute.toFixed(2)} reached safety buffer. New entries blocked.`,
      },
    };
  }

  // Warning: past the size reduction threshold
  if (config.reduce_size_near_limit && usageRatio >= config.size_reduction_threshold_pct) {
    // Linear reduction: at 60% usage → 1.0x, at 100% usage → 0.0x
    const reductionRange = 1 - config.size_reduction_threshold_pct;
    const reductionProgress = (usageRatio - config.size_reduction_threshold_pct) / reductionRange;
    const multiplier = Math.max(0.25, 1 - reductionProgress); // Floor at 25% size

    return {
      allowed: true,
      reason: `Daily loss warning: -$${dailyLossAbsolute.toFixed(2)} (${(dailyLossPct * 100).toFixed(2)}%) — position size reduced to ${(multiplier * 100).toFixed(0)}%`,
      severity: "warning",
      maxPositionSizeMultiplier: multiplier,
      shouldCloseAll: false,
      event: {
        type: "daily_warning",
        severity: "warning",
        message: `Daily loss at ${(usageRatio * 100).toFixed(0)}% of limit. Position size reduced.`,
      },
    };
  }

  // OK: well within limits
  return {
    allowed: true,
    reason: `Daily loss: -$${dailyLossAbsolute.toFixed(2)} (${(dailyLossPct * 100).toFixed(2)}%) — limit $${dailyLossLimit.toFixed(2)}`,
    severity: "ok",
    maxPositionSizeMultiplier: 1.0,
    shouldCloseAll: false,
  };
}

/**
 * Check max drawdown compliance.
 *
 * For 2-Step: fixed floor = initialBalance * 0.90
 * For 1-Step: trailing floor = highestEODBalance - (initialBalance * 0.10)
 */
export function checkMaxDrawdown(
  config: PropFirmConfig,
  dailyState: PropFirmDailyState,
  currentEquity: number,
): PropFirmCheckResult {
  const floor = calculateDrawdownFloor(config, dailyState.highest_eod_balance_ever);
  const distanceToFloor = currentEquity - floor;
  const totalAllowedDrawdown = config.initial_balance * config.max_overall_loss_pct;
  const currentDrawdown = dailyState.highest_eod_balance_ever - currentEquity;
  const drawdownPct = dailyState.highest_eod_balance_ever > 0
    ? currentDrawdown / dailyState.highest_eod_balance_ever
    : 0;

  // If equity is well above floor
  if (distanceToFloor > totalAllowedDrawdown * 0.4) {
    return {
      allowed: true,
      reason: `Max drawdown: $${currentDrawdown.toFixed(2)} (${(drawdownPct * 100).toFixed(2)}%) — floor $${floor.toFixed(2)}`,
      severity: "ok",
      maxPositionSizeMultiplier: 1.0,
      shouldCloseAll: false,
    };
  }

  // Emergency: within emergency_close_pct of floor
  const emergencyBuffer = config.initial_balance * config.emergency_close_pct;
  if (distanceToFloor <= emergencyBuffer) {
    return {
      allowed: false,
      reason: `DRAWDOWN EMERGENCY: equity $${currentEquity.toFixed(2)} within $${distanceToFloor.toFixed(2)} of floor $${floor.toFixed(2)}`,
      severity: "hard_lock",
      maxPositionSizeMultiplier: 0,
      shouldCloseAll: config.close_on_breach,
      event: {
        type: "drawdown_breach",
        severity: "critical",
        message: `Equity $${currentEquity.toFixed(2)} approaching max drawdown floor $${floor.toFixed(2)}. Emergency close triggered.`,
      },
    };
  }

  // Soft lock: within safety_buffer of floor
  const safetyBuffer = config.initial_balance * config.safety_buffer_pct;
  if (distanceToFloor <= safetyBuffer) {
    return {
      allowed: false,
      reason: `Drawdown soft lock: equity $${currentEquity.toFixed(2)} within safety buffer of floor $${floor.toFixed(2)}`,
      severity: "soft_lock",
      maxPositionSizeMultiplier: 0,
      shouldCloseAll: false,
      event: {
        type: "drawdown_warning",
        severity: "warning",
        message: `Equity $${currentEquity.toFixed(2)} near max drawdown floor. New entries blocked.`,
      },
    };
  }

  // Warning: approaching floor (within 40% of allowed drawdown remaining)
  const usageRatio = 1 - (distanceToFloor / totalAllowedDrawdown);
  if (config.reduce_size_near_limit && usageRatio >= config.size_reduction_threshold_pct) {
    const reductionRange = 1 - config.size_reduction_threshold_pct;
    const reductionProgress = (usageRatio - config.size_reduction_threshold_pct) / reductionRange;
    const multiplier = Math.max(0.25, 1 - reductionProgress);

    return {
      allowed: true,
      reason: `Drawdown warning: ${(drawdownPct * 100).toFixed(2)}% — position size reduced to ${(multiplier * 100).toFixed(0)}%`,
      severity: "warning",
      maxPositionSizeMultiplier: multiplier,
      shouldCloseAll: false,
      event: {
        type: "drawdown_warning",
        severity: "warning",
        message: `Drawdown at ${(usageRatio * 100).toFixed(0)}% of limit. Position size reduced.`,
      },
    };
  }

  return {
    allowed: true,
    reason: `Max drawdown: $${currentDrawdown.toFixed(2)} (${(drawdownPct * 100).toFixed(2)}%) — floor $${floor.toFixed(2)}`,
    severity: "ok",
    maxPositionSizeMultiplier: 1.0,
    shouldCloseAll: false,
  };
}

/**
 * Check profit target compliance.
 * When target is reached, block new entries (don't give profits back).
 */
export function checkProfitTarget(
  config: PropFirmConfig,
  currentBalance: number,
): PropFirmCheckResult | null {
  const target = calculateProfitTarget(config);
  if (target == null) return null; // No target (funded account)

  const progress = (currentBalance - config.initial_balance) / (target - config.initial_balance);
  const profitDollars = currentBalance - config.initial_balance;

  if (currentBalance >= target) {
    return {
      allowed: false,
      reason: `🎯 PROFIT TARGET REACHED: $${profitDollars.toFixed(2)} profit (${(progress * 100).toFixed(1)}% of target)`,
      severity: "soft_lock",
      maxPositionSizeMultiplier: 0,
      shouldCloseAll: false, // Don't close — let existing winners run, just block new entries
      event: {
        type: "target_reached",
        severity: "info",
        message: `Profit target reached! Balance $${currentBalance.toFixed(2)} >= target $${target.toFixed(2)}. Stop trading and request evaluation.`,
      },
    };
  }

  // Warning at 90% of target
  if (progress >= 0.90) {
    return {
      allowed: true,
      reason: `Profit target ${(progress * 100).toFixed(1)}% complete: $${profitDollars.toFixed(2)} / $${(target - config.initial_balance).toFixed(2)}`,
      severity: "warning",
      maxPositionSizeMultiplier: 1.0,
      shouldCloseAll: false,
      event: {
        type: "target_warning",
        severity: "info",
        message: `Approaching profit target: ${(progress * 100).toFixed(1)}% complete.`,
      },
    };
  }

  return {
    allowed: true,
    reason: `Profit progress: $${profitDollars.toFixed(2)} / $${(target - config.initial_balance).toFixed(2)} (${(progress * 100).toFixed(1)}%)`,
    severity: "ok",
    maxPositionSizeMultiplier: 1.0,
    shouldCloseAll: false,
  };
}

/**
 * Check best day rule compliance (1-Step only).
 * No single day's profit can exceed 50% of total positive days' profit.
 *
 * This is NOT an immediate breach — it just means you need to keep trading.
 * Returns a warning but does not block entries.
 */
export function checkBestDayRule(
  config: PropFirmConfig,
  todayProfit: number,
  totalPositiveDaysProfit: number,
): PropFirmCheckResult | null {
  if (config.best_day_rule_pct == null) return null;
  if (todayProfit <= 0 || totalPositiveDaysProfit <= 0) return null;

  const ratio = todayProfit / totalPositiveDaysProfit;

  if (ratio > config.best_day_rule_pct) {
    return {
      allowed: true, // Not a breach, just a warning
      reason: `Best Day Rule: today's profit is ${(ratio * 100).toFixed(1)}% of total positive days (limit: ${(config.best_day_rule_pct * 100).toFixed(0)}%)`,
      severity: "warning",
      maxPositionSizeMultiplier: 1.0,
      shouldCloseAll: false,
      event: {
        type: "best_day_warning",
        severity: "warning",
        message: `Best Day Rule exceeded: ${(ratio * 100).toFixed(1)}% > ${(config.best_day_rule_pct * 100).toFixed(0)}%. Keep trading to dilute.`,
      },
    };
  }

  return null; // No issue
}

// ─── Composite Check ──────────────────────────────────────────────────────────

/**
 * Run all prop firm compliance checks and return a combined result.
 * The most restrictive check wins.
 */
export function checkPropFirmCompliance(
  config: PropFirmConfig,
  dailyState: PropFirmDailyState,
  currentEquity: number,
  currentBalance: number,
): PropFirmComplianceResult {
  const dailyLoss = checkDailyLoss(config, dailyState, currentEquity);
  const maxDrawdown = checkMaxDrawdown(config, dailyState, currentEquity);
  const profitTarget = checkProfitTarget(config, currentBalance);

  // Determine overall result: most restrictive wins
  const checks = [dailyLoss, maxDrawdown, profitTarget].filter(Boolean) as PropFirmCheckResult[];

  // If any check requires close-all, that takes priority
  const closeAllCheck = checks.find(c => c.shouldCloseAll);
  if (closeAllCheck) {
    return {
      dailyLoss,
      maxDrawdown,
      profitTarget,
      overall: closeAllCheck,
    };
  }

  // If any check blocks entry
  const blockedCheck = checks.find(c => !c.allowed);
  if (blockedCheck) {
    return {
      dailyLoss,
      maxDrawdown,
      profitTarget,
      overall: blockedCheck,
    };
  }

  // Take the minimum position size multiplier across all checks
  const minMultiplier = Math.min(...checks.map(c => c.maxPositionSizeMultiplier));
  const worstSeverity = checks.reduce<CheckSeverity>((worst, c) => {
    const order: CheckSeverity[] = ["ok", "warning", "soft_lock", "hard_lock"];
    return order.indexOf(c.severity) > order.indexOf(worst) ? c.severity : worst;
  }, "ok");

  // Combine reasons from non-ok checks
  const warnings = checks.filter(c => c.severity !== "ok");
  const reason = warnings.length > 0
    ? warnings.map(c => c.reason).join(" | ")
    : checks[0]?.reason || "Prop firm compliance OK";

  return {
    dailyLoss,
    maxDrawdown,
    profitTarget,
    overall: {
      allowed: true,
      reason,
      severity: worstSeverity,
      maxPositionSizeMultiplier: minMultiplier,
      shouldCloseAll: false,
      event: warnings.length > 0 ? warnings[0].event : undefined,
    },
  };
}

// ─── Utility Functions ────────────────────────────────────────────────────────

/**
 * Create a default FTMO 2-Step config for a user.
 */
export function createDefaultFTMO2StepConfig(
  userId: string,
  botId: string,
  initialBalance: number = 100_000,
  stage: AccountStage = "challenge",
): Omit<PropFirmConfig, "id"> {
  return {
    ...FTMO_2STEP_DEFAULTS,
    user_id: userId,
    bot_id: botId,
    initial_balance: initialBalance,
    account_stage: stage,
    profit_target_pct: stage === "funded" ? null : (stage === "verification" ? 0.05 : 0.10),
  };
}

/**
 * Create a fresh daily state for a new trading day.
 */
export function createDailyState(
  configId: string,
  tradingDay: string,
  currentBalance: number,
  currentEquity: number,
  previousHighestEODBalance: number,
): Omit<PropFirmDailyState, "id"> {
  return {
    config_id: configId,
    trading_day: tradingDay,
    day_start_balance: currentBalance,
    day_start_equity: currentEquity,
    highest_equity_today: currentEquity,
    lowest_equity_today: currentEquity,
    current_equity: currentEquity,
    end_of_day_balance: null,
    highest_eod_balance_ever: Math.max(previousHighestEODBalance, currentBalance),
    realized_pnl_today: 0,
    trade_count_today: 0,
    is_locked: false,
    locked_at: null,
    lock_reason: null,
  };
}

/**
 * Update daily state with new equity reading.
 * Returns the fields that changed (for partial DB update).
 */
export function updateDailyStateWithEquity(
  state: PropFirmDailyState,
  currentEquity: number,
): Partial<PropFirmDailyState> {
  const updates: Partial<PropFirmDailyState> = {
    current_equity: currentEquity,
  };

  if (currentEquity > state.highest_equity_today) {
    updates.highest_equity_today = currentEquity;
  }
  if (currentEquity < state.lowest_equity_today) {
    updates.lowest_equity_today = currentEquity;
  }

  return updates;
}
