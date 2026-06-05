import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  calculateDrawdownRisk,
  checkDailyLimit,
  checkWeeklyLimit,
  calculatePositionSize,
  assessRisk,
  DEFAULT_ICT_RISK_CONFIG,
  type ICTRiskConfig,
} from "./ictRiskManagement.ts";

// ─── Tests: Drawdown Halving ──────────────────────────────────────────

Deno.test("calculateDrawdownRisk: 0 consecutive losses = full risk", () => {
  const result = calculateDrawdownRisk(0);
  assertEquals(result.currentRiskMultiplier, 1.0);
  assertEquals(result.effectiveRiskPercent, DEFAULT_ICT_RISK_CONFIG.baseRiskPercent);
  assertEquals(result.shouldStopTrading, false);
});

Deno.test("calculateDrawdownRisk: 1 consecutive loss = 50% risk", () => {
  const result = calculateDrawdownRisk(1);
  assertEquals(result.currentRiskMultiplier, 0.5);
  assertEquals(result.effectiveRiskPercent, DEFAULT_ICT_RISK_CONFIG.baseRiskPercent * 0.5);
  assertEquals(result.shouldStopTrading, false);
});

Deno.test("calculateDrawdownRisk: 2 consecutive losses = 25% risk", () => {
  const result = calculateDrawdownRisk(2);
  assertEquals(result.currentRiskMultiplier, 0.25);
  assertEquals(result.effectiveRiskPercent, DEFAULT_ICT_RISK_CONFIG.baseRiskPercent * 0.25);
  assertEquals(result.shouldStopTrading, false);
});

Deno.test("calculateDrawdownRisk: 3 consecutive losses = STOP (default max)", () => {
  const result = calculateDrawdownRisk(3);
  assertEquals(result.shouldStopTrading, true);
  assertEquals(result.effectiveRiskPercent, 0);
  assertEquals(result.currentRiskMultiplier, 0);
});

Deno.test("calculateDrawdownRisk: drawdown halving disabled = full risk always", () => {
  const config: ICTRiskConfig = { ...DEFAULT_ICT_RISK_CONFIG, drawdownHalving: false };
  const result = calculateDrawdownRisk(5, config);
  assertEquals(result.currentRiskMultiplier, 1.0);
  assertEquals(result.effectiveRiskPercent, config.baseRiskPercent);
  assertEquals(result.shouldStopTrading, false);
});

Deno.test("calculateDrawdownRisk: custom max consecutive losses", () => {
  const config: ICTRiskConfig = { ...DEFAULT_ICT_RISK_CONFIG, maxConsecutiveLossesBeforeStop: 5 };
  const result4 = calculateDrawdownRisk(4, config);
  assertEquals(result4.shouldStopTrading, false);
  assertEquals(result4.currentRiskMultiplier, 0.0625); // 0.5^4

  const result5 = calculateDrawdownRisk(5, config);
  assertEquals(result5.shouldStopTrading, true);
});

// ─── Tests: Daily Limit ───────────────────────────────────────────────

Deno.test("checkDailyLimit: within limits = can trade", () => {
  const result = checkDailyLimit(1, -0.003);
  assertEquals(result.canTrade, true);
});

Deno.test("checkDailyLimit: daily loss limit hit = cannot trade", () => {
  const result = checkDailyLimit(1, -0.01); // -1% = limit
  assertEquals(result.canTrade, false);
  assertEquals(result.reason.includes("Daily loss limit"), true);
});

Deno.test("checkDailyLimit: max trades reached = cannot trade", () => {
  const result = checkDailyLimit(3, 0.005); // 3 trades, positive PnL
  assertEquals(result.canTrade, false);
  assertEquals(result.reason.includes("Max trades"), true);
});

Deno.test("checkDailyLimit: disabled = always can trade", () => {
  const config: ICTRiskConfig = { ...DEFAULT_ICT_RISK_CONFIG, enabled: false };
  const result = checkDailyLimit(10, -0.05, config);
  assertEquals(result.canTrade, true);
});

// ─── Tests: Weekly Limit ──────────────────────────────────────────────

Deno.test("checkWeeklyLimit: within limits = can trade", () => {
  const result = checkWeeklyLimit(-0.01);
  assertEquals(result.canTrade, true);
});

Deno.test("checkWeeklyLimit: weekly loss limit hit = cannot trade", () => {
  const result = checkWeeklyLimit(-0.025); // -2.5% = limit
  assertEquals(result.canTrade, false);
  assertEquals(result.reason.includes("Weekly loss limit"), true);
});

Deno.test("checkWeeklyLimit: positive PnL = can trade", () => {
  const result = checkWeeklyLimit(0.05);
  assertEquals(result.canTrade, true);
});

