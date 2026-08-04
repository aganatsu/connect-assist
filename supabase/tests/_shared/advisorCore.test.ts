import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computePerformance,
  computeFactorLift,
  computeSymbolStats,
  detectRegimeFromTrades,
  buildRegimeRecommendations,
  normalizeTradeRecord,
  buildPromptPayload,
  type TradeRecord,
  type TradeReasoning,
  type AdvisorContext,
  type PerformanceMetrics,
  type FactorLift,
  type SymbolStats,
  type RegimeAnalysis,
} from "./advisorCore.ts";
import type { ResolvedRejection } from "./gatePerformanceEngine.ts";
import { DEFAULT_FACTOR_WEIGHTS } from "./confluenceScoring.ts";

// ─── Test Helpers ───────────────────────────────────────────
function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: `trade-${Math.random().toString(36).slice(2, 8)}`,
    user_id: "user-1",
    symbol: "EURUSD",
    direction: "buy",
    entry_price: 1.1000,
    exit_price: 1.1050,
    sl: 1.0950,
    tp: 1.1100,
    pnl: 50,
    pnl_percent: 1.0,
    close_reason: "tp_hit",
    opened_at: "2025-07-01T10:00:00Z",
    closed_at: "2025-07-01T14:00:00Z",
    lot_size: 0.1,
    ...overrides,
  };
}

function makeReasoning(overrides: Partial<TradeReasoning> = {}): TradeReasoning {
  return {
    id: `reason-${Math.random().toString(36).slice(2, 8)}`,
    user_id: "user-1",
    symbol: "EURUSD",
    direction: "buy",
    confluence_score: 7.5,
    summary: "Strong setup with OB + FVG",
    factors_json: [
      { name: "marketStructure", present: true, weight: 2.5, detail: "BOS confirmed", group: "Structure" },
      { name: "orderBlock", present: true, weight: 2.0, detail: "Bullish OB", group: "Entry" },
      { name: "fairValueGap", present: false, weight: 2.0, detail: "No FVG", group: "Entry" },
      { name: "premiumDiscountFib", present: true, weight: 2.0, detail: "In discount", group: "Value" },
      { name: "sessionQuality", present: true, weight: 1.5, detail: "London session", group: "Timing" },
    ],
    session: "London",
    timeframe: "15m",
    created_at: "2025-07-01T10:00:00Z",
    ...overrides,
  };
}

function makeRejection(overrides: Partial<ResolvedRejection> = {}): ResolvedRejection {
  return {
    id: `rej-${Math.random().toString(36).slice(2, 8)}`,
    symbol: "EURUSD",
    direction: "buy",
    failed_gates: ["gate_confluence_min"],
    confluence_score: 4.5,
    tier1_count: 1,
    outcome_status: "would_have_won",
    mfe_pips: 35,
    mae_pips: 10,
    tp_hit: true,
    sl_hit: false,
    regime: "trending",
    session_name: "London",
    rejected_at: "2025-07-01T09:00:00Z",
    rr_ratio: 2.5,
    ...overrides,
  } as ResolvedRejection;
}

// ─── normalizeTradeRecord ───────────────────────────────────
Deno.test("normalizeTradeRecord handles standard fields", () => {
  const raw = {
    id: "123",
    user_id: "u1",
    symbol: "GBPUSD",
    direction: "sell",
    entry_price: 1.25,
    exit_price: 1.24,
    stop_loss: 1.26,
    take_profit: 1.23,
    pnl: 100,
    pnl_percent: 2.0,
    close_reason: "tp_hit",
    open_time: "2025-01-01T00:00:00Z",
    closed_at: "2025-01-01T04:00:00Z",
    size: 0.5,
    bot_id: "bot-1",
  };
  const result = normalizeTradeRecord(raw);
  assertEquals(result.id, "123");
  assertEquals(result.symbol, "GBPUSD");
  assertEquals(result.direction, "sell");
  assertEquals(result.sl, 1.26);
  assertEquals(result.tp, 1.23);
  assertEquals(result.lot_size, 0.5);
  assertEquals(result.bot_id, "bot-1");
});

