import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateFinalTradeAuthorization,
  type FinalTradeAuthorizationInput,
} from "../../functions/_shared/finalTradeAuthorization.ts";

function authorizationInput(
  candidate: FinalTradeAuthorizationInput["candidate"],
): FinalTradeAuthorizationInput {
  return {
    account: {
      is_running: true,
      is_paused: false,
      kill_switch_active: false,
      execution_mode: "paper",
      balance: 10_000,
      peak_balance: 10_000,
      daily_pnl_base: 10_000,
      daily_pnl_base_date: "2026-08-27",
    },
    candidate,
    openPositions: [],
    maxOpenPositions: 5,
    maxPerSymbol: 2,
    allowSameDirectionStacking: false,
    maxDailyLoss: 5,
    maxDrawdown: 10,
    minimumRiskReward: 0.5,
    commissionPerLot: 5,
    rateMap: { "EUR/USD": 1.1 },
    directionVerdict: {
      verdict: "long",
      shouldBlock: false,
      confidence: 80,
      agreement: 1,
    },
    requireDirectionVerdict: true,
    gamePlan: null,
    gamePlanEnabled: false,
    gamePlanMode: "off",
    gamePlanMinimumConfidence: 75,
    thesisResult: {
      valid: true,
      reason: null,
      checkType: null,
      cancelReason: null,
    },
    requireThesisValidation: true,
    entryConfirmation: {
      required: true,
      passed: true,
      method: "choch",
      reason: "confirmed",
      evaluatedAt: "2026-08-27T12:00:00.000Z",
    },
    propFirm: null,
    requirePropFirmResult: false,
    spread: {
      required: false,
      available: true,
      passed: true,
      spreadPips: 2.5,
      maximumPips: 4,
    },
    runtimeGates: {
      executionMode: { passed: true, reason: "paper" },
      brokerConnectionAvailability: { passed: true, reason: "paper" },
      brokerConnectionSizing: { passed: true, reason: "paper" },
      portfolioHeat: { passed: true, reason: "within limit" },
      correlation: { passed: true, reason: "within limit" },
      cooldown: { passed: true, reason: "passed" },
      news: { passed: true, reason: "passed" },
      session: { passed: true, reason: "passed" },
      freshness: { passed: true, reason: "fresh" },
    },
    requireCrossTimeframeAuthority: false,
    now: new Date("2026-08-27T12:00:00.000Z"),
  };
}

Deno.test("final authorization rejects raw 1R geometry consumed by spread and commission", () => {
  const result = evaluateFinalTradeAuthorization(authorizationInput({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.1,
    stopLoss: 1.0997,
    takeProfit: 1.1003,
  }));

  assertEquals(result.authorized, false);
  assertEquals(result.code, "risk_reward");
  assertStringIncludes(result.reason, "effective R:R is 0.00");
  assertStringIncludes(result.reason, "spread 2.5p + comm $5.0/lot");
});

Deno.test("final authorization accepts the same 1R target after executable stop flooring", () => {
  const result = evaluateFinalTradeAuthorization(authorizationInput({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.102,
  }));

  assertEquals(result.authorized, true);
  assertEquals(result.code, "authorized");
});
