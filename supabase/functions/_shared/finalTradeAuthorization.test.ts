import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateFinalTradeAuthorization,
  type FinalTradeAuthorizationInput,
} from "./finalTradeAuthorization.ts";

const validThesis = {
  valid: true,
  reason: null,
  checkType: null,
  cancelReason: null,
} as const;

function baseInput(): FinalTradeAuthorizationInput {
  return {
    account: {
      is_running: true,
      is_paused: false,
      kill_switch_active: false,
      execution_mode: "paper",
      balance: 10_000,
      peak_balance: 10_000,
      daily_pnl_base: 10_000,
      daily_pnl_base_date: "2026-07-28",
    },
    candidate: {
      symbol: "GBP/CAD",
      direction: "short",
      entryPrice: 1.88,
      stopLoss: 1.89,
      takeProfit: 1.86,
    },
    openPositions: [],
    maxOpenPositions: 3,
    maxPerSymbol: 2,
    allowSameDirectionStacking: false,
    maxDailyLoss: 5,
    maxDrawdown: 10,
    minimumRiskReward: 1,
    directionVerdict: {
      verdict: "short",
      shouldBlock: false,
      confidence: 72,
    },
    requireDirectionVerdict: true,
    gamePlan: null,
    gamePlanEnabled: false,
    gamePlanMode: "off",
    gamePlanMinimumConfidence: 75,
    thesisResult: validThesis,
    requireThesisValidation: true,
    propFirm: null,
    spread: {
      required: false,
      available: true,
      passed: true,
    },
    runtimeGates: {
      executionMode: { passed: true, reason: "Execution mode is paper" },
      portfolioHeat: {
        passed: true,
        reason: "Portfolio heat is within limit",
      },
      correlation: {
        passed: true,
        reason: "No correlated conflicts",
      },
      cooldown: { passed: true, reason: "Cooldown passed" },
      news: { passed: true, reason: "No high-impact news" },
      session: { passed: true, reason: "London session enabled" },
      freshness: {
        passed: true,
        reason: "Current price and candle are fresh",
      },
    },
    now: new Date("2026-07-28T17:00:00.000Z"),
  };
}

Deno.test("final authorization allows a fully valid candidate", () => {
  const result = evaluateFinalTradeAuthorization(baseInput());
  assertEquals(result.authorized, true);
  assertEquals(result.code, "authorized");
});

Deno.test("final authorization fails closed when Cross-TF authority is required but missing", () => {
  const input = baseInput();
  input.requireCrossTimeframeAuthority = true;
  input.crossTimeframeAuthority = null;
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.authorized, false);
  assertEquals(result.code, "cross_timeframe_unavailable");
});

Deno.test("final authorization blocks a certified Hard Cross-TF rejection", () => {
  const input = baseInput();
  input.requireCrossTimeframeAuthority = true;
  input.crossTimeframeAuthority = {
    effectiveMode: "hard",
    allowed: false,
    reasonCodes: ["parent_direction_conflict"],
  } as any;
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.authorized, false);
  assertEquals(result.code, "cross_timeframe_blocked");
});

for (
  const [name, mutate, expected] of [
    [
      "stopped bot",
      (input: FinalTradeAuthorizationInput) =>
        input.account!.is_running = false,
      "bot_stopped",
    ],
    [
      "paused bot",
      (input: FinalTradeAuthorizationInput) => input.account!.is_paused = true,
      "bot_paused",
    ],
    [
      "kill switch",
      (input: FinalTradeAuthorizationInput) =>
        input.account!.kill_switch_active = true,
      "kill_switch",
    ],
  ] as const
) {
  Deno.test(`final authorization blocks ${name}`, () => {
    const input = baseInput();
    mutate(input);
    const result = evaluateFinalTradeAuthorization(input);
    assertEquals(result.authorized, false);
    assertEquals(result.code, expected);
  });
}

Deno.test("final authorization blocks an opposing current Direction Verdict", () => {
  const input = baseInput();
  input.directionVerdict = {
    verdict: "long",
    shouldBlock: false,
    confidence: 80,
  };
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "direction_conflict");
  assertStringIncludes(result.reason, "candidate is short");
});

Deno.test("hard Game Plan waits when aligned confidence is below its threshold", () => {
  const input = baseInput();
  input.gamePlanEnabled = true;
  input.gamePlanMode = "hard";
  input.gamePlan = {
    session: "london",
    generatedAt: "2026-07-28T16:55:00.000Z",
    focusPairs: ["GBP/CAD"],
    newsEvents: [],
    summary: "Bearish plan",
    plans: [{
      symbol: "GBP/CAD",
      bias: "bearish",
      biasConfidence: 64,
      biasReasoning: [],
      drawOnLiquidity: null,
      keyLevels: [],
      scenarios: [],
      regime: "trending",
      amdPhase: "distribution",
      killZoneFocus: [],
      tradeable: true,
      state: "trade",
      generatedAt: "2026-07-28T16:55:00.000Z",
    }],
  } as any;
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "game_plan_blocked");
  assertStringIncludes(result.reason, "below the 75% minimum");
});

