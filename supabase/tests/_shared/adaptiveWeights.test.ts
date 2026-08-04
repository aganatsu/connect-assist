import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeAdaptiveWeights,
  parseTradeFactors,
  toTradeRecords,
  mergeAdaptiveWeights,
  DEFAULT_ADAPTIVE_CONFIG,
  type TradeRecord,
  type AdaptiveWeightsConfig,
} from "./adaptiveWeights.ts";
import { DEFAULT_FACTOR_WEIGHTS } from "./confluenceScoring.ts";

// ─── Helper: Generate synthetic trade records ────────────────────────

function makeTrade(opts: {
  factors: string[];
  win: boolean;
  daysAgo?: number;
  regime?: string;
}): TradeRecord {
  const closedAt = new Date(Date.now() - (opts.daysAgo ?? 1) * 24 * 60 * 60 * 1000).toISOString();
  return {
    factors: Object.keys(DEFAULT_FACTOR_WEIGHTS).map((name) => ({
      name,
      present: opts.factors.includes(name),
      weight: opts.factors.includes(name) ? DEFAULT_FACTOR_WEIGHTS[name] : 0,
    })),
    pnlPips: opts.win ? 25 : -15,
    closedAt,
    regime: opts.regime,
    symbol: "EUR/USD",
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("computeAdaptiveWeights returns defaults when minTrades not met", () => {
  const trades = [makeTrade({ factors: ["marketStructure", "orderBlock"], win: true })];
  const result = computeAdaptiveWeights(trades);
  assertEquals(result.adapted, false);
  assertEquals(result.weights, DEFAULT_FACTOR_WEIGHTS);
  assertEquals(result.totalTrades, 1);
});

Deno.test("computeAdaptiveWeights boosts factors with high win rate", () => {
  // Create 40 trades: marketStructure present in 30, wins 25 of them (83%)
  // orderBlock present in 30, wins only 10 (33%)
  // Baseline: 35 wins / 40 total = 87.5% (but factor-specific matters)
  const trades: TradeRecord[] = [];
  for (let i = 0; i < 25; i++) {
    trades.push(makeTrade({ factors: ["marketStructure", "fairValueGap"], win: true, daysAgo: i + 1 }));
  }
  for (let i = 0; i < 5; i++) {
    trades.push(makeTrade({ factors: ["marketStructure", "orderBlock"], win: false, daysAgo: i + 1 }));
  }
  for (let i = 0; i < 5; i++) {
    trades.push(makeTrade({ factors: ["orderBlock"], win: true, daysAgo: i + 1 }));
  }
  for (let i = 0; i < 5; i++) {
    trades.push(makeTrade({ factors: ["orderBlock"], win: false, daysAgo: i + 1 }));
  }

  const result = computeAdaptiveWeights(trades, { minTrades: 30 });
  assertEquals(result.adapted, true);
  assertEquals(result.totalTrades, 40);

  // marketStructure: present in 30 trades, 25 wins = 83% win rate
  const msStat = result.stats.find((s) => s.name === "marketStructure")!;
  assertEquals(msStat.presentCount, 30);
  assertEquals(msStat.presentWins, 25);
  // Its scale should be > 1 (boosted)
  assertEquals(msStat.scale > 1, true);
  assertEquals(result.weights["marketStructure"] > DEFAULT_FACTOR_WEIGHTS["marketStructure"], true);
});

Deno.test("computeAdaptiveWeights penalizes factors with low win rate", () => {
  // Factor "judasSwing" present in all losing trades, absent in winners
  const trades: TradeRecord[] = [];
  for (let i = 0; i < 20; i++) {
    trades.push(makeTrade({ factors: ["marketStructure", "fairValueGap"], win: true, daysAgo: i + 1 }));
  }
  for (let i = 0; i < 15; i++) {
    trades.push(makeTrade({ factors: ["judasSwing", "orderBlock"], win: false, daysAgo: i + 1 }));
  }

  const result = computeAdaptiveWeights(trades, { minTrades: 30 });
  assertEquals(result.adapted, true);

  const jsStat = result.stats.find((s) => s.name === "judasSwing")!;
  // judasSwing present in 15 trades, all losses = 0% win rate
  assertEquals(jsStat.presentCount, 15);
  assertEquals(jsStat.presentWins, 0);
  assertEquals(jsStat.presentWinRate, 0);
  // Scale should be < 1 (penalized)
  assertEquals(jsStat.scale < 1, true);
  assertEquals(result.weights["judasSwing"] < DEFAULT_FACTOR_WEIGHTS["judasSwing"], true);
});

Deno.test("computeAdaptiveWeights respects minScale and maxScale", () => {
  // Create extreme scenario: factor always loses
  const trades: TradeRecord[] = [];
  for (let i = 0; i < 20; i++) {
    trades.push(makeTrade({ factors: ["marketStructure"], win: true, daysAgo: i + 1 }));
  }
  for (let i = 0; i < 20; i++) {
    trades.push(makeTrade({ factors: ["volumeProfile"], win: false, daysAgo: i + 1 }));
  }

  const result = computeAdaptiveWeights(trades, {
    minTrades: 30,
    minScale: 0.3,
    maxScale: 2.0,
    sensitivity: 5.0, // High sensitivity to force clamping
  });

  // volumeProfile should be clamped at minScale
  const vpStat = result.stats.find((s) => s.name === "volumeProfile")!;
  assertEquals(vpStat.scale >= 0.3, true);

  // marketStructure should be clamped at maxScale
  const msStat = result.stats.find((s) => s.name === "marketStructure")!;
  assertEquals(msStat.scale <= 2.0, true);
});

Deno.test("computeAdaptiveWeights applies time decay", () => {
  // Recent wins for a factor vs old wins — recent should matter more
  const trades: TradeRecord[] = [];
  // Old trades (60 days ago): factor wins
  for (let i = 0; i < 20; i++) {
    trades.push(makeTrade({ factors: ["displacement"], win: true, daysAgo: 60 + i }));
  }
  // Recent trades (1-5 days ago): factor loses
  for (let i = 0; i < 15; i++) {
    trades.push(makeTrade({ factors: ["displacement"], win: false, daysAgo: i + 1 }));
  }

  const result = computeAdaptiveWeights(trades, {
    minTrades: 30,
    decayPerWeek: 0.85, // Strong decay
  });

  // Despite more total wins, recent losses should dominate
  const dStat = result.stats.find((s) => s.name === "displacement")!;
  // The decay-weighted win rate should be lower than raw win rate (20/35 = 57%)
  assertEquals(dStat.presentWinRate < 0.57, true);
});

Deno.test("computeAdaptiveWeights filters by regime when regimeAware", () => {
  const trades: TradeRecord[] = [];
  // In trending regime: marketStructure wins
  for (let i = 0; i < 20; i++) {
    trades.push(makeTrade({ factors: ["marketStructure"], win: true, daysAgo: i + 1, regime: "trending" }));
  }
  // In ranging regime: marketStructure loses
  for (let i = 0; i < 20; i++) {
    trades.push(makeTrade({ factors: ["marketStructure"], win: false, daysAgo: i + 1, regime: "ranging" }));
  }

  // Without regime filter: mixed results
  const allResult = computeAdaptiveWeights(trades, { minTrades: 30, regimeAware: false });
  const msAll = allResult.stats.find((s) => s.name === "marketStructure")!;

  // With regime filter for trending: should be boosted
  const trendResult = computeAdaptiveWeights(trades, { minTrades: 15 }, "trending");
  const msTrend = trendResult.stats.find((s) => s.name === "marketStructure")!;

  // Trending regime should show higher win rate than overall
  assertEquals(msTrend.presentWinRate > msAll.presentWinRate, true);
});

Deno.test("computeAdaptiveWeights excludes trades outside lookback window", () => {
  const trades: TradeRecord[] = [];
  // All trades are 100 days old (outside 90-day default window)
  for (let i = 0; i < 40; i++) {
    trades.push(makeTrade({ factors: ["marketStructure"], win: true, daysAgo: 100 + i }));
  }

  const result = computeAdaptiveWeights(trades);
  assertEquals(result.adapted, false);
  assertEquals(result.totalTrades, 0);
});

Deno.test("parseTradeFactors extracts factors from signal_reason JSON", () => {
  const signalReason = JSON.stringify({
    factorScores: [
      { name: "marketStructure", present: true, weight: 2.5 },
      { name: "orderBlock", present: false, weight: 0 },
      { name: "fairValueGap", present: true, weight: 2.0 },
    ],
  });

  const factors = parseTradeFactors(signalReason);
  assertEquals(factors.length, 3);
  assertEquals(factors[0], { name: "marketStructure", present: true, weight: 2.5 });
  assertEquals(factors[1], { name: "orderBlock", present: false, weight: 0 });
});

Deno.test("parseTradeFactors handles invalid input gracefully", () => {
  assertEquals(parseTradeFactors(""), []);
  assertEquals(parseTradeFactors("not json"), []);
  assertEquals(parseTradeFactors("{}"), []);
  assertEquals(parseTradeFactors(JSON.stringify({ factorScores: "not array" })), []);
});

Deno.test("toTradeRecords converts raw DB rows to TradeRecord format", () => {
  const rows = [
    {
      pnl_pips: "25.5",
      closed_at: "2025-03-01T10:00:00Z",
      signal_reason: JSON.stringify({
        factorScores: [
          { name: "marketStructure", present: true, weight: 2.5 },
          { name: "orderBlock", present: true, weight: 2.0 },
        ],
      }),
      regime: "trending",
      symbol: "EUR/USD",
    },
    {
      pnl_pips: "-10",
      closed_at: "2025-03-02T10:00:00Z",
      signal_reason: JSON.stringify({
        factorScores: [
          { name: "fairValueGap", present: true, weight: 2.0 },
        ],
      }),
    },
    {
      // No factors — should be filtered out
      pnl_pips: "5",
      closed_at: "2025-03-03T10:00:00Z",
      signal_reason: "{}",
    },
  ];

  const records = toTradeRecords(rows);
  assertEquals(records.length, 2);
  assertEquals(records[0].pnlPips, 25.5);
  assertEquals(records[0].regime, "trending");
  assertEquals(records[0].factors.length, 2);
  assertEquals(records[1].pnlPips, -10);
});

Deno.test("mergeAdaptiveWeights returns existing when not adapted", () => {
  const existing = { marketStructure: 3.0, orderBlock: 1.5 };
  const result = { adapted: false, weights: DEFAULT_FACTOR_WEIGHTS, stats: [], baselineWinRate: 0, totalTrades: 5, regime: null };
  const merged = mergeAdaptiveWeights(existing, result);
  assertEquals(merged, existing);
});

Deno.test("mergeAdaptiveWeights overlays adaptive weights when adapted", () => {
  const existing = { marketStructure: 2.5, orderBlock: 2.0 };
  const adaptiveResult = {
    adapted: true,
    weights: { marketStructure: 3.5, orderBlock: 1.2, fairValueGap: 2.5 },
    stats: [],
    baselineWinRate: 0.5,
    totalTrades: 50,
    regime: null,
  };
  const merged = mergeAdaptiveWeights(existing, adaptiveResult);
  assertEquals(merged["marketStructure"], 3.5);
  assertEquals(merged["orderBlock"], 1.2);
  assertEquals(merged["fairValueGap"], 2.5);
});

Deno.test("computeAdaptiveWeights confidence levels affect scale adjustment", () => {
  // Low sample size should reduce the adjustment
  const trades: TradeRecord[] = [];
  // Only 3 trades with "amdPhase" (below minSampleSize of 5)
  for (let i = 0; i < 3; i++) {
    trades.push(makeTrade({ factors: ["amdPhase"], win: true, daysAgo: i + 1 }));
  }
  // 32 other trades to meet minTrades
  for (let i = 0; i < 32; i++) {
    trades.push(makeTrade({ factors: ["marketStructure"], win: i < 16, daysAgo: i + 1 }));
  }

  const result = computeAdaptiveWeights(trades, { minTrades: 30, minSampleSize: 5 });
  const amdStat = result.stats.find((s) => s.name === "amdPhase")!;
  // Low confidence: scale should stay near 1.0 (minimal adjustment)
  assertEquals(amdStat.confidence, "low");
  assertAlmostEquals(amdStat.scale, 1.0, 0.3); // Within 0.3 of 1.0
});
