/**
 * Backtest Runner — Bridge between the optimizer and the backtest engine.
 * 
 * This module calls the backtest-engine Supabase Edge Function via HTTP:
 * 1. POST action=start → creates a run
 * 2. Poll action=status until completed/failed
 * 3. Extracts BacktestResult from the engine's response
 * 
 * The HTTP approach works with the existing chunked/warmup architecture
 * without requiring any refactoring of the backtest engine itself.
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

export interface RunnerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  /** Max time to wait for a single backtest run (ms). Default: 600_000 (10 min) */
  timeoutMs?: number;
  /** Poll interval (ms). Default: 5_000 (5 seconds) */
  pollIntervalMs?: number;
  /** If true, log progress to console */
  verbose?: boolean;
}

// ─── HTTP-Based Runner ───

/**
 * Create a backtest runner that calls the backtest-engine edge function via HTTP.
 * 
 * Each call:
 * 1. POSTs to start a new backtest run
 * 2. Polls until the run completes or fails
 * 3. Returns the normalized BacktestResult
 * 
 * This is the production integration path — no engine refactoring needed.
 */
export function createHTTPBacktestRunner(
  runnerConfig: RunnerConfig,
  baseInput: Omit<BacktestEngineInput, "config">,
): (config: Record<string, any>) => Promise<BacktestResult> {
  const {
    supabaseUrl,
    supabaseKey,
    timeoutMs = 600_000,
    pollIntervalMs = 5_000,
    verbose = false,
  } = runnerConfig;

  const engineUrl = `${supabaseUrl}/functions/v1/backtest-engine`;

  return async (config: Record<string, any>): Promise<BacktestResult> => {
    // Step 1: Start the backtest run
    // Normalize instrument codes to slashed format expected by backtest-engine
    // (e.g., "EURUSD" → "EUR/USD", "XAUUSD" → "XAU/USD", "BTCUSD" → "BTC/USD")
    const normalizeSymbol = (s: string): string => {
      if (s.includes("/")) return s;
      if (s.length === 6) return `${s.slice(0, 3)}/${s.slice(3)}`;
      return s;
    };
    const normalizedInstruments = (baseInput.instruments ?? []).map(normalizeSymbol);

    const startPayload = {
      action: "start",
      userId: baseInput.userId,  // Required for service-role-key auth (server-to-server)
      instruments: normalizedInstruments,
      startDate: baseInput.startDate,
      endDate: baseInput.endDate,
      startingBalance: 10000,
      config,
      walkForwardFolds: config.walkForwardFolds ?? baseInput.walkForwardFolds ?? 0,
    };

    const startResponse = await fetch(engineUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(startPayload),
    });

    if (!startResponse.ok) {
      const errText = await startResponse.text().catch(() => "");
      throw new Error(`Backtest start failed (${startResponse.status}): ${errText}`);
    }

    const startData = await startResponse.json();
    const runId = startData.runId;

    if (!runId) {
      throw new Error(`Backtest start returned no runId: ${JSON.stringify(startData)}`);
    }

    if (verbose) {
      console.log(`    [runner] Started run ${runId}`);
    }

    // Step 2: Poll for completion
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);

      const statusResponse = await fetch(engineUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ action: "status", runId }),
      });

      if (!statusResponse.ok) {
        // Transient error — retry
        if (verbose) console.log(`    [runner] Status poll error (${statusResponse.status}), retrying...`);
        continue;
      }

      const statusData = await statusResponse.json();

      if (statusData.status === "completed") {
        if (verbose) {
          console.log(`    [runner] Run ${runId} completed`);
        }
        return extractBacktestResult(statusData.results);
      }

      if (statusData.status === "failed" || statusData.status === "cancelled") {
        throw new Error(`Backtest run ${runId} ${statusData.status}: ${statusData.error_message || "unknown error"}`);
      }

      // Still running — continue polling
      if (verbose && statusData.progress_message) {
        console.log(`    [runner] ${statusData.progress}% — ${statusData.progress_message}`);
      }
    }

    throw new Error(`Backtest run ${runId} timed out after ${timeoutMs / 1000}s`);
  };
}

/**
 * Legacy createBacktestRunner — accepts a direct function for testing/mocking.
 * Used by the test suite and for local in-process execution.
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

// ─── Result Extraction ───

/**
 * Extract a normalized BacktestResult from the engine's raw output.
 * Handles both the direct BacktestEngineOutput shape and the
 * backtest_runs.results JSONB shape (which wraps in a summary object).
 */
export function extractBacktestResult(output: any): BacktestResult {
  if (!output) {
    throw new Error("Backtest returned null/undefined results");
  }

  // The backtest_runs.results JSONB has the summary at the top level
  // or nested under a `summary` key depending on the engine version.
  const summary = output.summary || output;

  const result: BacktestResult = {
    totalTrades: summary.totalTrades ?? 0,
    winRate: summary.winRate ?? 0,
    profitFactor: summary.profitFactor ?? 0,
    expectancy: summary.expectancy ?? 0,
    maxDrawdownPercent: summary.maxDrawdownPercent ?? summary.maxDrawdownPct ?? 0,
    netPnlPips: summary.netPnlPips ?? summary.totalPnlPips ?? 0,
    avgRR: summary.avgRR ?? 0,
  };

  // Walk-forward data may be at output.walkForward or output.walkForwardResults
  const walkForward = output.walkForward || output.walkForwardResults;
  if (walkForward && walkForward.folds) {
    const foldWinRates = walkForward.folds.map((f: any) => f.winRate ?? 0);
    const foldPnls = walkForward.folds.map((f: any) => f.pnlPips ?? 0);

    result.walkForward = {
      consistencyScore: walkForward.consistencyScore ?? 0,
      verdict: walkForward.verdict ?? "fragile",
      foldCount: walkForward.folds.length,
      winRateStdDev: computeStdDev(foldWinRates),
      pnlStdDev: computeStdDev(foldPnls),
    };
  }

  return result;
}

// ─── Supabase Data Helpers ───

/**
 * Fetch the current paper trading config from Supabase.
 * Returns the full row including config_json.
 */
export async function fetchCurrentConfig(
  supabaseUrl: string,
  supabaseKey: string,
  userId: string,
): Promise<Record<string, any>> {
  const url = `${supabaseUrl}/rest/v1/bot_configs?user_id=eq.${userId}&select=*&limit=1`;

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
    throw new Error(`No bot config found for user ${userId}`);
  }

  return data[0];
}

/**
 * Fetch the user's Telegram chat IDs from user_settings.
 * Returns the array of chat IDs, or empty array if not configured.
 */
export async function fetchTelegramChatIds(
  supabaseUrl: string,
  supabaseKey: string,
  userId: string,
): Promise<string[]> {
  const url = `${supabaseUrl}/rest/v1/user_settings?user_id=eq.${userId}&select=preferences_json&limit=1`;

  const response = await fetch(url, {
    headers: {
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
    },
  });

  if (!response.ok) return [];

  const data = await response.json();
  if (data.length === 0) return [];

  const prefs = data[0]?.preferences_json;
  if (!prefs) return [];

  // Support both array and single string formats
  if (Array.isArray(prefs.telegramChatIds) && prefs.telegramChatIds.length > 0) {
    return prefs.telegramChatIds;
  }
  if (prefs.telegramChatId) {
    return [prefs.telegramChatId];
  }

  return [];
}

// ─── Helpers ───

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
