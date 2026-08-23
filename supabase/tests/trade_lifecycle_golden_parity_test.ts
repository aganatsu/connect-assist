import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  advanceBacktestTradeLifecycle,
  emptyBacktestTradeLifecycleState,
} from "../functions/_shared/backtestTradeLifecycle.ts";
import {
  buildImpulseEntryLifecycle,
} from "../functions/_shared/impulseEntryLifecycle.ts";
import { advanceTradeLifecycle } from "../functions/_shared/tradeLifecycleAuthority.ts";
import { evaluateFinalTradeAuthorization } from "../functions/_shared/finalTradeAuthorization.ts";

Deno.test("golden parity: backtest adapter matches direct lifecycle authority", () => {
  const lifecycle = buildImpulseEntryLifecycle({
    mode: "enforce",
    now: "2026-08-08T10:00:00.000Z",
    impulse: {
      id: "golden-impulse", direction: "long", timeframe: "1h",
      rangeLow: 100, rangeHigh: 110, protectedLevel: 100,
      expiresAt: "2026-08-08T12:00:00.000Z",
    },
    candidates: [
      { id: "shallow-ob", type: "ob", low: 106, high: 108, timeframe: "1h", impulseId: "golden-impulse" },
      { id: "deep-fvg", type: "fvg", low: 102, high: 104, timeframe: "1h", impulseId: "golden-impulse" },
    ],
    initialCandidateId: "shallow-ob",
    confirmation: {
      method: "choch", timeframe: "5m", refinementTimeframe: "1m",
      expiresAt: "2026-08-08T12:00:00.000Z",
    },
  });
  const candle = {
    datetime: "2026-08-08T10:15:00.000Z",
    open: 107, high: 108, low: 103, close: 105,
  };
  const direct = advanceTradeLifecycle({
    lifecycle, candle, completedCandles: [candle],
  });
  const adapter = advanceBacktestTradeLifecycle({
    state: {
      ...emptyBacktestTradeLifecycleState(),
      lifecycle: structuredClone(lifecycle),
    },
    candle,
    completedCandles: [candle],
  });
  assertEquals(adapter.lifecycle, direct.after);
  assertEquals(adapter.lastStep?.events, direct.events);
  assertEquals(adapter.lifecycle?.activeCandidateId, "deep-fvg");
});

const passingAuthorization = {
  account: {
    is_running: true, is_paused: false, kill_switch_active: false,
    execution_mode: "paper", balance: 100_000, peak_balance: 100_000,
    daily_pnl_base: 100_000, daily_pnl_base_date: "2026-08-08",
  },
  candidate: {
    symbol: "EUR/USD", direction: "long" as const,
    entryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11,
  },
  openPositions: [], maxOpenPositions: 3, maxPerSymbol: 1,
  allowSameDirectionStacking: false, maxDailyLoss: 5, maxDrawdown: 10,
  minimumRiskReward: 1.5,
  directionVerdict: {
    verdict: "long", shouldBlock: false, confidence: 80, agreement: 1,
  },
  requireDirectionVerdict: true,
  gamePlan: null, gamePlanEnabled: false,
  gamePlanMode: "off" as const, gamePlanMinimumConfidence: 75,
  thesisResult: {
    valid: true, reason: null, checkType: null, cancelReason: null,
  },
  requireThesisValidation: true,
  entryConfirmation: {
    required: true, passed: true, method: "choch",
    reason: "golden frozen confirmation passed",
    evaluatedAt: "2026-08-08T10:15:00.000Z",
  },
  propFirm: null, requirePropFirmResult: false,
  spread: { required: false, available: true, passed: true },
  runtimeGates: {
    executionMode: { passed: true, reason: "paper" },
    brokerConnectionAvailability: {
      passed: true,
      reason: "paper execution",
    },
    brokerConnectionSizing: {
      passed: true,
      reason: "paper execution",
    },
    portfolioHeat: { passed: true, reason: "within limit" },
    correlation: { passed: true, reason: "within limit" },
    cooldown: { passed: true, reason: "passed" },
    news: { passed: true, reason: "passed" },
    session: { passed: true, reason: "passed" },
    freshness: { passed: true, reason: "current candle" },
  },
  requireCrossTimeframeAuthority: false,
  now: new Date("2026-08-08T10:15:00.000Z"),
};

Deno.test("golden parity: final fill authority preserves valid trade and rejects low R:R", () => {
  const allowed = evaluateFinalTradeAuthorization(passingAuthorization);
  assertEquals(allowed.authorized, true);
  assertEquals(allowed.code, "authorized");

  const lowReward = evaluateFinalTradeAuthorization({
    ...passingAuthorization,
    candidate: { ...passingAuthorization.candidate, takeProfit: 1.102 },
  });
  assertEquals(lowReward.authorized, false);
  assertEquals(lowReward.code, "risk_reward");
});
