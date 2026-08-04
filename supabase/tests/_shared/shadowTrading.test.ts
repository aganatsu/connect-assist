import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createShadowTrade,
  checkShadowTradeExit,
  updateShadowTradeExcursion,
  computeShadowPerformance,
  evaluateGateValue,
  type ShadowTrade,
  type ShadowTradeInput,
  type PriceUpdate,
} from "./shadowTrading.ts";

// ─── createShadowTrade Tests ─────────────────────────────────────────

Deno.test("createShadowTrade creates valid shadow trade from input", () => {
  const input: ShadowTradeInput = {
    userId: "user-1",
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.1000,
    stopLoss: 1.0950,
    takeProfit: 1.1100,
    size: 0.5,
    score: 62,
    shadowReason: { type: "gate_failure", gateName: "Session Quality", gateNumber: 5, detail: "Off-hours" },
    gateResults: { "Gate 1": true, "Gate 5": false },
    metadata: { regime: "bullish" },
  };

  const trade = createShadowTrade(input);
  assertEquals(trade.symbol, "EUR/USD");
  assertEquals(trade.direction, "long");
  assertEquals(trade.status, "open");
  assertEquals(trade.exitPrice, null);
  assertEquals(trade.pnlPips, null);
  assertEquals(trade.mfe, 0);
  assertEquals(trade.mae, 0);
  assertEquals(trade.shadowReason.type, "gate_failure");
  assertEquals(trade.metadata.regime, "bullish");
});

// ─── checkShadowTradeExit Tests ──────────────────────────────────────

Deno.test("checkShadowTradeExit closes long trade at TP", () => {
  const trade: ShadowTrade = {
    id: "shadow-1",
    userId: "user-1",
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.1000,
    stopLoss: 1.0950,
    takeProfit: 1.1100,
    size: 0.5,
    score: 70,
    shadowReason: { type: "below_threshold", score: 62, threshold: 65 },
    gateResults: {},
    entryTime: "2025-03-01T10:00:00Z",
    status: "open",
    exitPrice: null,
    exitTime: null,
    pnlPips: null,
    pnlUsd: null,
    mfe: 50,
    mae: 10,
    metadata: {},
  };

  const price: PriceUpdate = {
    symbol: "EUR/USD",
    bid: 1.1105,
    ask: 1.1107,
    timestamp: "2025-03-01T14:00:00Z",
  };

  const result = checkShadowTradeExit(trade, price, 0.0001);
  assertEquals(result !== null, true);
  assertEquals(result!.status, "closed_tp");
  assertEquals(result!.exitPrice, 1.1100);
  assertAlmostEquals(result!.pnlPips!, 100, 0.1); // (1.1100 - 1.1000) / 0.0001 = 100 pips
});

Deno.test("checkShadowTradeExit closes short trade at SL", () => {
  const trade: ShadowTrade = {
    id: "shadow-2",
    userId: "user-1",
    symbol: "GBP/USD",
    direction: "short",
    entryPrice: 1.2700,
    stopLoss: 1.2750,
    takeProfit: 1.2600,
    size: 1.0,
    score: 55,
    shadowReason: { type: "correlation_block", conflictsWith: ["EUR/USD"], correlation: 0.85 },
    gateResults: {},
    entryTime: "2025-03-01T10:00:00Z",
    status: "open",
    exitPrice: null,
    exitTime: null,
    pnlPips: null,
    pnlUsd: null,
    mfe: 20,
    mae: 30,
    metadata: {},
  };

  const price: PriceUpdate = {
    symbol: "GBP/USD",
    bid: 1.2748,
    ask: 1.2752, // Ask >= SL for short
    timestamp: "2025-03-01T12:00:00Z",
  };

  const result = checkShadowTradeExit(trade, price, 0.0001);
  assertEquals(result !== null, true);
  assertEquals(result!.status, "closed_sl");
  assertEquals(result!.exitPrice, 1.2750);
  assertAlmostEquals(result!.pnlPips!, -50, 0.1); // (1.2700 - 1.2750) / 0.0001 = -50 pips
});

Deno.test("checkShadowTradeExit returns null when price between SL and TP", () => {
  const trade: ShadowTrade = {
    id: "shadow-3",
    userId: "user-1",
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.1000,
    stopLoss: 1.0950,
    takeProfit: 1.1100,
    size: 0.5,
    score: 60,
    shadowReason: { type: "max_positions", currentCount: 3, maxAllowed: 3 },
    gateResults: {},
    entryTime: "2025-03-01T10:00:00Z",
    status: "open",
    exitPrice: null,
    exitTime: null,
    pnlPips: null,
    pnlUsd: null,
    mfe: 0,
    mae: 0,
    metadata: {},
  };

  const price: PriceUpdate = {
    symbol: "EUR/USD",
    bid: 1.1050,
    ask: 1.1052,
    timestamp: "2025-03-01T11:00:00Z",
  };

  const result = checkShadowTradeExit(trade, price, 0.0001);
  assertEquals(result, null);
});

