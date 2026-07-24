/**
 * Optimization Loop — The core engine that:
 * 1. Samples candidate configs from TPE
 * 2. Runs backtest on each candidate
 * 3. Evaluates with composite scoring + walk-forward
 * 4. Updates TPE with results
 * 5. Applies best config if it passes safety rails
 * 
 * Designed to run locally via Deno, calling the backtest-engine directly.
 */

import { TPEOptimizer, Trial, TPEConfig } from "./tpe.ts";
import {
  getFullParameterSpace,
  paramsToConfig,
  configToParams,
  validateParams,
  enforceMaxDelta,
} from "./parameterSpace.ts";
import type { ParameterSpec } from "./tpe.ts";

// ─── Types ───

export interface OptimizationConfig {
  /** Maximum number of trials per optimization run */
  maxTrials: number;
  /** Walk-forward folds for validation */
  walkForwardFolds: number;
  /** Minimum consistency score to accept (0-1, default 0.75 = "robust") */
  minConsistencyScore: number;
  /** Minimum improvement over baseline to auto-apply (default 0.15 = 15%) */
  minImprovementPercent: number;
  /** Maximum parameter change per cycle (default 0.50 = ±50%) */
  maxDeltaPercent: number;
  /** TPE configuration overrides */
  tpeConfig?: Partial<TPEConfig>;
  /** Use full parameter space (true) or core only (false) */
  fullSpace: boolean;
  /** Backtest date range */
  startDate: string; // ISO date
  endDate: string;   // ISO date
  /** Instruments to test */
  instruments: string[];
  /** Supabase URL and key for data fetching */
  supabaseUrl: string;
  supabaseKey: string;
  /** User ID for config lookup */
  userId: string;
  /** Target config ID (paper trading) */
  configId: string;
  /** Telegram bot token + chat ID for notifications */
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Path to persist trial history */
  historyPath?: string;
  /** Seed for reproducibility */
  seed?: number;
}

export interface BacktestResult {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPercent: number;
  netPnlPips: number;
  walkForward?: {
    consistencyScore: number;
    verdict: "robust" | "moderate" | "fragile";
    foldCount: number;
    winRateStdDev: number;
    pnlStdDev: number;
  };
}

export interface TrialResult {
  trial: Trial;
  backtest: BacktestResult;
  compositeScore: number;
  violations: string[];
  walkForwardPassed: boolean;
}

export interface OptimizationResult {
  /** All trials run */
  trials: TrialResult[];
  /** Best trial that passed all gates */
  bestTrial: TrialResult | null;
  /** Baseline (current config) performance */
  baseline: TrialResult;
  /** Whether auto-apply was triggered */
  autoApplied: boolean;
  /** Improvement percentage over baseline */
  improvementPercent: number;
  /** Total time taken (ms) */
  durationMs: number;
  /** Reason if not auto-applied */
  rejectReason?: string;
}

// ─── Composite Scoring ───

/**
 * Compute composite score: Expectancy * sqrt(ProfitFactor) * ConsistencyScore
 * 
 * This balances:
 * - Expectancy: avg value per trade (must be positive)
 * - sqrt(ProfitFactor): rewards edge without over-weighting outlier wins
 * - ConsistencyScore: penalizes curve-fitted configs
 * - drawdownPenalty: penalizes configs with >15% max drawdown
 * - tradeCountBonus: penalizes configs with too few trades (<30)
 */
export function computeCompositeScore(result: BacktestResult): number {
  // Guard: if no trades or negative expectancy, score is 0
  if (result.totalTrades < 5 || result.expectancy <= 0) return 0;
  if (result.profitFactor <= 0) return 0;

  const expectancyComponent = result.expectancy;
  const pfComponent = Math.sqrt(result.profitFactor);
  const consistencyComponent = result.walkForward?.consistencyScore ?? 0.5;

  // Penalty for extreme drawdown
  const drawdownPenalty = result.maxDrawdownPercent > 15
    ? Math.max(0.3, 1 - (result.maxDrawdownPercent - 15) / 50)
    : 1.0;

  // Penalty for too few trades (less statistical significance)
  const tradeCountBonus = Math.min(1.0, result.totalTrades / 30);

  return expectancyComponent * pfComponent * consistencyComponent * drawdownPenalty * tradeCountBonus;
}

// ─── Optimization Loop ───

export class OptimizationLoop {
  private config: OptimizationConfig;
  private tpe: TPEOptimizer;
  private paramSpace: ParameterSpec[];
  private baselineParams: Record<string, number | string | boolean>;
  private results: TrialResult[] = [];

  constructor(
    config: OptimizationConfig,
    baselineConfig: Record<string, any>,
    paramSpace?: ParameterSpec[],
  ) {
    this.config = config;
    this.paramSpace = paramSpace ?? getFullParameterSpace();
    this.baselineParams = configToParams(baselineConfig);

    this.tpe = new TPEOptimizer(this.paramSpace, {
      ...config.tpeConfig,
      seed: config.seed,
      nStartupTrials: Math.min(10, Math.floor(config.maxTrials * 0.3)),
    });
  }