Deno.test("normalizeTradeRecord handles missing/null fields gracefully", () => {
  const raw = { id: null, symbol: undefined, pnl: "not_a_number" };
  const result = normalizeTradeRecord(raw as unknown as Record<string, unknown>);
  // null ?? undefined ?? "" => "" (nullish coalescing skips null and undefined)
  assertEquals(result.id, "");
  assertEquals(result.symbol, ""); // undefined ?? "" => "" then String("") = ""
  assertEquals(result.pnl, 0); // NaN → 0
  assertEquals(result.sl, 0); // missing → 0
  assertEquals(result.tp, 0); // missing → 0
});

// ─── computePerformance ─────────────────────────────────────
Deno.test("computePerformance returns zeros for empty trades", () => {
  const perf = computePerformance([]);
  assertEquals(perf.totalTrades, 0);
  assertEquals(perf.winRate, 0);
  assertEquals(perf.totalPnl, 0);
});

Deno.test("computePerformance computes correct metrics for mixed trades", () => {
  const trades = [
    makeTrade({ pnl: 100, close_reason: "tp_hit", opened_at: "2025-07-01T10:00:00Z", closed_at: "2025-07-01T14:00:00Z" }),
    makeTrade({ pnl: 80, close_reason: "tp_hit", opened_at: "2025-07-02T10:00:00Z", closed_at: "2025-07-02T16:00:00Z" }),
    makeTrade({ pnl: -50, close_reason: "sl_hit", opened_at: "2025-07-03T10:00:00Z", closed_at: "2025-07-03T12:00:00Z" }),
    makeTrade({ pnl: -30, close_reason: "sl_hit", opened_at: "2025-07-04T10:00:00Z", closed_at: "2025-07-04T11:00:00Z" }),
    makeTrade({ pnl: 60, close_reason: "tp_hit", opened_at: "2025-07-05T10:00:00Z", closed_at: "2025-07-05T18:00:00Z" }),
  ];

  const perf = computePerformance(trades);
  assertEquals(perf.totalTrades, 5);
  assertEquals(perf.winRate, 60); // 3/5
  assertEquals(perf.totalPnl, 160); // 100+80-50-30+60
  assertEquals(perf.avgPnl, 32); // 160/5
  assertEquals(perf.avgWin, 80); // (100+80+60)/3
  assertEquals(perf.avgLoss, 40); // (50+30)/2
  assert(perf.profitFactor > 2.9 && perf.profitFactor < 3.1); // 240/80
  assertEquals(perf.maxConsecutiveLosses, 2);
});

Deno.test("computePerformance computes session breakdowns correctly", () => {
  const trades = [
    makeTrade({ pnl: 100, opened_at: "2025-07-01T03:00:00Z" }), // Asian (UTC 0-8)
    makeTrade({ pnl: -50, opened_at: "2025-07-01T09:00:00Z" }), // London (UTC 8-13)
    makeTrade({ pnl: 80, opened_at: "2025-07-01T14:00:00Z" }),  // NY (UTC 13-17)
  ];

  const perf = computePerformance(trades);
  assertExists(perf.bySession["Asian"]);
  assertExists(perf.bySession["London"]);
  assertExists(perf.bySession["NY"]);
  assertEquals(perf.bySession["Asian"].count, 1);
  assertEquals(perf.bySession["Asian"].pnl, 100);
});

Deno.test("computePerformance handles all-winners gracefully (profitFactor = Infinity)", () => {
  const trades = [
    makeTrade({ pnl: 50 }),
    makeTrade({ pnl: 100 }),
  ];
  const perf = computePerformance(trades);
  assertEquals(perf.profitFactor, Infinity);
  assertEquals(perf.winRate, 100);
});