Deno.test("checkShadowTradeExit ignores wrong symbol", () => {
  const trade: ShadowTrade = {
    id: "shadow-4",
    userId: "user-1",
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.1000,
    stopLoss: 1.0950,
    takeProfit: 1.1100,
    size: 0.5,
    score: 60,
    shadowReason: { type: "session_filter", session: "off_hours", reason: "Low volume" },
    gateResults: {},
    entryTime: "2025-03-01T10:00:00Z",
    status: "open",
    exitPrice: null,
    exitTime: null,
    pnlPips: null,
    pnlUsd: null,
    mfe: 0,
    mae: 0,
    metadata: {},
  };

  const price: PriceUpdate = {
    symbol: "GBP/USD",
    bid: 1.2700,
    ask: 1.2702,
    timestamp: "2025-03-01T11:00:00Z",
  };

  const result = checkShadowTradeExit(trade, price, 0.0001);
  assertEquals(result, null);
});

// ─── updateShadowTradeExcursion Tests ────────────────────────────────

Deno.test("updateShadowTradeExcursion tracks MFE correctly for long", () => {
  const trade: ShadowTrade = {
    id: "shadow-5",
    userId: "user-1",
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.1000,
    stopLoss: 1.0950,
    takeProfit: 1.1100,
    size: 0.5,
    score: 60,
    shadowReason: { type: "below_threshold", score: 60, threshold: 65 },
    gateResults: {},
    entryTime: "2025-03-01T10:00:00Z",
    status: "open",
    exitPrice: null,
    exitTime: null,
    pnlPips: null,
    pnlUsd: null,
    mfe: 30,
    mae: 5,
    metadata: {},
  };

  // Price moved to 1.1060 (60 pips favorable)
  const result = updateShadowTradeExcursion(trade, 1.1060, 0.0001);
  assertAlmostEquals(result.mfe, 60, 0.1);
  assertAlmostEquals(result.mae, 5, 0.1); // MAE stays at previous max
});

Deno.test("updateShadowTradeExcursion tracks MAE correctly for short", () => {
  const trade: ShadowTrade = {
    id: "shadow-6",
    userId: "user-1",
    symbol: "EUR/USD",
    direction: "short",
    entryPrice: 1.1000,
    stopLoss: 1.1050,
    takeProfit: 1.0900,
    size: 0.5,
    score: 60,
    shadowReason: { type: "news_filter", event: "NFP", minutesUntil: 15 },
    gateResults: {},
    entryTime: "2025-03-01T10:00:00Z",
    status: "open",
    exitPrice: null,
    exitTime: null,
    pnlPips: null,
    pnlUsd: null,
    mfe: 10,
    mae: 5,
    metadata: {},
  };

  // Price moved to 1.1030 (30 pips adverse for short)
  const result = updateShadowTradeExcursion(trade, 1.1030, 0.0001);
  assertAlmostEquals(result.mfe, 10, 0.1); // MFE stays at previous max
  assertAlmostEquals(result.mae, 30, 0.1); // MAE updated to 30
});

// ─── computeShadowPerformance Tests ──────────────────────────────────

Deno.test("computeShadowPerformance computes correct metrics", () => {
  const trades: ShadowTrade[] = [
    // Win: +100 pips
    {
      id: "s1", userId: "u1", symbol: "EUR/USD", direction: "long",
      entryPrice: 1.1000, stopLoss: 1.0950, takeProfit: 1.1100, size: 0.5,
      score: 60, shadowReason: { type: "gate_failure", gateName: "Session", gateNumber: 5, detail: "" },
      gateResults: {}, entryTime: "2025-03-01T10:00:00Z",
      status: "closed_tp", exitPrice: 1.1100, exitTime: "2025-03-01T14:00:00Z",
      pnlPips: 100, pnlUsd: 500, mfe: 100, mae: 10, metadata: {},
    },
    // Win: +80 pips
    {
      id: "s2", userId: "u1", symbol: "GBP/USD", direction: "long",
      entryPrice: 1.2700, stopLoss: 1.2650, takeProfit: 1.2780, size: 0.5,
      score: 58, shadowReason: { type: "gate_failure", gateName: "Session", gateNumber: 5, detail: "" },
      gateResults: {}, entryTime: "2025-03-02T10:00:00Z",
      status: "closed_tp", exitPrice: 1.2780, exitTime: "2025-03-02T14:00:00Z",
      pnlPips: 80, pnlUsd: 400, mfe: 80, mae: 15, metadata: {},
    },
    // Loss: -50 pips
    {
      id: "s3", userId: "u1", symbol: "USD/JPY", direction: "short",
      entryPrice: 142.00, stopLoss: 142.50, takeProfit: 141.00, size: 0.5,
      score: 55, shadowReason: { type: "below_threshold", score: 55, threshold: 60 },
      gateResults: {}, entryTime: "2025-03-03T10:00:00Z",
      status: "closed_sl", exitPrice: 142.50, exitTime: "2025-03-03T12:00:00Z",
      pnlPips: -50, pnlUsd: -250, mfe: 20, mae: 50, metadata: {},
    },
    // Still open
    {
      id: "s4", userId: "u1", symbol: "AUD/USD", direction: "long",
      entryPrice: 0.6500, stopLoss: 0.6450, takeProfit: 0.6600, size: 0.5,
      score: 63, shadowReason: { type: "max_positions", currentCount: 3, maxAllowed: 3 },
      gateResults: {}, entryTime: "2025-03-04T10:00:00Z",
      status: "open", exitPrice: null, exitTime: null,
      pnlPips: null, pnlUsd: null, mfe: 30, mae: 5, metadata: {},
    },
  ];

  const perf = computeShadowPerformance(trades);

  assertEquals(perf.totalTrades, 4);
  assertEquals(perf.wins, 2);
  assertEquals(perf.losses, 1);
  assertEquals(perf.openCount, 1);
  assertAlmostEquals(perf.winRate, 2 / 3, 0.01); // 2 wins out of 3 closed
  assertAlmostEquals(perf.avgWinPips, 90, 0.1); // (100 + 80) / 2
  assertAlmostEquals(perf.avgLossPips, 50, 0.1);
  assertAlmostEquals(perf.profitFactor, 180 / 50, 0.01); // 3.6
  assertAlmostEquals(perf.totalPnlPips, 130, 0.1); // 180 - 50

  // Check byReason breakdown
  assertEquals(perf.byReason["gate_failure"].count, 2);
  assertEquals(perf.byReason["below_threshold"].count, 1);
});