Deno.test("hard Game Plan blocks a direction that conflicts with its bias", () => {
  const input = baseInput();
  input.candidate.direction = "long";
  input.candidate.stopLoss = 1.87;
  input.candidate.takeProfit = 1.90;
  input.directionVerdict = {
    verdict: "long",
    shouldBlock: false,
    confidence: 82,
  };
  input.gamePlanEnabled = true;
  input.gamePlanMode = "hard";
  input.gamePlan = {
    session: "london",
    generatedAt: "2026-07-28T16:55:00.000Z",
    focusPairs: ["GBP/CAD"],
    newsEvents: [],
    summary: "Bearish plan",
    plans: [{
      symbol: "GBP/CAD",
      bias: "bearish",
      biasConfidence: 82,
      biasReasoning: [],
      drawOnLiquidity: null,
      keyLevels: [],
      scenarios: [],
      regime: "trending",
      amdPhase: "distribution",
      killZoneFocus: [],
      tradeable: true,
      state: "trade",
      generatedAt: "2026-07-28T16:55:00.000Z",
    }],
  } as any;
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "game_plan_blocked");
  assertStringIncludes(result.reason, "authorizes SHORT");
});

Deno.test("final authorization waits when the current Direction Verdict is unavailable", () => {
  const input = baseInput();
  input.directionVerdict = null;
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "direction_unavailable");
  assertEquals(result.retryable, true);
});

Deno.test("final authorization blocks a freshly invalidated thesis", () => {
  const input = baseInput();
  input.thesisResult = {
    valid: false,
    reason: "Direction flipped to long",
    checkType: "direction_flip",
    cancelReason: "thesis_invalid:direction_flip:long:80",
  };
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "thesis_invalid");
});

Deno.test("final authorization requires configured entry confirmation after thesis passes", () => {
  const input = baseInput();
  input.entryConfirmation = {
    required: true,
    passed: false,
    method: "choch",
    reason: "No bearish CHoCH yet",
    evaluatedAt: "2026-07-28T17:00:00.000Z",
  };
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "confirmation_blocked");
});

Deno.test("final authorization blocks invalid SL/TP orientation", () => {
  const input = baseInput();
  input.candidate.stopLoss = 1.87;
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "invalid_orientation");
});

Deno.test("final authorization blocks duplicate same-direction exposure", () => {
  const input = baseInput();
  input.openPositions = [{ symbol: "GBP/CAD", direction: "short" }];
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "duplicate_direction");
});

Deno.test("final authorization blocks when live spread cannot be verified", () => {
  const input = baseInput();
  input.account!.execution_mode = "live";
  input.spread = { required: true, available: false, passed: false };
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "spread_unavailable");
});

Deno.test("final authorization blocks an active prop-firm rejection", () => {
  const input = baseInput();
  input.propFirm = {
    enabled: true,
    allowed: false,
    reason: "Daily loss limit reached",
  };
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.code, "prop_firm_blocked");
});

for (
  const [gate, code] of [
    ["executionMode", "execution_mode"],
    ["portfolioHeat", "portfolio_heat"],
    ["correlation", "correlation"],
    ["cooldown", "cooldown"],
    ["news", "news"],
    ["session", "session"],
    ["freshness", "price_or_candle_stale"],
  ] as const
) {
  Deno.test(`final authorization blocks failed ${gate} runtime gate`, () => {
    const input = baseInput();
    input.runtimeGates[gate] = {
      passed: false,
      reason: `${gate} blocked`,
    };
    const result = evaluateFinalTradeAuthorization(input);
    assertEquals(result.authorized, false);
    assertEquals(result.code, code);
    assertStringIncludes(result.reason, "blocked");
  });
}

Deno.test("active prop-firm compliance remains authoritative for loss limits", () => {
  const input = baseInput();
  input.account!.balance = 8_000;
  input.propFirm = {
    enabled: true,
    allowed: true,
    reason: "Broker-equity loss limits passed",
  };
  const result = evaluateFinalTradeAuthorization(input);
  assertEquals(result.authorized, true);
  assertStringIncludes(
    result.checks.map((check) => check.reason).join(" | "),
    "delegated to prop-firm compliance",
  );
});
