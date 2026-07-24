/**
 * Backtest Runner — Bridge between the optimizer and the backtest engine.
 * 
 * This module:
 * 1. Converts optimizer config format → backtest engine input format
 * 2. Calls the backtest engine directly (in-process, no HTTP)
 * 3. Extracts BacktestResult from the engine's output
 * 4. Handles walk-forward fold data extraction
 * 
 * The backtest engine is imported directly to avoid network overhead
 * and to enable running hundreds of trials efficiently.
 */

import type { BacktestResult } from "./optimizationLoop.ts";

// ─── Types ───

export interface BacktestEngineInput {
  userId: string;
  configId: string;
  instruments: string[];
  startDate: string;
  endDate: string;
  walkForwardFolds?: number;
  config: Record<string, any>;
  /** Historical candle data (pre-fetched to avoid re-fetching per trial) */
  candleData?: Map<string, any[]>;
  /** Historical trade data for the user */
  tradeHistory?: any[];
}

export interface BacktestEngineOutput {
  summary: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    profitFactor: number;
    expectancy: number;
    maxDrawdownPercent: number;
    netPnlPips: number;
    sharpeRatio?: number;
  };
  trades: any[];
  walkForward?: {
    folds: Array<{
      foldIndex: number;
      trades: number;
      winRate: number;
      pnlPips: number;
      profitFactor: number;
    }>;
    consistencyScore: number;
    verdict: "robust" | "moderate" | "fragile";
  };
}

// ─── Runner ───

/**
 * Create a backtest runner function that the optimizer can call repeatedly.
 * 
 * Pre-fetches candle data once, then reuses it across all trials.
 * This is the key optimization — data fetching is O(1) not O(n_trials).
 */
export function createBacktestRunner(
  engineFn: (input: BacktestEngineInput) => Promise<BacktestEngineOutput>,
  baseInput: Omit<BacktestEngineInput, "config">,
): (config: Record<string, any>) => Promise<BacktestResult> {
  return async (config: Record<string, any>): Promise<BacktestResult> => {
    const input: BacktestEngineInput = {
      ...baseInput,
      config,
      walkForwardFolds: config.walkForwardFolds ?? baseInput.walkForwardFolds,
    };

    const output = await engineFn(input);
    return extractBacktestResult(output);
  };
}

/**
 * Extract a normalized BacktestResult from the engine's raw output.
 */
export function extractBacktestResult(output: BacktestEngineOutput): BacktestResult {
  const { summary, walkForward } = output;

  const result: BacktestResult = {
    totalTrades: summary.totalTrades,
    winRate: summary.winRate,
    profitFactor: summary.profitFactor,
    expectancy: summary.expectancy,
    maxDrawdownPercent: summary.maxDrawdownPercent,
    netPnlPips: summary.netPnlPips,
  };

  if (walkForward) {
    const foldWinRates = walkForward.folds.map(f => f.winRate);
    const foldPnls = walkForward.folds.map(f => f.pnlPips);

    result.walkForward = {
      consistencyScore: walkForward.consistencyScore,
      verdict: walkForward.verdict,
      foldCount: walkForward.folds.length,
      winRateStdDev: computeStdDev(foldWinRates),
      pnlStdDev: computeStdDev(foldPnls),
    };
  }

  return result;
}

/**
 * Pre-fetch all candle data needed for the optimization run.
 * Called once before the loop starts.
 */
export async function prefetchCandleData(
  supabaseUrl: string,
  supabaseKey: string,
  instruments: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, any[]>> {
  const candleData = new Map<string, any[]>();

  for (const instrument of instruments) {
    const url = `${supabaseUrl}/rest/v1/candles?instrument=eq.${instrument}&timestamp=gte.${startDate}&timestamp=lte.${endDate}&order=timestamp.asc`;

    const response = await fetch(url, {
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      candleData.set(instrument, data);
    } else {
      console.warn(`Failed to fetch candles for ${instrument}: ${response.status}`);
      candleData.set(instrument, []);
    }
  }

  return candleData;
}

/**
 * Fetch the current paper trading config from Supabase.
 */
export async function fetchCurrentConfig(
  supabaseUrl: string,
  supabaseKey: string,
  userId: string,
): Promise<Record<string, any>> {
  const url = `${supabaseUrl}/rest/v1/bot_configs?user_id=eq.${userId}&mode=eq.paper&select=*&limit=1`;

  const response = await fetch(url, {
    headers: {
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch config: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.length === 0) {
    throw new Error(`No paper trading config found for user ${userId}`);
  }

  return data[0];
}

// ─── Helpers ───

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