// ─── evaluateGateValue Tests ─────────────────────────────────────────

Deno.test("evaluateGateValue identifies value-adding gate (blocked trades lost money)", () => {
  const trades: ShadowTrade[] = [];
  // Create 6 trades blocked by "Volatility" gate that all lost
  for (let i = 0; i < 6; i++) {
    trades.push({
      id: `sv-${i}`, userId: "u1", symbol: "EUR/USD", direction: "long",
      entryPrice: 1.1000, stopLoss: 1.0950, takeProfit: 1.1100, size: 0.5,
      score: 55, shadowReason: { type: "gate_failure", gateName: "Volatility", gateNumber: 8, detail: "" },
      gateResults: {}, entryTime: `2025-03-0${i + 1}T10:00:00Z`,
      status: "closed_sl", exitPrice: 1.0950, exitTime: `2025-03-0${i + 1}T12:00:00Z`,
      pnlPips: -50, pnlUsd: -250, mfe: 10, mae: 50, metadata: {},
    });
  }

  const result = evaluateGateValue(trades, "Volatility");
  assertEquals(result.sampleSize, 6);
  assertEquals(result.value > 0, true); // Positive value = gate is protecting
  assertEquals(result.winRate, 0);
  assertEquals(result.detail.includes("PROTECTING"), true);
});

Deno.test("evaluateGateValue identifies costly gate (blocked trades would have won)", () => {
  const trades: ShadowTrade[] = [];
  // Create 6 trades blocked by "Session" gate that all won
  for (let i = 0; i < 6; i++) {
    trades.push({
      id: `sc-${i}`, userId: "u1", symbol: "EUR/USD", direction: "long",
      entryPrice: 1.1000, stopLoss: 1.0950, takeProfit: 1.1100, size: 0.5,
      score: 65, shadowReason: { type: "gate_failure", gateName: "Session", gateNumber: 5, detail: "" },
      gateResults: {}, entryTime: `2025-03-0${i + 1}T10:00:00Z`,
      status: "closed_tp", exitPrice: 1.1100, exitTime: `2025-03-0${i + 1}T14:00:00Z`,
      pnlPips: 100, pnlUsd: 500, mfe: 100, mae: 10, metadata: {},
    });
  }

  const result = evaluateGateValue(trades, "Session");
  assertEquals(result.sampleSize, 6);
  assertEquals(result.value < 0, true); // Negative value = gate is costing money
  assertEquals(result.winRate, 1.0);
  assertEquals(result.detail.includes("COSTING"), true);
});

Deno.test("evaluateGateValue returns insufficient data for small sample", () => {
  const trades: ShadowTrade[] = [
    {
      id: "si-1", userId: "u1", symbol: "EUR/USD", direction: "long",
      entryPrice: 1.1000, stopLoss: 1.0950, takeProfit: 1.1100, size: 0.5,
      score: 55, shadowReason: { type: "gate_failure", gateName: "Rare Gate", gateNumber: 20, detail: "" },
      gateResults: {}, entryTime: "2025-03-01T10:00:00Z",
      status: "closed_tp", exitPrice: 1.1100, exitTime: "2025-03-01T14:00:00Z",
      pnlPips: 100, pnlUsd: 500, mfe: 100, mae: 10, metadata: {},
    },
  ];

  const result = evaluateGateValue(trades, "Rare Gate");
  assertEquals(result.sampleSize, 1);
  assertEquals(result.value, 0); // Not enough data
  assertEquals(result.detail.includes("Insufficient"), true);
});
