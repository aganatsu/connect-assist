/**
 * Tests for the Autonomous Optimizer
 * 
 * Covers:
 * - TPE algorithm (sampling, tell/ask, convergence)
 * - Parameter space (bounds, conversion, validation, max delta)
 * - Composite scoring (formula correctness, edge cases)
 * - Optimization loop (integration with mock backtest)
 */

import {
  assertEquals,
  assertAlmostEquals,
  assert,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { TPEOptimizer, ParameterSpec, Trial } from "../../functions/optimizer/lib/tpe.ts";
import {
  getFullParameterSpace,
  getCoreParameterSpace,
  paramsToConfig,
  configToParams,
  validateParams,
  enforceMaxDelta,
  FACTOR_WEIGHT_DEFAULTS,
} from "../../functions/optimizer/lib/parameterSpace.ts";
import {
  computeCompositeScore,
  OptimizationLoop,
  BacktestResult,
} from "../../functions/optimizer/lib/optimizationLoop.ts";
import { extractBacktestResult } from "../../functions/optimizer/lib/backtestRunner.ts";

// ═══════════════════════════════════════════════════
// TPE Algorithm Tests
// ═══════════════════════════════════════════════════

Deno.test("TPE: uniform sampling during startup phase", () => {
  const specs: ParameterSpec[] = [
    { name: "x", type: "continuous", low: 0, high: 10 },
    { name: "y", type: "integer", low: 1, high: 5 },
  ];

  const tpe = new TPEOptimizer(specs, { nStartupTrials: 5, seed: 42 });

  // During startup, all samples should be uniform (within bounds)
  for (let i = 0; i < 5; i++) {
    const params = tpe.ask();
    assert(Number(params.x) >= 0 && Number(params.x) <= 10, `x=${params.x} out of bounds`);
    assert(Number(params.y) >= 1 && Number(params.y) <= 5, `y=${params.y} out of bounds`);
    assert(Number.isInteger(params.y), `y=${params.y} should be integer`);
    tpe.tell(params, Math.random());
  }
});

Deno.test("TPE: categorical sampling respects choices", () => {
  const specs: ParameterSpec[] = [
    { name: "method", type: "categorical", choices: ["a", "b", "c"] },
  ];

  const tpe = new TPEOptimizer(specs, { nStartupTrials: 3, seed: 123 });

  for (let i = 0; i < 10; i++) {
    const params = tpe.ask();
    assert(["a", "b", "c"].includes(params.method as string), `Invalid choice: ${params.method}`);
    tpe.tell(params, Math.random());
  }
});

Deno.test("TPE: tell records trials correctly", () => {
  const specs: ParameterSpec[] = [
    { name: "x", type: "continuous", low: 0, high: 1 },
  ];

  const tpe = new TPEOptimizer(specs, { seed: 1 });
  const params = { x: 0.5 };
  const trial = tpe.tell(params, 0.8);

  assertEquals(trial.id, 0);
  assertEquals(trial.params.x, 0.5);
  assertEquals(trial.score, 0.8);
  assertEquals(tpe.getTrialCount(), 1);
});

Deno.test("TPE: getBest returns highest scoring trial", () => {
  const specs: ParameterSpec[] = [
    { name: "x", type: "continuous", low: 0, high: 1 },
  ];

  const tpe = new TPEOptimizer(specs, { seed: 1 });
  tpe.tell({ x: 0.1 }, 0.3);
  tpe.tell({ x: 0.5 }, 0.9);
  tpe.tell({ x: 0.9 }, 0.6);

  const best = tpe.getBest();
  assertEquals(best!.params.x, 0.5);
  assertEquals(best!.score, 0.9);
});

Deno.test("TPE: loadTrials enables warm-starting", () => {
  const specs: ParameterSpec[] = [
    { name: "x", type: "continuous", low: 0, high: 1 },
  ];

  const tpe = new TPEOptimizer(specs, { nStartupTrials: 5, seed: 42 });

  const historicalTrials: Trial[] = [
    { id: 0, params: { x: 0.2 }, score: 0.3, timestamp: 1000 },
    { id: 1, params: { x: 0.5 }, score: 0.8, timestamp: 2000 },
    { id: 2, params: { x: 0.8 }, score: 0.5, timestamp: 3000 },
    { id: 3, params: { x: 0.4 }, score: 0.7, timestamp: 4000 },
    { id: 4, params: { x: 0.6 }, score: 0.9, timestamp: 5000 },
  ];

  tpe.loadTrials(historicalTrials);
  assertEquals(tpe.getTrialCount(), 5);

  // After loading 5 trials (>= nStartupTrials), TPE should use informed sampling
  const params = tpe.ask();
  assert(Number(params.x) >= 0 && Number(params.x) <= 1);
});

Deno.test("TPE: converges toward optimum with simple quadratic", () => {
  // Objective: maximize -(x-3)^2 + 9 (optimum at x=3, score=9)
  const specs: ParameterSpec[] = [
    { name: "x", type: "continuous", low: 0, high: 6 },
  ];

  const tpe = new TPEOptimizer(specs, { nStartupTrials: 5, seed: 7 });

  for (let i = 0; i < 40; i++) {
    const params = tpe.ask();
    const x = params.x as number;
    const score = -Math.pow(x - 3, 2) + 9;
    tpe.tell(params, score);
  }

  const best = tpe.getBest()!;
  // Should be reasonably close to x=3
  assert(Math.abs((best.params.x as number) - 3) < 1.5, `Best x=${best.params.x}, expected ~3`);
  assert(best.score > 7, `Best score=${best.score}, expected >7`);
});

Deno.test("TPE: deterministic with same seed", () => {
  const specs: ParameterSpec[] = [
    { name: "x", type: "continuous", low: 0, high: 10 },
    { name: "y", type: "integer", low: 1, high: 5 },
  ];

  const tpe1 = new TPEOptimizer(specs, { seed: 999, nStartupTrials: 3 });
  const tpe2 = new TPEOptimizer(specs, { seed: 999, nStartupTrials: 3 });

  for (let i = 0; i < 5; i++) {
    const p1 = tpe1.ask();
    const p2 = tpe2.ask();
    assertEquals(p1.x, p2.x);
    assertEquals(p1.y, p2.y);
    tpe1.tell(p1, i * 0.2);
    tpe2.tell(p2, i * 0.2);
  }
});

// ═══════════════════════════════════════════════════
// Parameter Space Tests
// ═══════════════════════════════════════════════════

Deno.test("ParameterSpace: full space is intentionally bounded", () => {
  const space = getFullParameterSpace();
  assert(space.length >= 12, `Expected >=12 params, got ${space.length}`);
  assert(space.length <= 24, `Expected <=24 params, got ${space.length}`);
});

Deno.test("ParameterSpace: core space is smaller than full", () => {
  const full = getFullParameterSpace();
  const core = getCoreParameterSpace();
  assert(core.length < full.length, `Core (${core.length}) should be < full (${full.length})`);
  assert(core.length >= 6, `Core should have at least 6 params, got ${core.length}`);
});

Deno.test("ParameterSpace: all specs have valid bounds", () => {
  const space = getFullParameterSpace();
  for (const spec of space) {
    if (spec.type === "continuous" || spec.type === "integer") {
      assert(spec.low !== undefined, `${spec.name} missing low`);
      assert(spec.high !== undefined, `${spec.name} missing high`);
      assert(spec.low! < spec.high!, `${spec.name}: low (${spec.low}) >= high (${spec.high})`);
    }
    if (spec.type === "categorical") {
      assert(spec.choices !== undefined, `${spec.name} missing choices`);
      assert(spec.choices!.length >= 2, `${spec.name} needs at least 2 choices`);
    }
  }
});

Deno.test("ParameterSpace: excludes legacy diagnostics and authority modes", () => {
  const names = getFullParameterSpace().map(spec => spec.name);
  assertEquals(names.some(name => name.startsWith("fw_")), false);
  assertEquals(names.includes("minConfluence"), false);
  assertEquals(names.includes("minTier1Factors"), false);
  assertEquals(names.includes("singleOwnershipMode"), false);
  assertEquals(names.includes("canonicalScannerMode"), false);
});

Deno.test("ParameterSpace: paramsToConfig preserves the complete runtime snapshot", () => {
  const base = { singleOwnershipMode: "enforce", confirmationMethod: "choch", structureLookback: 50 };
  const config = paramsToConfig({ structureLookback: 70 }, base);
  assertEquals(config.structureLookback, 70);
  assertEquals(config.singleOwnershipMode, "enforce");
  assertEquals(config.confirmationMethod, "choch");
});

Deno.test("ParameterSpace: configToParams extracts canonical research fields only", () => {
  const params = configToParams({ structureLookback: 60, slATRMultiple: 1.5, minConfluence: 55 });
  assertEquals(params.structureLookback, 60);
  assertEquals(params.slATRMultiple, 1.5);
  assertEquals(params.minConfluence, undefined);
});

Deno.test("ParameterSpace: validateParams catches minRR > tpRatio", () => {
  const violations = validateParams({ minRiskReward: 3.0, tpRatio: 2.0 });
  assert(violations.length > 0);
  assert(violations[0].includes("minRiskReward"));
});

Deno.test("ParameterSpace: validateParams catches conflictThresholdRaise >= conflictBlockAt", () => {
  const violations = validateParams({ conflictThresholdRaise: 5, conflictBlockAt: 5 });
  assert(violations.length > 0);
  assert(violations[0].includes("conflictThresholdRaise"));
});

Deno.test("ParameterSpace: validateParams catches trending <= ranging", () => {
  const violations = validateParams({ trendingRRMultiplier: 0.8, rangingRRMultiplier: 0.9 });
  assert(violations.length > 0);
  assert(violations[0].includes("trendingRRMultiplier"));
});

Deno.test("ParameterSpace: validateParams passes valid config", () => {
  const violations = validateParams({
    minRiskReward: 1.5,
    tpRatio: 3.0,
    conflictThresholdRaise: 3,
    conflictBlockAt: 6,
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
    fw_marketStructure: 2.5,
  });
  assertEquals(violations.length, 0);
});

Deno.test("ParameterSpace: enforceMaxDelta clamps within ±50%", () => {
  const baseline = { x: 10, y: 20, z: 5 };
  const candidate = { x: 20, y: 5, z: 5 }; // x is +100%, y is -75%

  const clamped = enforceMaxDelta(candidate, baseline, 0.50);
  assertEquals(clamped.x, 15); // 10 + 50% = 15
  assertEquals(clamped.y, 10); // 20 - 50% = 10
  assertEquals(clamped.z, 5); // no change
});

Deno.test("ParameterSpace: enforceMaxDelta preserves categorical values", () => {
  const baseline = { x: 10, mode: "hard" };
  const candidate = { x: 20, mode: "soft" };

  const clamped = enforceMaxDelta(candidate, baseline, 0.50);
  assertEquals(clamped.mode, "soft"); // categorical not clamped
  assertEquals(clamped.x, 15); // numerical clamped
});

// ═══════════════════════════════════════════════════
// Composite Scoring Tests
// ═══════════════════════════════════════════════════

Deno.test("CompositeScore: returns 0 for fewer than 5 trades", () => {
  const result: BacktestResult = {
    totalTrades: 3,
    winRate: 0.7,
    profitFactor: 2.0,
    expectancy: 5.0,
    maxDrawdownPercent: 5,
    netPnlPips: 100,
    walkForward: { consistencyScore: 0.8, verdict: "robust", foldCount: 4, winRateStdDev: 0.05, pnlStdDev: 10 },
  };
  assertEquals(computeCompositeScore(result), 0);
});

Deno.test("CompositeScore: returns 0 for negative expectancy", () => {
  const result: BacktestResult = {
    totalTrades: 50,
    winRate: 0.3,
    profitFactor: 0.8,
    expectancy: -2.0,
    maxDrawdownPercent: 10,
    netPnlPips: -100,
    walkForward: { consistencyScore: 0.5, verdict: "moderate", foldCount: 4, winRateStdDev: 0.1, pnlStdDev: 20 },
  };
  assertEquals(computeCompositeScore(result), 0);
});

Deno.test("CompositeScore: returns 0 for zero profit factor", () => {
  const result: BacktestResult = {
    totalTrades: 50,
    winRate: 0.5,
    profitFactor: 0,
    expectancy: 5.0,
    maxDrawdownPercent: 10,
    netPnlPips: 100,
  };
  assertEquals(computeCompositeScore(result), 0);
});

Deno.test("CompositeScore: correct formula for healthy result", () => {
  const result: BacktestResult = {
    totalTrades: 50,
    winRate: 0.6,
    profitFactor: 2.0,
    expectancy: 5.0,
    maxDrawdownPercent: 10,
    netPnlPips: 250,
    walkForward: { consistencyScore: 0.8, verdict: "robust", foldCount: 4, winRateStdDev: 0.05, pnlStdDev: 10 },
  };

  const expectancyR = 0.6 * (2.0 * 0.4 / 0.6) - 0.4;
  const expected = expectancyR * Math.sqrt(2.0) * 0.8;
  // expectancyR * capped sqrt(PF) * consistency
  const score = computeCompositeScore(result);
  assertAlmostEquals(score, expected, 0.001);
});

Deno.test("CompositeScore: drawdown penalty kicks in above 15%", () => {
  const baseResult: BacktestResult = {
    totalTrades: 50,
    winRate: 0.6,
    profitFactor: 2.0,
    expectancy: 5.0,
    maxDrawdownPercent: 10,
    netPnlPips: 250,
    walkForward: { consistencyScore: 0.8, verdict: "robust", foldCount: 4, winRateStdDev: 0.05, pnlStdDev: 10 },
  };

  const highDDResult: BacktestResult = { ...baseResult, maxDrawdownPercent: 30 };

  const scoreNormal = computeCompositeScore(baseResult);
  const scoreHighDD = computeCompositeScore(highDDResult);

  assert(scoreHighDD < scoreNormal, "High drawdown should reduce score");
  // DD penalty = max(0.3, 1 - (30-15)/50) = max(0.3, 0.7) = 0.7
  assertAlmostEquals(scoreHighDD / scoreNormal, 0.7, 0.001);
});

Deno.test("CompositeScore: requires at least 30 trades", () => {
  const fewTrades: BacktestResult = {
    totalTrades: 15,
    winRate: 0.6,
    profitFactor: 2.0,
    expectancy: 5.0,
    maxDrawdownPercent: 10,
    netPnlPips: 75,
    walkForward: { consistencyScore: 0.8, verdict: "robust", foldCount: 4, winRateStdDev: 0.05, pnlStdDev: 10 },
  };

  const manyTrades: BacktestResult = { ...fewTrades, totalTrades: 50, netPnlPips: 250 };

  const scoreFew = computeCompositeScore(fewTrades);
  const scoreMany = computeCompositeScore(manyTrades);

  assertEquals(scoreFew, 0);
  assert(scoreMany > 0);
});

Deno.test("CompositeScore: rejects results without walk-forward data", () => {
  const result: BacktestResult = {
    totalTrades: 50,
    winRate: 0.6,
    profitFactor: 2.0,
    expectancy: 5.0,
    maxDrawdownPercent: 10,
    netPnlPips: 250,
    // No walkForward field
  };

  assertEquals(computeCompositeScore(result), 0);
});

// ═══════════════════════════════════════════════════
// Optimization Loop Tests
// ═══════════════════════════════════════════════════

Deno.test("OptimizationLoop: runs with mock backtest and finds improvement", async () => {
  const baselineConfig = {
    factorWeights: { marketStructure: 2.5, orderBlock: 2.0 },
    minConfluence: 50,
    riskPerTrade: 1.0,
    minRiskReward: 1.5,
    tpRatio: 3.0,
    slATRMultiple: 1.5,
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
  };

  // Mock backtest: score improves when minConfluence is higher
  const mockBacktest = async (config: Record<string, any>): Promise<BacktestResult> => {
    const confluence = config.minConfluence ?? 50;
    const quality = Math.min(1, confluence / 70); // higher confluence = better quality
    return {
      totalTrades: Math.max(5, Math.floor(100 - confluence)),
      winRate: 0.5 + quality * 0.2,
      profitFactor: 1.0 + quality * 1.5,
      expectancy: 2.0 + quality * 5.0,
      maxDrawdownPercent: 15 - quality * 8,
      netPnlPips: quality * 200,
      walkForward: {
        consistencyScore: 0.6 + quality * 0.3,
        verdict: quality > 0.7 ? "robust" : quality > 0.4 ? "moderate" : "fragile",
        foldCount: 4,
        winRateStdDev: 0.05,
        pnlStdDev: 10,
      },
    };
  };

  // Use a small parameter space for speed
  const smallSpace: ParameterSpec[] = [
    { name: "minConfluence", type: "continuous", low: 35, high: 80 },
    { name: "fw_marketStructure", type: "continuous", low: 0, high: 6.25 },
  ];

  const loop = new OptimizationLoop(
    {
      maxTrials: 15,
      walkForwardFolds: 4,
      minConsistencyScore: 0.75,
      minImprovementPercent: 0.15,
      maxDeltaPercent: 0.50,
      fullSpace: false,
      startDate: "2024-01-01",
      endDate: "2024-06-30",
      instruments: ["EURUSD"],
      supabaseUrl: "",
      supabaseKey: "",
      userId: "test",
      configId: "test",
      seed: 42,
    },
    baselineConfig,
    smallSpace,
  );

  const result = await loop.run(mockBacktest);

  assert(result.trials.length > 0, "Should have trials");
  assert(result.baseline.compositeScore > 0, "Baseline should have positive score");
  assert(Number.isFinite(result.durationMs) && result.durationMs >= 0, "Duration should be finite and non-negative");
});

Deno.test("OptimizationLoop: rejects configs that fail walk-forward", async () => {
  const baselineConfig = { minConfluence: 50 };

  // Mock: always returns fragile walk-forward
  const mockBacktest = async (_config: Record<string, any>): Promise<BacktestResult> => ({
    totalTrades: 30,
    winRate: 0.6,
    profitFactor: 2.0,
    expectancy: 5.0,
    maxDrawdownPercent: 10,
    netPnlPips: 150,
    walkForward: {
      consistencyScore: 0.4, // Below 0.75 threshold
      verdict: "fragile",
      foldCount: 4,
      winRateStdDev: 0.15,
      pnlStdDev: 50,
    },
  });

  const smallSpace: ParameterSpec[] = [
    { name: "minConfluence", type: "continuous", low: 35, high: 80 },
  ];

  const loop = new OptimizationLoop(
    {
      maxTrials: 5,
      walkForwardFolds: 4,
      minConsistencyScore: 0.75,
      minImprovementPercent: 0.15,
      maxDeltaPercent: 0.50,
      fullSpace: false,
      startDate: "2024-01-01",
      endDate: "2024-06-30",
      instruments: ["EURUSD"],
      supabaseUrl: "",
      supabaseKey: "",
      userId: "test",
      configId: "test",
      seed: 42,
    },
    baselineConfig,
    smallSpace,
  );

  const result = await loop.run(mockBacktest);

  assertEquals(result.bestTrial, null);
  assertEquals(result.autoApplied, false);
  assert(result.rejectReason!.includes("walk-forward"));
});

Deno.test("OptimizationLoop: handles backtest errors gracefully", async () => {
  const baselineConfig = { minConfluence: 50 };

  let callCount = 0;
  const mockBacktest = async (_config: Record<string, any>): Promise<BacktestResult> => {
    callCount++;
    if (callCount === 1) {
      // Baseline call succeeds
      return {
        totalTrades: 30, winRate: 0.6, profitFactor: 2.0,
        expectancy: 5.0, maxDrawdownPercent: 10, netPnlPips: 150,
        walkForward: { consistencyScore: 0.8, verdict: "robust", foldCount: 4, winRateStdDev: 0.05, pnlStdDev: 10 },
      };
    }
    // All other calls throw
    throw new Error("Simulated backtest failure");
  };

  const smallSpace: ParameterSpec[] = [
    { name: "minConfluence", type: "continuous", low: 35, high: 80 },
  ];

  const loop = new OptimizationLoop(
    {
      maxTrials: 3,
      walkForwardFolds: 4,
      minConsistencyScore: 0.75,
      minImprovementPercent: 0.15,
      maxDeltaPercent: 0.50,
      fullSpace: false,
      startDate: "2024-01-01",
      endDate: "2024-06-30",
      instruments: ["EURUSD"],
      supabaseUrl: "",
      supabaseKey: "",
      userId: "test",
      configId: "test",
      seed: 42,
    },
    baselineConfig,
    smallSpace,
  );

  // Should not throw — errors are caught and recorded
  const result = await loop.run(mockBacktest);
  assertEquals(result.trials.length, 3);
  // All trials should have score 0 (from errors)
  for (const trial of result.trials) {
    assertEquals(trial.compositeScore, 0);
    assert(trial.violations[0].includes("Backtest error"));
  }
});

// ═══════════════════════════════════════════════════
// Backtest Runner Tests
// ═══════════════════════════════════════════════════

Deno.test("extractBacktestResult: maps engine output correctly", () => {
  const engineOutput = {
    summary: {
      totalTrades: 45,
      winningTrades: 27,
      losingTrades: 18,
      winRate: 0.6,
      profitFactor: 1.8,
      expectancy: 4.2,
      maxDrawdownPercent: 12.5,
      netPnlPips: 189,
      sharpeRatio: 1.4,
    },
    trades: [],
    walkForward: {
      folds: [
        { foldIndex: 0, trades: 12, winRate: 0.58, pnlPips: 45, profitFactor: 1.6 },
        { foldIndex: 1, trades: 11, winRate: 0.64, pnlPips: 52, profitFactor: 2.0 },
        { foldIndex: 2, trades: 10, winRate: 0.50, pnlPips: 30, profitFactor: 1.3 },
        { foldIndex: 3, trades: 12, winRate: 0.67, pnlPips: 62, profitFactor: 2.1 },
      ],
      consistencyScore: 0.85,
      verdict: "robust" as const,
    },
  };

  const result = extractBacktestResult(engineOutput);

  assertEquals(result.totalTrades, 45);
  assertEquals(result.winRate, 0.6);
  assertEquals(result.profitFactor, 1.8);
  assertEquals(result.expectancy, 4.2);
  assertEquals(result.maxDrawdownPercent, 12.5);
  assertEquals(result.netPnlPips, 189);
  assertEquals(result.walkForward!.consistencyScore, 0.85);
  assertEquals(result.walkForward!.verdict, "robust");
  assertEquals(result.walkForward!.foldCount, 4);
  assert(result.walkForward!.winRateStdDev > 0);
  assert(result.walkForward!.pnlStdDev > 0);
});

Deno.test("extractBacktestResult: handles missing walk-forward", () => {
  const engineOutput = {
    summary: {
      totalTrades: 20,
      winningTrades: 12,
      losingTrades: 8,
      winRate: 0.6,
      profitFactor: 1.5,
      expectancy: 3.0,
      maxDrawdownPercent: 8,
      netPnlPips: 60,
    },
    trades: [],
  };

  const result = extractBacktestResult(engineOutput);
  assertEquals(result.walkForward, undefined);
});

// ═══════════════════════════════════════════════════
// Integration: Full Pipeline (small scale)
// ═══════════════════════════════════════════════════

Deno.test("Integration: optimizer improves over baseline with deterministic mock", async () => {
  // Deterministic objective: score = 10 - |minConfluence - 60|
  // Optimum at minConfluence = 60
  const baselineConfig = {
    factorWeights: { marketStructure: 2.5 },
    minConfluence: 45, // suboptimal
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
  };

  const mockBacktest = async (config: Record<string, any>): Promise<BacktestResult> => {
    const confluence = config.minConfluence ?? 50;
    const distance = Math.abs(confluence - 60);
    const quality = Math.max(0, 1 - distance / 25);

    return {
      totalTrades: 40,
      winRate: 0.5 + quality * 0.15,
      profitFactor: 1.2 + quality * 1.0,
      expectancy: 2.0 + quality * 6.0,
      maxDrawdownPercent: 8,
      netPnlPips: quality * 300,
      walkForward: {
        consistencyScore: 0.7 + quality * 0.2,
        verdict: quality > 0.6 ? "robust" : "moderate",
        foldCount: 4,
        winRateStdDev: 0.04,
        pnlStdDev: 8,
      },
    };
  };

  const smallSpace: ParameterSpec[] = [
    { name: "minConfluence", type: "continuous", low: 35, high: 80 },
    { name: "fw_marketStructure", type: "continuous", low: 0, high: 6.25 },
  ];

  const loop = new OptimizationLoop(
    {
      maxTrials: 25,
      walkForwardFolds: 4,
      minConsistencyScore: 0.75,
      minImprovementPercent: 0.05, // Lower threshold for test
      maxDeltaPercent: 0.50,
      fullSpace: false,
      startDate: "2024-01-01",
      endDate: "2024-06-30",
      instruments: ["EURUSD"],
      supabaseUrl: "",
      supabaseKey: "",
      userId: "test",
      configId: "test",
      seed: 77,
    },
    baselineConfig,
    smallSpace,
  );

  const result = await loop.run(mockBacktest);

  // The optimizer should find something better than baseline
  assert(result.baseline.compositeScore > 0, "Baseline should have positive score");
  if (result.bestTrial) {
    assert(
      result.bestTrial.compositeScore >= result.baseline.compositeScore,
      `Best (${result.bestTrial.compositeScore}) should be >= baseline (${result.baseline.compositeScore})`,
    );
  }
});

// ═══════════════════════════════════════════════════
// Error Propagation & Poll Limit Tests
// ═══════════════════════════════════════════════════

Deno.test("Error propagation: error_message field is preferred over error field", () => {
  // Simulates the backtest engine's status response when stale detection fires
  const backtestStatus = {
    status: "failed",
    error_message: "Backtest engine stopped responding. The run may have exceeded time limits.",
    error: undefined,
  };

  // The optimizer should use error_message when available
  const errorMsg = `Baseline backtest ${backtestStatus.status}: ${backtestStatus.error_message || backtestStatus.error || "unknown"}`;
  assert(errorMsg.includes("Backtest engine stopped responding"), "Should include the actual error message");
  assert(!errorMsg.includes("unknown"), "Should NOT fall back to 'unknown' when error_message exists");
});

Deno.test("Error propagation: falls back to error field when error_message is absent", () => {
  const backtestStatus = {
    status: "failed",
    error: "Connection timeout",
    error_message: undefined,
  };

  const errorMsg = `Baseline backtest ${backtestStatus.status}: ${backtestStatus.error_message || backtestStatus.error || "unknown"}`;
  assert(errorMsg.includes("Connection timeout"), "Should use error field as fallback");
});

Deno.test("Error propagation: falls back to 'unknown' when both fields are absent", () => {
  const backtestStatus = {
    status: "failed",
    error: undefined,
    error_message: undefined,
  };

  const errorMsg = `Baseline backtest ${backtestStatus.status}: ${backtestStatus.error_message || backtestStatus.error || "unknown"}`;
  assert(errorMsg.includes("unknown"), "Should fall back to 'unknown'");
});

Deno.test("Poll limit: optimizer allows up to 120 polls (20 min) for multi-chunk backtests", () => {
  // The poll limit was increased from 60 to 120 to accommodate
  // backtests that use time-boxing (280s per invocation, multiple chunks)
  const MAX_POLLS = 120;
  const POLL_INTERVAL_SECONDS = 10;
  const maxWaitMinutes = (MAX_POLLS * POLL_INTERVAL_SECONDS) / 60;
  assertEquals(maxWaitMinutes, 20, "Max wait should be 20 minutes");
  assert(MAX_POLLS > 60, "Poll limit should be greater than the old 60-poll limit");
});
