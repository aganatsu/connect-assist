#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * Optimizer CLI — Entry point for running the autonomous optimizer.
 * 
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env optimizer/cli.ts [options]
 * 
 * Options:
 *   --config <path>   Path to optimizer config JSON (default: optimizer/config.json)
 *   --dry-run         Run optimization but don't apply results
 *   --trials <n>      Override max trials
 *   --core-only       Use core parameter space only (faster, fewer params)
 *   --verbose         Print detailed progress
 * 
 * The optimizer:
 * 1. Loads config from file
 * 2. Fetches current paper trading config from Supabase
 * 3. Pre-fetches candle data for the date range
 * 4. Runs TPE optimization loop
 * 5. If improvement > 15% and walk-forward = robust → auto-applies
 * 6. Sends Telegram notification with results
 * 7. Saves trial history for warm-starting next run
 */

import { OptimizationLoop, OptimizationConfig, OptimizationResult } from "./lib/optimizationLoop.ts";
import { createBacktestRunner, prefetchCandleData, fetchCurrentConfig } from "./lib/backtestRunner.ts";
import { autoApplyResult } from "./lib/autoApply.ts";
import { getFullParameterSpace, getCoreParameterSpace } from "./lib/parameterSpace.ts";

// ─── CLI Argument Parsing ───