  /**
   * Run the full optimization loop.
   * 
   * @param runBacktest - Function that executes a backtest with given config
   * @param onProgress - Optional callback for progress updates
   */
  async run(
    runBacktest: (config: Record<string, any>) => Promise<BacktestResult>,
    onProgress?: (trial: number, total: number, best: number) => void,
  ): Promise<OptimizationResult> {
    const startTime = Date.now();

    // Step 1: Evaluate baseline
    const baselineConfig = paramsToConfig(this.baselineParams, {});
    baselineConfig.walkForwardFolds = this.config.walkForwardFolds;

    const baselineBacktest = await runBacktest(baselineConfig);
    const baselineScore = computeCompositeScore(baselineBacktest);
    const baselineTrial: TrialResult = {
      trial: { id: -1, params: this.baselineParams, score: baselineScore, timestamp: Date.now() },
      backtest: baselineBacktest,
      compositeScore: baselineScore,
      violations: [],
      walkForwardPassed: (baselineBacktest.walkForward?.consistencyScore ?? 0) >= this.config.minConsistencyScore,
    };

    // Warm-start TPE with baseline
    this.tpe.tell(this.baselineParams, baselineScore);

    // Step 2: Run trials
    let bestPassingTrial: TrialResult | null = null;

    for (let i = 0; i < this.config.maxTrials; i++) {
      // Sample candidate
      let candidateParams = this.tpe.ask();

      // Enforce max delta from baseline
      candidateParams = enforceMaxDelta(
        candidateParams,
        this.baselineParams,
        this.config.maxDeltaPercent,
      ) as Record<string, number | string | boolean>;

      // Validate constraints
      const violations = validateParams(candidateParams);
      if (violations.length > 0) {
        // Skip invalid candidates but still record them with score 0
        const trial = this.tpe.tell(candidateParams, 0);
        this.results.push({
          trial,
          backtest: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 },
          compositeScore: 0,
          violations,
          walkForwardPassed: false,
        });
        continue;
      }

      // Run backtest
      const config = paramsToConfig(candidateParams, {});
      config.walkForwardFolds = this.config.walkForwardFolds;
      config.startDate = this.config.startDate;
      config.endDate = this.config.endDate;
      config.instruments = this.config.instruments;

      let backtestResult: BacktestResult;
      try {
        backtestResult = await runBacktest(config);
      } catch (err) {
        // Backtest failed — record as zero score
        const trial = this.tpe.tell(candidateParams, 0);
        this.results.push({
          trial,
          backtest: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 },
          compositeScore: 0,
          violations: [`Backtest error: ${(err as Error).message}`],
          walkForwardPassed: false,
        });
        continue;
      }

      // Compute composite score
      const score = computeCompositeScore(backtestResult);
      const trial = this.tpe.tell(candidateParams, score);

      // Check walk-forward gate
      const wfPassed = (backtestResult.walkForward?.consistencyScore ?? 0) >= this.config.minConsistencyScore;

      const trialResult: TrialResult = {
        trial,
        backtest: backtestResult,
        compositeScore: score,
        violations: [],
        walkForwardPassed: wfPassed,
      };
      this.results.push(trialResult);

      // Track best passing trial
      if (wfPassed && score > (bestPassingTrial?.compositeScore ?? 0)) {
        bestPassingTrial = trialResult;
      }

      // Progress callback
      onProgress?.(i + 1, this.config.maxTrials, bestPassingTrial?.compositeScore ?? baselineScore);
    }

    // Step 3: Determine if auto-apply should fire
    let autoApplied = false;
    let improvementPercent = 0;
    let rejectReason: string | undefined;

    if (bestPassingTrial && baselineScore > 0) {
      improvementPercent = ((bestPassingTrial.compositeScore - baselineScore) / baselineScore) * 100;

      if (improvementPercent >= this.config.minImprovementPercent * 100) {
        autoApplied = true;
      } else {
        rejectReason = `Improvement ${improvementPercent.toFixed(1)}% < required ${(this.config.minImprovementPercent * 100).toFixed(0)}%`;
      }
    } else if (!bestPassingTrial) {
      rejectReason = "No trial passed walk-forward validation gate";
    } else {
      rejectReason = "Baseline score is zero — cannot compute improvement";
    }

    return {
      trials: this.results,
      bestTrial: bestPassingTrial,
      baseline: baselineTrial,
      autoApplied,
      improvementPercent,
      durationMs: Date.now() - startTime,
      rejectReason,
    };
  }

  /** Get the TPE instance for inspection/serialization */
  getTPE(): TPEOptimizer {
    return this.tpe;
  }

  /** Load historical trials for warm-starting */
  loadHistory(trials: Trial[]): void {
    this.tpe.loadTrials(trials);
  }
}