// ─── computeFactorLift ──────────────────────────────────────
Deno.test("computeFactorLift computes $-lift correctly", () => {
  // Create 10 trades where marketStructure present = wins, absent = losses
  const trades: TradeRecord[] = [];
  const reasonings: TradeReasoning[] = [];

  for (let i = 0; i < 10; i++) {
    const isWin = i < 7; // 7 wins, 3 losses
    const msPresent = i < 6; // Present in first 6 (5 wins, 1 loss)
    const t = makeTrade({
      id: `t-${i}`,
      pnl: isWin ? 50 : -30,
      opened_at: `2025-07-0${i + 1}T10:00:00Z`,
      closed_at: `2025-07-0${i + 1}T14:00:00Z`,
    });
    trades.push(t);

    reasonings.push(makeReasoning({
      id: `r-${i}`,
      symbol: "EURUSD",
      direction: "buy",
      created_at: `2025-07-0${i + 1}T10:00:00Z`,
      factors_json: [
        { name: "marketStructure", present: msPresent, weight: 2.5, detail: "test", group: "Structure" },
        { name: "orderBlock", present: true, weight: 2.0, detail: "test", group: "Entry" },
      ],
    }));
  }

  const lift = computeFactorLift(trades, reasonings, DEFAULT_FACTOR_WEIGHTS);
  const msLift = lift.find(f => f.factorKey === "marketStructure");
  assertExists(msLift);
  // Present in first 6 trades (i=0..5), absent in last 4 (i=6..9)
  assertEquals(msLift.presentCount, 6);
  // The absent count depends on how many trades matched to reasonings
  // (all 10 should match since timestamps align)
  assert(msLift.absentCount >= 3, `Expected absentCount >= 3, got ${msLift.absentCount}`);
  // Present: 5 wins * 50 + 1 loss * -30 = 220, avg = 36.67
  assert(msLift.dollarLift > 15, `Expected positive dollarLift, got ${msLift.dollarLift}`); // Positive lift
  assert(msLift.presentWinRate > 80); // 5/6 = 83%
});

Deno.test("computeFactorLift requires minimum 5 present samples", () => {
  const trades = [
    makeTrade({ id: "t1", pnl: 50, opened_at: "2025-07-01T10:00:00Z", closed_at: "2025-07-01T14:00:00Z" }),
    makeTrade({ id: "t2", pnl: 50, opened_at: "2025-07-02T10:00:00Z", closed_at: "2025-07-02T14:00:00Z" }),
    makeTrade({ id: "t3", pnl: 50, opened_at: "2025-07-03T10:00:00Z", closed_at: "2025-07-03T14:00:00Z" }),
  ];
  const reasonings = trades.map((t, i) => makeReasoning({
    id: `r-${i}`,
    created_at: t.opened_at,
    factors_json: [
      { name: "rareFactor", present: true, weight: 1.0, detail: "test", group: "Test" },
    ],
  }));

  const lift = computeFactorLift(trades, reasonings, DEFAULT_FACTOR_WEIGHTS);
  const rare = lift.find(f => f.factorKey === "rareFactor");
  // Should NOT appear because only 3 present samples (< 5 minimum)
  assertEquals(rare, undefined);
});

// ─── computeSymbolStats ─────────────────────────────────────
Deno.test("computeSymbolStats groups by symbol correctly", () => {
  const trades = [
    makeTrade({ symbol: "EURUSD", pnl: 50 }),
    makeTrade({ symbol: "EURUSD", pnl: -20 }),
    makeTrade({ symbol: "GBPUSD", pnl: 100 }),
    makeTrade({ symbol: "GBPUSD", pnl: 80 }),
    makeTrade({ symbol: "GBPUSD", pnl: -40 }),
  ];
  const rejections = [
    makeRejection({ symbol: "EURUSD", outcome_status: "would_have_won" }),
    makeRejection({ symbol: "EURUSD", outcome_status: "would_have_lost" }),
  ];

  const stats = computeSymbolStats(trades, rejections as ResolvedRejection[]);
  assertEquals(stats.length, 2);

  const gbp = stats.find(s => s.symbol === "GBPUSD")!;
  assertEquals(gbp.tradeCount, 3);
  assertEquals(gbp.totalPnl, 140);
  assert(gbp.winRate > 66 && gbp.winRate < 67); // 2/3

  const eur = stats.find(s => s.symbol === "EURUSD")!;
  assertEquals(eur.tradeCount, 2);
  assertEquals(eur.rejectedCount, 2);
  assertEquals(eur.rejectedWouldHaveWon, 1);
});