interface CLIArgs {
  configPath: string;
  dryRun: boolean;
  trials?: number;
  coreOnly: boolean;
  verbose: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    configPath: "optimizer/config.json",
    dryRun: false,
    coreOnly: false,
    verbose: false,
  };

  const rawArgs = Deno.args;
  for (let i = 0; i < rawArgs.length; i++) {
    switch (rawArgs[i]) {
      case "--config":
        args.configPath = rawArgs[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--trials":
        args.trials = parseInt(rawArgs[++i], 10);
        break;
      case "--core-only":
        args.coreOnly = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        Deno.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Autonomous Optimizer CLI
========================

Usage:
  deno run --allow-net --allow-read --allow-write --allow-env optimizer/cli.ts [options]

Options:
  --config <path>   Path to optimizer config JSON (default: optimizer/config.json)
  --dry-run         Run optimization but don't apply results
  --trials <n>      Override max trials (default from config)
  --core-only       Use core parameter space only (~25 params vs ~65)
  --verbose         Print detailed progress
  --help, -h        Show this help message

Environment Variables:
  SUPABASE_URL      Supabase project URL
  SUPABASE_KEY      Supabase service role key
  TELEGRAM_BOT_TOKEN  Telegram bot token for notifications
  TELEGRAM_CHAT_ID    Telegram chat ID for notifications
`);
}

// ─── Main ───

async function main(): Promise<void> {
  const args = parseArgs();
  const startTime = Date.now();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Autonomous Optimizer — SMC Trading     ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  // Load config
  let fileConfig: Partial<OptimizationConfig>;
  try {
    const configText = await Deno.readTextFile(args.configPath);
    fileConfig = JSON.parse(configText);
    console.log(`✓ Config loaded from ${args.configPath}`);
  } catch {
    console.log(`⚠ No config file found at ${args.configPath}, using defaults + env vars`);
    fileConfig = {};
  }

  // Merge config sources: file < env < CLI args
  const config: OptimizationConfig = {
    maxTrials: args.trials ?? fileConfig.maxTrials ?? 50,
    walkForwardFolds: fileConfig.walkForwardFolds ?? 4,
    minConsistencyScore: fileConfig.minConsistencyScore ?? 0.75,
    minImprovementPercent: fileConfig.minImprovementPercent ?? 0.15,
    maxDeltaPercent: fileConfig.maxDeltaPercent ?? 0.50,
    fullSpace: !args.coreOnly && (fileConfig.fullSpace ?? true),
    startDate: fileConfig.startDate ?? getDefaultStartDate(),
    endDate: fileConfig.endDate ?? getDefaultEndDate(),
    instruments: fileConfig.instruments ?? getDefaultInstruments(),
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? fileConfig.supabaseUrl ?? "",
    supabaseKey: Deno.env.get("SUPABASE_KEY") ?? fileConfig.supabaseKey ?? "",
    userId: fileConfig.userId ?? "",
    configId: fileConfig.configId ?? "",
    telegramBotToken: Deno.env.get("TELEGRAM_BOT_TOKEN") ?? fileConfig.telegramBotToken,
    telegramChatId: Deno.env.get("TELEGRAM_CHAT_ID") ?? fileConfig.telegramChatId,
    historyPath: fileConfig.historyPath ?? "optimizer/results/history.json",
    seed: fileConfig.seed,
  };

  // Validate required fields
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.error("❌ SUPABASE_URL and SUPABASE_KEY are required (env vars or config file)");
    Deno.exit(1);
  }
  if (!config.userId) {
    console.error("❌ userId is required in config file");
    Deno.exit(1);
  }

  // Print run config
  const paramSpace = config.fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  console.log(`\n📋 Run Configuration:`);
  console.log(`   Trials: ${config.maxTrials}`);
  console.log(`   Parameters: ${paramSpace.length} (${config.fullSpace ? "full" : "core"})`);
  console.log(`   Walk-forward folds: ${config.walkForwardFolds}`);
  console.log(`   Date range: ${config.startDate} → ${config.endDate}`);
  console.log(`   Instruments: ${config.instruments.join(", ")}`);
  console.log(`   Min improvement: ${(config.minImprovementPercent * 100).toFixed(0)}%`);
  console.log(`   Max delta: ±${(config.maxDeltaPercent * 100).toFixed(0)}%`);
  console.log(`   Dry run: ${args.dryRun}`);
  console.log("");

  // Fetch current config
  console.log("📡 Fetching current paper trading config...");
  const currentConfig = await fetchCurrentConfig(config.supabaseUrl, config.supabaseKey, config.userId);
  if (!config.configId) {
    config.configId = currentConfig.id;
  }
  console.log(`✓ Config loaded (ID: ${config.configId})`);

  // Pre-fetch candle data
  console.log("📊 Pre-fetching candle data...");
  const candleData = await prefetchCandleData(
    config.supabaseUrl,
    config.supabaseKey,
    config.instruments,
    config.startDate,
    config.endDate,
  );
  const totalCandles = Array.from(candleData.values()).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`✓ ${totalCandles} candles loaded across ${config.instruments.length} instruments`);

  // Create backtest runner
  // NOTE: In production, this imports the actual backtest engine.
  // For now, we use a placeholder that will be wired to the real engine.
  const runBacktest = createBacktestRunner(
    async (input) => {
      // This is the integration point with the backtest engine.
      // The actual implementation imports from backtest-engine/index.ts
      // and calls it with the pre-fetched candle data.
      throw new Error("Backtest engine integration not yet wired — run with actual engine import");
    },
    {
      userId: config.userId,
      configId: config.configId,
      instruments: config.instruments,
      startDate: config.startDate,
      endDate: config.endDate,
      walkForwardFolds: config.walkForwardFolds,
      candleData,
    },
  );

  // Load trial history for warm-starting
  let historicalTrials: any[] = [];
  if (config.historyPath) {
    try {
      const historyText = await Deno.readTextFile(config.historyPath);
      historicalTrials = JSON.parse(historyText);
      console.log(`✓ Loaded ${historicalTrials.length} historical trials for warm-start`);
    } catch {
      console.log("  No historical trials found — starting fresh");
    }
  }

  // Create and run optimization loop
  console.log("\n🚀 Starting optimization...\n");
  const loop = new OptimizationLoop(config, currentConfig, paramSpace);

  if (historicalTrials.length > 0) {
    loop.loadHistory(historicalTrials);
  }

  const progressCallback = args.verbose
    ? (trial: number, total: number, best: number) => {
        const pct = ((trial / total) * 100).toFixed(0);
        console.log(`  [${pct}%] Trial ${trial}/${total} — Best score: ${best.toFixed(3)}`);
      }
    : (trial: number, total: number, _best: number) => {
        if (trial % 10 === 0 || trial === total) {
          console.log(`  Progress: ${trial}/${total} trials`);
        }
      };

  const result: OptimizationResult = await loop.run(runBacktest, progressCallback);

  // Print results
  console.log("\n" + "═".repeat(50));
  console.log("📊 OPTIMIZATION RESULTS");
  console.log("═".repeat(50));
  console.log(`\n  Trials completed: ${result.trials.length}`);
  console.log(`  Duration: ${(result.durationMs / 1000 / 60).toFixed(1)} minutes`);
  console.log(`  Baseline score: ${result.baseline.compositeScore.toFixed(3)}`);

  if (result.bestTrial) {
    console.log(`  Best trial score: ${result.bestTrial.compositeScore.toFixed(3)}`);
    console.log(`  Improvement: ${result.improvementPercent.toFixed(1)}%`);
    console.log(`  Walk-forward: ${result.bestTrial.backtest.walkForward?.verdict ?? "N/A"}`);
    console.log(`\n  Best trial performance:`);
    console.log(`    Trades: ${result.bestTrial.backtest.totalTrades}`);
    console.log(`    Win Rate: ${(result.bestTrial.backtest.winRate * 100).toFixed(1)}%`);
    console.log(`    Profit Factor: ${result.bestTrial.backtest.profitFactor.toFixed(2)}`);
    console.log(`    Expectancy: ${result.bestTrial.backtest.expectancy.toFixed(2)} pips`);
    console.log(`    Max Drawdown: ${result.bestTrial.backtest.maxDrawdownPercent.toFixed(1)}%`);
  } else {
    console.log(`  No trial passed all gates`);
  }

  // Auto-apply (or dry-run)
  if (args.dryRun) {
    console.log(`\n  🏁 DRY RUN — no changes applied`);
    if (result.autoApplied) {
      console.log(`  Would have auto-applied (improvement: +${result.improvementPercent.toFixed(1)}%)`);
    }
  } else if (result.autoApplied) {
    console.log(`\n  ✅ Auto-applying best config...`);
    const applyResult = await autoApplyResult(result, currentConfig, {
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      userId: config.userId,
      configId: config.configId,
      telegramBotToken: config.telegramBotToken,
      telegramChatId: config.telegramChatId,
    });
    console.log(`  ${applyResult.applied ? "✅ Applied" : "❌ Not applied"}: ${applyResult.reason}`);
  } else {
    console.log(`\n  ⚠️ Not auto-applying: ${result.rejectReason}`);
  }

  // Save trial history
  if (config.historyPath) {
    const allTrials = [
      ...historicalTrials,
      ...result.trials.map(t => t.trial),
    ];
    // Keep last 500 trials max
    const trimmedTrials = allTrials.slice(-500);
    try {
      await Deno.mkdir("optimizer/results", { recursive: true });
      await Deno.writeTextFile(config.historyPath, JSON.stringify(trimmedTrials, null, 2));
      console.log(`\n  💾 Trial history saved (${trimmedTrials.length} trials)`);
    } catch (err) {
      console.warn(`  ⚠ Failed to save history: ${(err as Error).message}`);
    }
  }

  // Save full result
  const resultPath = `optimizer/results/run_${new Date().toISOString().slice(0, 10)}.json`;
  try {
    await Deno.writeTextFile(resultPath, JSON.stringify({
      config: { ...config, supabaseKey: "[REDACTED]" },
      result: {
        trialsCount: result.trials.length,
        baselineScore: result.baseline.compositeScore,
        bestScore: result.bestTrial?.compositeScore ?? null,
        improvementPercent: result.improvementPercent,
        autoApplied: result.autoApplied,
        rejectReason: result.rejectReason,
        durationMs: result.durationMs,
        bestTrialParams: result.bestTrial?.trial.params ?? null,
        bestTrialBacktest: result.bestTrial?.backtest ?? null,
      },
    }, null, 2));
    console.log(`  📄 Full results saved to ${resultPath}`);
  } catch (err) {
    console.warn(`  ⚠ Failed to save results: ${(err as Error).message}`);
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n⏱ Total runtime: ${totalTime} minutes`);
  console.log("═".repeat(50));
}

// ─── Helpers ───

function getDefaultStartDate(): string {
  // Default: 6 months ago
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

function getDefaultEndDate(): string {
  // Default: yesterday
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getDefaultInstruments(): string[] {
  return [
    "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
    "NZDUSD", "USDCHF", "EURGBP", "EURJPY", "GBPJPY",
    "XAUUSD", "BTCUSD",
  ];
}

// ─── Entry Point ───

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n❌ Fatal error: ${err.message}`);
    console.error(err.stack);
    Deno.exit(1);
  });
}
