/**
 * Local Optimizer Runner
 * 
 * Runs the full optimization loop locally — no edge function timeouts.
 * The backtest engine still runs on Supabase (it handles its own chunking),
 * but this script waits patiently (up to 30 min per backtest) instead of
 * being killed by the edge function wall-clock limit.
 * 
 * Usage:
 *   cd local-runner
 *   cp .env.local.example .env.local   # fill in your keys
 *   deno run --allow-all optimizer-local.ts
 * 
 * Optional flags:
 *   --trials=10          Override max trials (default: from config.json)
 *   --instruments=EURUSD Override instruments (comma-separated)
 *   --days=14            Override lookback days (default: 30)
 *   --dry-run            Don't auto-apply, just report results
 *   --verbose            Print detailed progress
 */

import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// Load .env.local from the local-runner directory
const scriptDir = new URL(".", import.meta.url).pathname;
await load({ envPath: `${scriptDir}.env.local`, export: true });

// Import optimizer modules (relative to repo root)
import {
  OptimizationLoop,
  computeCompositeScore,
  type OptimizationConfig,
  type OptimizationResult,
} from "../supabase/functions/optimizer/lib/optimizationLoop.ts";
import {
  createHTTPBacktestRunner,
  fetchCurrentConfig,
  extractBacktestResult,
  type RunnerConfig,
} from "../supabase/functions/optimizer/lib/backtestRunner.ts";
import {
  getFullParameterSpace,
  getCoreParameterSpace,
  configToParams,
  paramsToConfig,
} from "../supabase/functions/optimizer/lib/parameterSpace.ts";
import {
  autoApplyResult,
} from "../supabase/functions/optimizer/lib/autoApply.ts";

// ─── Configuration ───────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  console.error("   Copy .env.local.example → .env.local and fill in your values");
  Deno.exit(1);
}

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs(): {
  trials?: number;
  instruments?: string[];
  days?: number;
  dryRun: boolean;
  verbose: boolean;
} {
  const args = Deno.args;
  let trials: number | undefined;
  let instruments: string[] | undefined;
  let days: number | undefined;
  let dryRun = false;
  let verbose = false;

  for (const arg of args) {
    if (arg.startsWith("--trials=")) trials = parseInt(arg.split("=")[1]);
    if (arg.startsWith("--instruments=")) instruments = arg.split("=")[1].split(",");
    if (arg.startsWith("--days=")) days = parseInt(arg.split("=")[1]);
    if (arg === "--dry-run") dryRun = true;
    if (arg === "--verbose") verbose = true;
  }

  return { trials, instruments, days, dryRun, verbose };
}

// ─── Load Config ─────────────────────────────────────────────────────────────

async function loadFileConfig(): Promise<Record<string, any>> {
  try {
    const configPath = new URL("../supabase/functions/optimizer/config.json", import.meta.url);
    const text = await Deno.readTextFile(configPath);
    return JSON.parse(text);
  } catch {
    console.warn("⚠️  Could not load config.json, using defaults");
    return {};
  }
}

// ─── Supabase Helpers ────────────────────────────────────────────────────────