// ─── detectRegimeFromTrades ─────────────────────────────────
Deno.test("detectRegimeFromTrades returns unknown for < 5 trades", () => {
  const trades = [makeTrade(), makeTrade(), makeTrade()];
  const regime = detectRegimeFromTrades(trades);
  assertEquals(regime.currentRegime, "unknown");
  assertEquals(regime.regimeConfidence, 0);
});

Deno.test("detectRegimeFromTrades detects trending market (directional bias + low SL rate)", () => {
  // All buys, TP hits, long hold times
  const trades = Array.from({ length: 15 }, (_, i) => makeTrade({
    id: `t-${i}`,
    direction: "buy",
    pnl: 50,
    close_reason: "tp_hit",
    opened_at: `2025-07-${String(i + 1).padStart(2, "0")}T02:00:00Z`,
    closed_at: `2025-07-${String(i + 1).padStart(2, "0")}T18:00:00Z`, // 16h hold
  }));

  const regime = detectRegimeFromTrades(trades);
  assert(regime.currentRegime === "strong_trend" || regime.currentRegime === "mild_trend");
  assert(regime.regimeConfidence > 0.4);
  assertEquals(regime.directionalBias, "bullish");
});

Deno.test("detectRegimeFromTrades detects choppy market (mixed direction + high SL rate)", () => {
  const trades = Array.from({ length: 12 }, (_, i) => makeTrade({
    id: `t-${i}`,
    direction: i % 2 === 0 ? "buy" : "sell", // alternating
    pnl: -30,
    close_reason: "sl_hit", // all SL hits
    opened_at: `2025-07-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
    closed_at: `2025-07-${String(i + 1).padStart(2, "0")}T12:00:00Z`, // 2h hold (short)
  }));

  const regime = detectRegimeFromTrades(trades);
  assert(regime.currentRegime === "choppy_range" || regime.currentRegime === "mild_range");
  assert(regime.regimeIndicators.length > 0);
});

// ─── buildRegimeRecommendations ─────────────────────────────
Deno.test("buildRegimeRecommendations uses CORRECT factor key names", () => {
  const regime: RegimeAnalysis = {
    currentRegime: "strong_trend",
    regimeConfidence: 0.8,
    regimeIndicators: ["Strong buy bias"],
    regimeImpact: "Trending conditions",
    directionalBias: "bullish",
  };

  const recs = buildRegimeRecommendations(regime, DEFAULT_FACTOR_WEIGHTS, {});

  // Should have at least one recommendation
  assert(recs.length > 0);

  // All factor keys in suggested_value MUST exist in DEFAULT_FACTOR_WEIGHTS
  for (const rec of recs) {
    if (rec.category === "regime_adaptation" && rec.title.includes("Factor Weights")) {
      for (const key of Object.keys(rec.suggested_value)) {
        assert(
          key in DEFAULT_FACTOR_WEIGHTS,
          `Regime preset uses invalid factor key "${key}" — not in DEFAULT_FACTOR_WEIGHTS`,
        );
      }
    }
  }
});

Deno.test("buildRegimeRecommendations does NOT use old wrong keys (premiumDiscount, fvg, breaker, etc.)", () => {
  const wrongKeys = ["premiumDiscount", "fvg", "breaker", "silverBullet", "amd", "trendDirection"];

  for (const regimeType of ["strong_trend", "mild_trend", "choppy_range", "mild_range", "transitional"] as const) {
    const regime: RegimeAnalysis = {
      currentRegime: regimeType,
      regimeConfidence: 0.9,
      regimeIndicators: ["Test"],
      regimeImpact: "Test",
    };

    const recs = buildRegimeRecommendations(regime, DEFAULT_FACTOR_WEIGHTS, {});
    for (const rec of recs) {
      for (const key of Object.keys(rec.suggested_value)) {
        assert(
          !wrongKeys.includes(key),
          `Regime "${regimeType}" still uses wrong key "${key}" — this is the bug we fixed!`,
        );
      }
    }
  }
});

Deno.test("buildRegimeRecommendations returns empty for unknown regime", () => {
  const regime: RegimeAnalysis = {
    currentRegime: "unknown",
    regimeConfidence: 0,
    regimeIndicators: [],
    regimeImpact: "",
  };
  const recs = buildRegimeRecommendations(regime, DEFAULT_FACTOR_WEIGHTS, {});
  assertEquals(recs.length, 0);
});

Deno.test("buildRegimeRecommendations returns empty for low confidence", () => {
  const regime: RegimeAnalysis = {
    currentRegime: "strong_trend",
    regimeConfidence: 0.2, // Below 0.4 threshold
    regimeIndicators: ["Weak signal"],
    regimeImpact: "",
  };
  const recs = buildRegimeRecommendations(regime, DEFAULT_FACTOR_WEIGHTS, {});
  assertEquals(recs.length, 0);
});

// ─── buildPromptPayload ─────────────────────────────────────
Deno.test("buildPromptPayload produces compact JSON without raw trade data", () => {
  const trades = [makeTrade({ pnl: 50 }), makeTrade({ pnl: -20 })];
  const perf = computePerformance(trades);
  const factorLift: FactorLift[] = [];
  const symbolStats: SymbolStats[] = [];
  const regime: RegimeAnalysis = {
    currentRegime: "mild_trend",
    regimeConfidence: 0.6,
    regimeIndicators: ["test"],
    regimeImpact: "test",
  };

  const ctx: AdvisorContext = {
    mode: "daily",
    userId: "u1",
    botId: "b1",
    botName: "TestBot",
    config: {} as any,
    configRaw: {},
    trades,
    reasonings: [],
    rejections: [],
    pastRecommendations: [],
    balance: 10000,
    peakBalance: 10500,
    windowDays: 3,
  };

  const payload = buildPromptPayload(ctx, perf, factorLift, symbolStats, regime, "");

  // Should NOT contain raw trade arrays
  const json = JSON.stringify(payload);
  assert(!json.includes("entry_price"), "Payload should not contain raw trade data");
  assert(!json.includes("exit_price"), "Payload should not contain raw trade data");

  // Should contain computed metrics
  assertExists((payload as any).performance.totalTrades);
  assertExists((payload as any).regime.current);
  assertEquals((payload as any).mode, "daily");
  assertEquals((payload as any).windowDays, 3);
});

// ─── Integration: Full pipeline math consistency ────────────
Deno.test("Performance metrics are internally consistent (avgWin * wins - avgLoss * losses = totalPnl)", () => {
  const trades = [
    makeTrade({ pnl: 120 }),
    makeTrade({ pnl: 80 }),
    makeTrade({ pnl: -50 }),
    makeTrade({ pnl: -30 }),
    makeTrade({ pnl: 200 }),
    makeTrade({ pnl: -100 }),
  ];

  const perf = computePerformance(trades);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const reconstructedPnl = perf.avgWin * wins.length - perf.avgLoss * losses.length;
  // Should equal totalPnl within floating point tolerance
  assert(
    Math.abs(reconstructedPnl - perf.totalPnl) < 0.01,
    `Reconstructed PnL ${reconstructedPnl} != totalPnl ${perf.totalPnl}`,
  );
});