// ─── Tests: Position Sizing ───────────────────────────────────────────

Deno.test("calculatePositionSize: standard forex pair", () => {
  const result = calculatePositionSize(
    10000,   // $10k account
    1.1000,  // entry
    1.0950,  // SL (50 pips)
    0.01,    // 1% risk
    10,      // $10/pip/lot
  );
  assertEquals(result.lots, 0.2); // $100 risk / (50 pips × $10) = 0.2 lots
  assertEquals(result.riskAmount, 100);
  assertEquals(Math.round(result.slDistancePips), 50);
});

Deno.test("calculatePositionSize: JPY pair (2 decimal pips)", () => {
  const result = calculatePositionSize(
    10000,    // $10k account
    150.00,   // entry
    149.50,   // SL (50 pips for JPY)
    0.01,     // 1% risk
    6.67,     // ~$6.67/pip/lot for USDJPY
  );
  assertEquals(result.slDistancePips, 50);
  assertEquals(result.riskAmount, 100);
  // 100 / (50 * 6.67) = 0.30
  assertEquals(result.lots, 0.3);
});

Deno.test("calculatePositionSize: zero SL distance returns 0 lots", () => {
  const result = calculatePositionSize(10000, 1.1000, 1.1000, 0.01, 10);
  assertEquals(result.lots, 0);
});

Deno.test("calculatePositionSize: zero equity returns 0 lots", () => {
  const result = calculatePositionSize(0, 1.1000, 1.0950, 0.01, 10);
  assertEquals(result.lots, 0);
});

Deno.test("calculatePositionSize: halved risk = half the lots", () => {
  const full = calculatePositionSize(10000, 1.1000, 1.0950, 0.01, 10);
  const half = calculatePositionSize(10000, 1.1000, 1.0950, 0.005, 10);
  assertEquals(half.lots, full.lots / 2);
});

// ─── Tests: Full Risk Assessment ──────────────────────────────────────

Deno.test("assessRisk: all clear = can trade at full risk", () => {
  const result = assessRisk({
    consecutiveLosses: 0,
    tradesToday: 0,
    dailyPnLPercent: 0,
    weeklyPnLPercent: 0,
    config: DEFAULT_ICT_RISK_CONFIG,
  });
  assertEquals(result.canTrade, true);
  assertEquals(result.effectiveRiskPercent, DEFAULT_ICT_RISK_CONFIG.baseRiskPercent);
  assertEquals(result.riskMultiplier, 1.0);
});

Deno.test("assessRisk: 1 loss = can trade at half risk", () => {
  const result = assessRisk({
    consecutiveLosses: 1,
    tradesToday: 1,
    dailyPnLPercent: -0.005,
    weeklyPnLPercent: -0.005,
    config: DEFAULT_ICT_RISK_CONFIG,
  });
  assertEquals(result.canTrade, true);
  assertEquals(result.riskMultiplier, 0.5);
});

Deno.test("assessRisk: max losses = cannot trade", () => {
  const result = assessRisk({
    consecutiveLosses: 3,
    tradesToday: 2,
    dailyPnLPercent: -0.008,
    weeklyPnLPercent: -0.015,
    config: DEFAULT_ICT_RISK_CONFIG,
  });
  assertEquals(result.canTrade, false);
  assertEquals(result.reasons.some(r => r.includes("consecutive")), true);
});

Deno.test("assessRisk: daily limit hit = cannot trade even with 0 losses", () => {
  const result = assessRisk({
    consecutiveLosses: 0,
    tradesToday: 1,
    dailyPnLPercent: -0.012,
    weeklyPnLPercent: -0.012,
    config: DEFAULT_ICT_RISK_CONFIG,
  });
  assertEquals(result.canTrade, false);
  assertEquals(result.reasons.some(r => r.includes("Daily")), true);
});

Deno.test("assessRisk: weekly limit hit = cannot trade", () => {
  const result = assessRisk({
    consecutiveLosses: 0,
    tradesToday: 0,
    dailyPnLPercent: 0,
    weeklyPnLPercent: -0.03,
    config: DEFAULT_ICT_RISK_CONFIG,
  });
  assertEquals(result.canTrade, false);
  assertEquals(result.reasons.some(r => r.includes("Weekly")), true);
});

Deno.test("assessRisk: disabled = always can trade", () => {
  const config: ICTRiskConfig = { ...DEFAULT_ICT_RISK_CONFIG, enabled: false };
  const result = assessRisk({
    consecutiveLosses: 10,
    tradesToday: 50,
    dailyPnLPercent: -0.5,
    weeklyPnLPercent: -0.5,
    config,
  });
  assertEquals(result.canTrade, true);
});
