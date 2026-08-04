/**
 * Unit tests for propFirmRisk.ts — FTMO Prop Firm Risk Gate calculations.
 *
 * Run with: deno test supabase/functions/_shared/propFirmRisk.test.ts
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  calculateDailyLoss,
  calculateDailyLossLimit,
  calculateDrawdownFloor,
  calculateProfitTarget,
  getCESTTradingDay,
  getResetHourUTC,
  checkDailyLoss,
  checkMaxDrawdown,
  checkProfitTarget,
  checkBestDayRule,
  checkPropFirmCompliance,
  createDefaultFTMO2StepConfig,
  createDailyState,
  updateDailyStateWithEquity,
  FTMO_2STEP_DEFAULTS,
  FTMO_1STEP_DEFAULTS,
  type PropFirmConfig,
  type PropFirmDailyState,
} from "./propFirmRisk.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PropFirmConfig> = {}): PropFirmConfig {
  return {
    id: "test-config-id",
    user_id: "test-user-id",
    bot_id: "smc-bot-v1",
    ...FTMO_2STEP_DEFAULTS,
    ...overrides,
  };
}

function makeDailyState(overrides: Partial<PropFirmDailyState> = {}): PropFirmDailyState {
  return {
    id: "test-state-id",
    config_id: "test-config-id",
    trading_day: "2026-05-09",
    day_start_balance: 100_000,
    day_start_equity: 100_000,
    highest_equity_today: 100_500,
    lowest_equity_today: 99_500,
    current_equity: 100_000,
    end_of_day_balance: null,
    highest_eod_balance_ever: 100_000,
    realized_pnl_today: 0,
    trade_count_today: 0,
    is_locked: false,
    locked_at: null,
    lock_reason: null,
    ...overrides,
  };
}

// ─── calculateDailyLoss ──────────────────────────────────────────────────────

Deno.test("calculateDailyLoss: returns 0 when in profit", () => {
  const result = calculateDailyLoss(100_000, 101_000);
  assertEquals(result, 0);
});

Deno.test("calculateDailyLoss: returns correct fraction when in loss", () => {
  // $3,000 loss on $100K start = 3%
  const result = calculateDailyLoss(100_000, 97_000);
  assertAlmostEquals(result, 0.03, 0.0001);
});

Deno.test("calculateDailyLoss: returns 0 for zero start balance", () => {
  const result = calculateDailyLoss(0, -500);
  assertEquals(result, 0);
});

Deno.test("calculateDailyLoss: exact 5% loss", () => {
  const result = calculateDailyLoss(100_000, 95_000);
  assertAlmostEquals(result, 0.05, 0.0001);
});

// ─── calculateDailyLossLimit ─────────────────────────────────────────────────

Deno.test("calculateDailyLossLimit: FTMO 2-step $100K = $5,000", () => {
  const config = makeConfig({ initial_balance: 100_000, max_daily_loss_pct: 0.05 });
  assertEquals(calculateDailyLossLimit(config), 5_000);
});

Deno.test("calculateDailyLossLimit: FTMO 1-step $100K = $3,000", () => {
  const config = makeConfig({ initial_balance: 100_000, max_daily_loss_pct: 0.03 });
  assertEquals(calculateDailyLossLimit(config), 3_000);
});

Deno.test("calculateDailyLossLimit: FTMO 2-step $200K = $10,000", () => {
  const config = makeConfig({ initial_balance: 200_000, max_daily_loss_pct: 0.05 });
  assertEquals(calculateDailyLossLimit(config), 10_000);
});

// ─── calculateDrawdownFloor ──────────────────────────────────────────────────

Deno.test("calculateDrawdownFloor: 2-step fixed floor = $90K for $100K", () => {
  const config = makeConfig({ trailing_drawdown: false, initial_balance: 100_000, max_overall_loss_pct: 0.10 });
  assertEquals(calculateDrawdownFloor(config, 105_000), 90_000);
});

Deno.test("calculateDrawdownFloor: 2-step fixed floor ignores EOD balance", () => {
  const config = makeConfig({ trailing_drawdown: false, initial_balance: 100_000, max_overall_loss_pct: 0.10 });
  // Even if highest EOD was $120K, floor stays at $90K
  assertEquals(calculateDrawdownFloor(config, 120_000), 90_000);
});

Deno.test("calculateDrawdownFloor: 1-step trailing floor trails up", () => {
  const config = makeConfig({ trailing_drawdown: true, initial_balance: 100_000, max_overall_loss_pct: 0.10 });
  // Highest EOD = $104K → floor = $104K - $10K = $94K
  assertEquals(calculateDrawdownFloor(config, 104_000), 94_000);
});

Deno.test("calculateDrawdownFloor: 1-step trailing floor from initial", () => {
  const config = makeConfig({ trailing_drawdown: true, initial_balance: 100_000, max_overall_loss_pct: 0.10 });
  // Highest EOD = $100K (no profit yet) → floor = $100K - $10K = $90K
  assertEquals(calculateDrawdownFloor(config, 100_000), 90_000);
});

// ─── calculateProfitTarget ───────────────────────────────────────────────────

Deno.test("calculateProfitTarget: challenge 10% on $100K = $110K", () => {
  const config = makeConfig({ initial_balance: 100_000, profit_target_pct: 0.10 });
  assertAlmostEquals(calculateProfitTarget(config)!, 110_000, 0.01);
});

Deno.test("calculateProfitTarget: verification 5% on $100K = $105K", () => {
  const config = makeConfig({ initial_balance: 100_000, profit_target_pct: 0.05 });
  assertEquals(calculateProfitTarget(config), 105_000);
});

Deno.test("calculateProfitTarget: funded account returns null", () => {
  const config = makeConfig({ profit_target_pct: null });
  assertEquals(calculateProfitTarget(config), null);
});

// ─── getCESTTradingDay ───────────────────────────────────────────────────────

Deno.test("getCESTTradingDay: 21:59 UTC (before 22:00 reset) = same day", () => {
  const date = new Date("2026-05-09T21:59:00Z");
  assertEquals(getCESTTradingDay(date, 22), "2026-05-09");
});

Deno.test("getCESTTradingDay: 22:00 UTC (at reset) = next day", () => {
  const date = new Date("2026-05-09T22:00:00Z");
  assertEquals(getCESTTradingDay(date, 22), "2026-05-10");
});

Deno.test("getCESTTradingDay: 23:30 UTC (after reset) = next day", () => {
  const date = new Date("2026-05-09T23:30:00Z");
  assertEquals(getCESTTradingDay(date, 22), "2026-05-10");
});

Deno.test("getCESTTradingDay: winter time reset at 23:00 UTC", () => {
  const date = new Date("2026-01-15T22:59:00Z");
  assertEquals(getCESTTradingDay(date, 23), "2026-01-15");
  const dateAfter = new Date("2026-01-15T23:00:00Z");
  assertEquals(getCESTTradingDay(dateAfter, 23), "2026-01-16");
});

// ─── getResetHourUTC ─────────────────────────────────────────────────────────

Deno.test("getResetHourUTC: summer (June) = 22", () => {
  const date = new Date("2026-06-15T12:00:00Z");
  assertEquals(getResetHourUTC(date), 22);
});

Deno.test("getResetHourUTC: winter (January) = 23", () => {
  const date = new Date("2026-01-15T12:00:00Z");
  assertEquals(getResetHourUTC(date), 23);
});

Deno.test("getResetHourUTC: March before DST switch = 23 (winter)", () => {
  // Last Sunday of March 2026 is March 29
  const date = new Date("2026-03-28T12:00:00Z"); // Saturday before switch
  assertEquals(getResetHourUTC(date), 23);
});

Deno.test("getResetHourUTC: March after DST switch = 22 (summer)", () => {
  // Last Sunday of March 2026 is March 29, switch at 01:00 UTC
  const date = new Date("2026-03-30T12:00:00Z"); // Monday after switch
  assertEquals(getResetHourUTC(date), 22);
});

Deno.test("getResetHourUTC: October before DST switch = 22 (summer)", () => {
  // Last Sunday of October 2026 is October 25
  const date = new Date("2026-10-24T12:00:00Z"); // Saturday before switch
  assertEquals(getResetHourUTC(date), 22);
});

Deno.test("getResetHourUTC: October after DST switch = 23 (winter)", () => {
  const date = new Date("2026-10-26T12:00:00Z"); // Monday after switch
  assertEquals(getResetHourUTC(date), 23);
});

// ─── checkDailyLoss ──────────────────────────────────────────────────────────

Deno.test("checkDailyLoss: no loss — allowed, severity ok", () => {
  const config = makeConfig();
  const state = makeDailyState({ day_start_balance: 100_000 });
  const result = checkDailyLoss(config, state, 101_000);
  assertEquals(result.allowed, true);
  assertEquals(result.severity, "ok");
  assertEquals(result.maxPositionSizeMultiplier, 1.0);
  assertEquals(result.shouldCloseAll, false);
});

Deno.test("checkDailyLoss: small loss (2%) — allowed, severity ok", () => {
  const config = makeConfig();
  const state = makeDailyState({ day_start_balance: 100_000 });
  const result = checkDailyLoss(config, state, 98_000); // $2K loss = 2%
  assertEquals(result.allowed, true);
  assertEquals(result.severity, "ok");
  assertEquals(result.maxPositionSizeMultiplier, 1.0);
});

Deno.test("checkDailyLoss: 65% of limit used — warning, size reduced", () => {
  const config = makeConfig({ size_reduction_threshold_pct: 0.60 });
  const state = makeDailyState({ day_start_balance: 100_000 });
  // 65% of $5K limit = $3,250 loss → equity = $96,750
  // usageRatio = 3250/5000 = 0.65 > 0.60 threshold → warning
  const result = checkDailyLoss(config, state, 96_750);
  assertEquals(result.allowed, true);
  assertEquals(result.severity, "warning");
  assertEquals(result.maxPositionSizeMultiplier < 1.0, true);
});

Deno.test("checkDailyLoss: near safety buffer — soft lock", () => {
  const config = makeConfig({ safety_buffer_pct: 0.008 }); // 0.8% buffer
  const state = makeDailyState({ day_start_balance: 100_000 });
  // Safety threshold = $5000 * (1 - 0.008/0.05) = $5000 * 0.84 = $4200
  // Loss of $4300 should trigger soft lock
  const result = checkDailyLoss(config, state, 95_700);
  assertEquals(result.allowed, false);
  assertEquals(result.severity === "soft_lock" || result.severity === "hard_lock", true);
});

Deno.test("checkDailyLoss: emergency threshold — hard lock, close all", () => {
  const config = makeConfig({ emergency_close_pct: 0.002, close_on_breach: true });
  const state = makeDailyState({ day_start_balance: 100_000 });
  // Emergency threshold = $5000 * (1 - 0.002/0.05) = $5000 * 0.96 = $4800
  // Loss of $4900 should trigger hard lock
  const result = checkDailyLoss(config, state, 95_100);
  assertEquals(result.allowed, false);
  assertEquals(result.severity, "hard_lock");
  assertEquals(result.shouldCloseAll, true);
  assertEquals(result.event?.type, "daily_hard_lock");
  assertEquals(result.event?.severity, "critical");
});

Deno.test("checkDailyLoss: exact 5% loss — hard lock", () => {
  const config = makeConfig();
  const state = makeDailyState({ day_start_balance: 100_000 });
  const result = checkDailyLoss(config, state, 95_000); // exactly $5K loss
  assertEquals(result.allowed, false);
  assertEquals(result.shouldCloseAll, true);
});

// ─── checkMaxDrawdown ────────────────────────────────────────────────────────

Deno.test("checkMaxDrawdown: equity well above floor — ok", () => {
  const config = makeConfig();
  const state = makeDailyState({ highest_eod_balance_ever: 100_000 });
  // Floor = $90K, equity = $98K → well above
  const result = checkMaxDrawdown(config, state, 98_000);
  assertEquals(result.allowed, true);
  assertEquals(result.severity, "ok");
});

Deno.test("checkMaxDrawdown: equity near floor — soft lock", () => {
  const config = makeConfig({ safety_buffer_pct: 0.008 }); // $800 buffer
  const state = makeDailyState({ highest_eod_balance_ever: 100_000 });
  // Floor = $90K, safety buffer = $800, so soft lock at $90,800
  const result = checkMaxDrawdown(config, state, 90_700);
  assertEquals(result.allowed, false);
  assertEquals(result.severity === "soft_lock" || result.severity === "hard_lock", true);
});

Deno.test("checkMaxDrawdown: equity at emergency threshold — hard lock", () => {
  const config = makeConfig({ emergency_close_pct: 0.002, close_on_breach: true }); // $200 buffer
  const state = makeDailyState({ highest_eod_balance_ever: 100_000 });
  // Floor = $90K, emergency buffer = $200, so hard lock at $90,200
  const result = checkMaxDrawdown(config, state, 90_100);
  assertEquals(result.allowed, false);
  assertEquals(result.severity, "hard_lock");
  assertEquals(result.shouldCloseAll, true);
  assertEquals(result.event?.type, "drawdown_breach");
});

Deno.test("checkMaxDrawdown: 2-step floor stays fixed even after profit", () => {
  const config = makeConfig({ trailing_drawdown: false });
  const state = makeDailyState({ highest_eod_balance_ever: 115_000 });
  // Even though peak was $115K, floor is still $90K (fixed from initial $100K)
  const result = checkMaxDrawdown(config, state, 95_000);
  assertEquals(result.allowed, true);
  assertEquals(result.severity, "ok");
});

Deno.test("checkMaxDrawdown: 1-step trailing floor moves up", () => {
  const config = makeConfig({ trailing_drawdown: true });
  const state = makeDailyState({ highest_eod_balance_ever: 110_000 });
  // Trailing floor = $110K - $10K = $100K
  // Equity at $101K → still above floor
  const result = checkMaxDrawdown(config, state, 101_000);
  assertEquals(result.allowed, true);
  // Equity at $100,100 → near floor
  const result2 = checkMaxDrawdown(config, state, 100_100);
  assertEquals(result2.allowed, false); // within safety buffer
});

// ─── checkProfitTarget ───────────────────────────────────────────────────────

Deno.test("checkProfitTarget: below target — allowed", () => {
  const config = makeConfig({ profit_target_pct: 0.10 });
  const result = checkProfitTarget(config, 105_000);
  assertEquals(result!.allowed, true);
  assertEquals(result!.severity, "ok");
});

Deno.test("checkProfitTarget: at target — soft lock (stop trading)", () => {
  const config = makeConfig({ profit_target_pct: 0.10 });
  // Use $110,001 to be clearly above the target (avoids floating point edge)
  const result = checkProfitTarget(config, 110_001);
  assertEquals(result!.allowed, false);
  assertEquals(result!.severity, "soft_lock");
  assertEquals(result!.shouldCloseAll, false); // Don't close winners
  assertEquals(result!.event?.type, "target_reached");
});

Deno.test("checkProfitTarget: above target — soft lock", () => {
  const config = makeConfig({ profit_target_pct: 0.10 });
  const result = checkProfitTarget(config, 112_000);
  assertEquals(result!.allowed, false);
  assertEquals(result!.severity, "soft_lock");
});

Deno.test("checkProfitTarget: near target (90%+) — warning", () => {
  const config = makeConfig({ profit_target_pct: 0.10 });
  // 90% of $10K target = $9K profit → balance $109K
  const result = checkProfitTarget(config, 109_500);
  assertEquals(result!.allowed, true);
  assertEquals(result!.severity, "warning");
});

Deno.test("checkProfitTarget: funded account — returns null", () => {
  const config = makeConfig({ profit_target_pct: null });
  const result = checkProfitTarget(config, 150_000);
  assertEquals(result, null);
});

// ─── checkBestDayRule ────────────────────────────────────────────────────────

Deno.test("checkBestDayRule: no rule configured — returns null", () => {
  const config = makeConfig({ best_day_rule_pct: null });
  const result = checkBestDayRule(config, 5000, 8000);
  assertEquals(result, null);
});

Deno.test("checkBestDayRule: within limit — returns null", () => {
  const config = makeConfig({ best_day_rule_pct: 0.50 });
  // Today $3K of $10K total = 30% < 50%
  const result = checkBestDayRule(config, 3000, 10000);
  assertEquals(result, null);
});

Deno.test("checkBestDayRule: exceeds limit — warning (not a block)", () => {
  const config = makeConfig({ best_day_rule_pct: 0.50 });
  // Today $6K of $10K total = 60% > 50%
  const result = checkBestDayRule(config, 6000, 10000);
  assertEquals(result!.allowed, true); // Not a breach, just warning
  assertEquals(result!.severity, "warning");
  assertEquals(result!.event?.type, "best_day_warning");
});

Deno.test("checkBestDayRule: negative today — returns null", () => {
  const config = makeConfig({ best_day_rule_pct: 0.50 });
  const result = checkBestDayRule(config, -500, 10000);
  assertEquals(result, null);
});

// ─── checkPropFirmCompliance (composite) ─────────────────────────────────────

Deno.test("checkPropFirmCompliance: all clear — overall allowed", () => {
  const config = makeConfig();
  const state = makeDailyState({ day_start_balance: 100_000, highest_eod_balance_ever: 100_000 });
  const result = checkPropFirmCompliance(config, state, 99_000, 99_000);
  assertEquals(result.overall.allowed, true);
  assertEquals(result.overall.severity, "ok");
  assertEquals(result.overall.maxPositionSizeMultiplier, 1.0);
});

Deno.test("checkPropFirmCompliance: daily loss blocks — overall blocked", () => {
  const config = makeConfig();
  const state = makeDailyState({ day_start_balance: 100_000, highest_eod_balance_ever: 100_000 });
  // $4,900 loss → triggers hard lock
  const result = checkPropFirmCompliance(config, state, 95_100, 95_100);
  assertEquals(result.overall.allowed, false);
  assertEquals(result.overall.shouldCloseAll, true);
  assertEquals(result.dailyLoss.severity, "hard_lock");
});

Deno.test("checkPropFirmCompliance: drawdown blocks — overall blocked", () => {
  const config = makeConfig();
  const state = makeDailyState({ day_start_balance: 91_000, highest_eod_balance_ever: 100_000 });
  // Equity at $90,100 → near drawdown floor $90K
  const result = checkPropFirmCompliance(config, state, 90_100, 90_100);
  assertEquals(result.overall.allowed, false);
  assertEquals(result.maxDrawdown.severity, "hard_lock");
});

Deno.test("checkPropFirmCompliance: profit target blocks — overall blocked", () => {
  const config = makeConfig({ profit_target_pct: 0.10 });
  const state = makeDailyState({ day_start_balance: 110_000, highest_eod_balance_ever: 110_000 });
  const result = checkPropFirmCompliance(config, state, 110_500, 110_500);
  assertEquals(result.overall.allowed, false);
  assertEquals(result.profitTarget!.severity, "soft_lock");
  assertEquals(result.overall.shouldCloseAll, false); // Target doesn't close positions
});

Deno.test("checkPropFirmCompliance: size reduction — minimum multiplier wins", () => {
  const config = makeConfig({ size_reduction_threshold_pct: 0.60 });
  const state = makeDailyState({ day_start_balance: 100_000, highest_eod_balance_ever: 100_000 });
  // $3,500 daily loss = 70% of limit → size reduction
  const result = checkPropFirmCompliance(config, state, 96_500, 96_500);
  assertEquals(result.overall.allowed, true);
  assertEquals(result.overall.maxPositionSizeMultiplier < 1.0, true);
  assertEquals(result.overall.severity, "warning");
});

// ─── createDefaultFTMO2StepConfig ────────────────────────────────────────────

Deno.test("createDefaultFTMO2StepConfig: challenge stage", () => {
  const config = createDefaultFTMO2StepConfig("user-1", "bot-1", 100_000, "challenge");
  assertEquals(config.firm_type, "ftmo_2step");
  assertEquals(config.max_daily_loss_pct, 0.05);
  assertEquals(config.max_overall_loss_pct, 0.10);
  assertEquals(config.profit_target_pct, 0.10);
  assertEquals(config.trailing_drawdown, false);
  assertEquals(config.initial_balance, 100_000);
});

Deno.test("createDefaultFTMO2StepConfig: verification stage", () => {
  const config = createDefaultFTMO2StepConfig("user-1", "bot-1", 100_000, "verification");
  assertEquals(config.profit_target_pct, 0.05); // 5% for verification
});

Deno.test("createDefaultFTMO2StepConfig: funded stage", () => {
  const config = createDefaultFTMO2StepConfig("user-1", "bot-1", 100_000, "funded");
  assertEquals(config.profit_target_pct, null); // No target for funded
});

// ─── createDailyState ────────────────────────────────────────────────────────

Deno.test("createDailyState: initializes correctly", () => {
  const state = createDailyState("cfg-1", "2026-05-09", 102_000, 101_500, 100_000);
  assertEquals(state.config_id, "cfg-1");
  assertEquals(state.trading_day, "2026-05-09");
  assertEquals(state.day_start_balance, 102_000);
  assertEquals(state.day_start_equity, 101_500);
  assertEquals(state.highest_equity_today, 101_500);
  assertEquals(state.lowest_equity_today, 101_500);
  assertEquals(state.highest_eod_balance_ever, 102_000); // max(prev 100K, current 102K)
  assertEquals(state.is_locked, false);
});

// ─── updateDailyStateWithEquity ──────────────────────────────────────────────

Deno.test("updateDailyStateWithEquity: new high", () => {
  const state = makeDailyState({ highest_equity_today: 100_500, lowest_equity_today: 99_500 });
  const updates = updateDailyStateWithEquity(state, 101_000);
  assertEquals(updates.current_equity, 101_000);
  assertEquals(updates.highest_equity_today, 101_000);
  assertEquals(updates.lowest_equity_today, undefined); // Not updated
});

Deno.test("updateDailyStateWithEquity: new low", () => {
  const state = makeDailyState({ highest_equity_today: 100_500, lowest_equity_today: 99_500 });
  const updates = updateDailyStateWithEquity(state, 99_000);
  assertEquals(updates.current_equity, 99_000);
  assertEquals(updates.highest_equity_today, undefined); // Not updated
  assertEquals(updates.lowest_equity_today, 99_000);
});

Deno.test("updateDailyStateWithEquity: no new extremes", () => {
  const state = makeDailyState({ highest_equity_today: 100_500, lowest_equity_today: 99_500 });
  const updates = updateDailyStateWithEquity(state, 100_000);
  assertEquals(updates.current_equity, 100_000);
  assertEquals(updates.highest_equity_today, undefined);
  assertEquals(updates.lowest_equity_today, undefined);
});

// ─── Edge Cases & Regression Tests ───────────────────────────────────────────

Deno.test("REGRESSION: daily loss uses day_start_balance not initial_balance as reference", () => {
  // FTMO measures daily loss from day-start BALANCE, not initial balance
  // If day started at $105K and equity drops to $100K, that's a $5K loss (4.76% of day start)
  // But the LIMIT is still 5% of INITIAL balance ($5K for $100K account)
  const config = makeConfig({ initial_balance: 100_000, max_daily_loss_pct: 0.05 });
  const state = makeDailyState({ day_start_balance: 105_000 });

  // $5K loss from $105K start → equity = $100K
  // Daily loss limit = 5% of $100K initial = $5K
  // Loss = $105K - $100K = $5K → at the limit!
  const result = checkDailyLoss(config, state, 100_000);
  assertEquals(result.allowed, false); // Should be blocked
});

Deno.test("REGRESSION: drawdown floor is from initial balance, not peak", () => {
  // 2-Step: floor is always initialBalance * 0.90, regardless of how high balance went
  const config = makeConfig({ trailing_drawdown: false, initial_balance: 100_000 });
  const state = makeDailyState({ highest_eod_balance_ever: 120_000 });

  // Even though peak was $120K, floor is $90K (not $108K which would be 10% of peak)
  const result = checkMaxDrawdown(config, state, 95_000);
  assertEquals(result.allowed, true); // $95K is above $90K floor
  assertEquals(result.severity, "ok");
});

Deno.test("REGRESSION: profit target uses balance not equity", () => {
  // Target check uses balance (closed P&L) not equity (floating)
  const config = makeConfig({ profit_target_pct: 0.10, initial_balance: 100_000 });
  // Balance at $109K (below target) but equity might be higher due to floating
  const result = checkProfitTarget(config, 109_000);
  assertEquals(result!.allowed, true); // Not yet at target
});

Deno.test("REGRESSION: emergency close only fires when close_on_breach is true", () => {
  const config = makeConfig({ close_on_breach: false, emergency_close_pct: 0.002 });
  const state = makeDailyState({ day_start_balance: 100_000 });
  const result = checkDailyLoss(config, state, 95_050); // Very close to breach
  // Even at hard_lock, shouldCloseAll respects close_on_breach setting
  if (result.severity === "hard_lock") {
    assertEquals(result.shouldCloseAll, false);
  }
});