async function createOptimizerRun(userId: string, config: Record<string, any>): Promise<string> {
  const url = `${SUPABASE_URL}/rest/v1/optimizer_runs`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify({
      user_id: userId,
      status: "running",
      trials_count: 0,
      config_snapshot: config,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create optimizer_run: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data[0].id;
}

async function updateOptimizerRun(
  runId: string,
  update: Record<string, any>,
): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/optimizer_runs?id=eq.${runId}`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(update),
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const cliArgs = parseArgs();
  const fileConfig = await loadFileConfig();

  console.log("═══════════════════════════════════════════════════════");
  console.log("  SMC Optimizer — Local Runner");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Supabase: ${SUPABASE_URL}`);
  console.log(`  Dry run: ${cliArgs.dryRun ? "YES (no auto-apply)" : "NO (will auto-apply if gates pass)"}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("");

  // Determine user ID — from config or fetch from bot_configs
  let userId = fileConfig.userId;
  if (!userId) {
    // Fetch the first bot_config to get the user ID
    const url = `${SUPABASE_URL}/rest/v1/bot_configs?select=user_id&limit=1`;
    const resp = await fetch(url, {
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const data = await resp.json();
    if (!data || data.length === 0) {
      console.error("❌ No bot_configs found — cannot determine user ID");
      Deno.exit(1);
    }
    userId = data[0].user_id;
  }
  console.log(`  User: ${userId}`);

  // Fetch current config
  const currentConfig = await fetchCurrentConfig(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, userId);
  const configId = fileConfig.configId || currentConfig.id;
  console.log(`  Config: ${configId}`);

  // Build optimization config
  const days = cliArgs.days ?? 30;
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days);

  const instruments = cliArgs.instruments ?? fileConfig.instruments ?? ["EURUSD", "GBPUSD"];
  const maxTrials = cliArgs.trials ?? fileConfig.maxTrials ?? 30;
  const fullSpace = fileConfig.fullSpace ?? false;

  const optimizationConfig: OptimizationConfig = {
    maxTrials,
    walkForwardFolds: fileConfig.walkForwardFolds ?? 0,
    minConsistencyScore: fileConfig.minConsistencyScore ?? 0.70,
    minImprovementPercent: fileConfig.minImprovementPercent ?? 0.15,
    maxDeltaPercent: fileConfig.maxDeltaPercent ?? 0.50,
    fullSpace,
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    instruments,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
    userId,
    configId,
    seed: fileConfig.seed,
    tpeConfig: fileConfig.tpeConfig,
  };

  console.log(`  Instruments: ${instruments.join(", ")}`);
  console.log(`  Date range: ${optimizationConfig.startDate} → ${optimizationConfig.endDate} (${days} days)`);
  console.log(`  Trials: ${maxTrials}`);
  console.log(`  Walk-forward folds: ${optimizationConfig.walkForwardFolds}`);
  console.log(`  Parameter space: ${fullSpace ? "full" : "core"}`);
  console.log("");

  // Create run record in Supabase (so dashboard shows it)
  const runId = await createOptimizerRun(userId, {
    maxTrials,
    instruments,
    startDate: optimizationConfig.startDate,
    endDate: optimizationConfig.endDate,
    source: "local-runner",
  });
  console.log(`  Run ID: ${runId}`);
  console.log("");
  console.log("───────────────────────────────────────────────────────");
  console.log("");

  // Create the HTTP backtest runner with LONG timeout (30 min per backtest)
  const runnerConfig: RunnerConfig = {
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
    timeoutMs: 30 * 60 * 1000, // 30 minutes — no more timeouts
    pollIntervalMs: 10_000,     // poll every 10s
    verbose: cliArgs.verbose,
  };

  const runBacktest = createHTTPBacktestRunner(runnerConfig, {
    userId,
    configId,
    instruments,
    startDate: optimizationConfig.startDate,
    endDate: optimizationConfig.endDate,
  });

  // Create the optimization loop
  const paramSpace = fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  const loop = new OptimizationLoop(optimizationConfig, currentConfig.config_json || currentConfig, paramSpace);

  // Run the optimization
  const startTime = Date.now();
  let lastProgressUpdate = 0;

  try {
    const result = await loop.run(runBacktest, (trial, total, bestScore) => {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`  [${elapsed}m] Trial ${trial}/${total} — best score: ${bestScore.toFixed(3)}`);

      // Update Supabase every 5 trials
      if (trial - lastProgressUpdate >= 5 || trial === total) {
        lastProgressUpdate = trial;
        updateOptimizerRun(runId, {
          trials_count: trial,
          progress_message: `Trial ${trial}/${total} (best: ${bestScore.toFixed(3)})`,
          best_score: bestScore,
        }).catch(() => {}); // fire and forget
      }
    });

    // Report results
    console.log("");
    console.log("═══════════════════════════════════════════════════════");
    console.log("  RESULTS");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Duration: ${(result.durationMs / 1000 / 60).toFixed(1)} minutes`);
    console.log(`  Trials completed: ${result.trials.length}`);
    console.log(`  Baseline score: ${result.baseline.compositeScore.toFixed(4)}`);
    console.log(`  Best trial score: ${result.bestTrial?.compositeScore.toFixed(4) ?? "none"}`);
    console.log(`  Improvement: ${result.improvementPercent.toFixed(1)}%`);
    console.log(`  Auto-apply: ${result.autoApplied ? "YES" : "NO"}`);
    if (result.rejectReason) {
      console.log(`  Reject reason: ${result.rejectReason}`);
    }
    console.log("");

    // Baseline details
    console.log("  Baseline performance:");
    console.log(`    Trades: ${result.baseline.backtest.totalTrades}`);
    console.log(`    Win rate: ${(result.baseline.backtest.winRate * 100).toFixed(1)}%`);
    console.log(`    Profit factor: ${result.baseline.backtest.profitFactor.toFixed(2)}`);
    console.log(`    Expectancy: ${result.baseline.backtest.expectancy.toFixed(2)} pips`);
    console.log(`    Max DD: ${result.baseline.backtest.maxDrawdownPercent.toFixed(1)}%`);
    console.log("");

    if (result.bestTrial) {
      console.log("  Best trial performance:");
      console.log(`    Trades: ${result.bestTrial.backtest.totalTrades}`);
      console.log(`    Win rate: ${(result.bestTrial.backtest.winRate * 100).toFixed(1)}%`);
      console.log(`    Profit factor: ${result.bestTrial.backtest.profitFactor.toFixed(2)}`);
      console.log(`    Expectancy: ${result.bestTrial.backtest.expectancy.toFixed(2)} pips`);
      console.log(`    Max DD: ${result.bestTrial.backtest.maxDrawdownPercent.toFixed(1)}%`);
      console.log("");
    }

    // Auto-apply if gates pass (and not dry-run)
    if (result.autoApplied && !cliArgs.dryRun) {
      console.log("  🚀 Auto-applying optimized config to paper trading...");
      const applyResult = await autoApplyResult(result, currentConfig, {
        supabaseUrl: SUPABASE_URL,
        supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
        userId,
        configId,
      });
      console.log(`  ${applyResult.applied ? "✅" : "❌"} ${applyResult.reason}`);
      if (applyResult.backupId) {
        console.log(`  💾 Backup: ${applyResult.backupId}`);
      }

      // Update run record
      await updateOptimizerRun(runId, {
        status: "completed",
        completed_at: new Date().toISOString(),
        baseline_score: result.baseline.compositeScore,
        best_score: result.bestTrial?.compositeScore ?? null,
        improvement_percent: result.improvementPercent,
        trials_count: result.trials.length,
        auto_applied: applyResult.applied,
        reject_reason: applyResult.applied ? null : applyResult.reason,
        result_summary: {
          baseline: result.baseline.backtest,
          bestTrial: result.bestTrial?.backtest ?? null,
          trialsRun: result.trials.length,
          durationMs: result.durationMs,
        },
      });
    } else {
      const reason = cliArgs.dryRun
        ? "Dry run — no changes applied"
        : result.rejectReason ?? "No improvement found";

      await updateOptimizerRun(runId, {
        status: "completed",
        completed_at: new Date().toISOString(),
        baseline_score: result.baseline.compositeScore,
        best_score: result.bestTrial?.compositeScore ?? null,
        improvement_percent: result.improvementPercent,
        trials_count: result.trials.length,
        auto_applied: false,
        reject_reason: reason,
        result_summary: {
          baseline: result.baseline.backtest,
          bestTrial: result.bestTrial?.backtest ?? null,
          trialsRun: result.trials.length,
          durationMs: result.durationMs,
        },
      });

      console.log(`  ℹ️  ${reason}`);
    }

  } catch (err) {
    console.error("");
    console.error(`  ❌ Optimizer failed: ${(err as Error).message}`);
    console.error("");

    await updateOptimizerRun(runId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: (err as Error).message,
    });

    Deno.exit(1);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Done. Check the dashboard for full results.");
  console.log("═══════════════════════════════════════════════════════");
}

// Run
main();
