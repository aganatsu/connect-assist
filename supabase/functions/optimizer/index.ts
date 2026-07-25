/**
 * optimizer — Supabase Edge Function (HTTP entry point for automated runs)
 * ──────────────────────────────────────────────────────────────────────
 * This is the HTTP wrapper that pg_cron calls every Sunday at 22:00 UTC.
 * It orchestrates the full optimization pipeline:
 * 
 * 1. Deduplication check (skip if already ran this week)
 * 2. Fetch current config
 * 3. Run TPE optimization loop (calling backtest-engine via HTTP)
 * 4. Auto-apply if gates pass
 * 5. Record run in optimizer_runs table
 * 6. Send Telegram notification
 * 
 * Endpoint: POST /functions/v1/optimizer
 * Body: {
 *   userId?: string,        // override user (default: from config)
 *   dryRun?: boolean,       // skip auto-apply
 *   trials?: number,        // override trial count
 *   coreOnly?: boolean,     // use core param space only
 *   source?: string,        // "cron" | "manual" (for logging)
 * }
 * 
 * Auth: Service role key (this function is NOT user-facing)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { OptimizationLoop } from "./lib/optimizationLoop.ts";
import type { OptimizationConfig, OptimizationResult } from "./lib/optimizationLoop.ts";
import { createHTTPBacktestRunner, fetchCurrentConfig } from "./lib/backtestRunner.ts";
import { autoApplyResult } from "./lib/autoApply.ts";
import { getFullParameterSpace, getCoreParameterSpace } from "./lib/parameterSpace.ts";

// ─── Config ───

const DEFAULT_CONFIG: Partial<OptimizationConfig> = {
  maxTrials: 50,
  walkForwardFolds: 4,
  minConsistencyScore: 0.75,
  minImprovementPercent: 0.15,
  maxDeltaPercent: 0.50,
  fullSpace: true,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function respond(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !supabaseKey) {
    return respond({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const {
      userId,
      dryRun = false,
      trials,
      coreOnly = false,
      source = "unknown",
    } = body;

    // Load optimizer config from file (bundled with the function)
    let fileConfig: Partial<OptimizationConfig> = {};
    try {
      const configText = await Deno.readTextFile(new URL("./config.json", import.meta.url).pathname);
      fileConfig = JSON.parse(configText);
    } catch {
      // No config file — use defaults
    }

    const targetUserId = userId || fileConfig.userId;
    if (!targetUserId) {
      return respond({ error: "userId is required (in body or config.json)" }, 400);
    }

    const db = createClient(supabaseUrl, supabaseKey);

    // ── Deduplication: check if we already ran this week ──
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: recentRuns } = await db
      .from("optimizer_runs")
      .select("id, status, started_at")
      .eq("user_id", targetUserId)
      .gte("started_at", oneWeekAgo)
      .in("status", ["running", "completed"])
      .limit(1);

    if (recentRuns && recentRuns.length > 0 && source === "cron") {
      console.log(`[optimizer] Skipping — already ran this week (run: ${recentRuns[0].id})`);
      return respond({
        status: "skipped",
        reason: "Already ran this week",
        lastRunId: recentRuns[0].id,
      });
    }

    // ── Record run start ──
    const { data: runRow, error: insertErr } = await db
      .from("optimizer_runs")
      .insert({
        user_id: targetUserId,
        status: "running",
        config_snapshot: { ...fileConfig, trials, coreOnly, source },
      })
      .select("id")
      .single();

    if (insertErr || !runRow) {
      return respond({ error: `Failed to create optimizer run: ${insertErr?.message}` }, 500);
    }

    const runId = runRow.id;
    console.log(`[optimizer:${runId}] Starting (source: ${source}, trials: ${trials ?? fileConfig.maxTrials ?? 50})`);

    // ── Build config ──
    const config: OptimizationConfig = {
      maxTrials: trials ?? fileConfig.maxTrials ?? DEFAULT_CONFIG.maxTrials!,
      walkForwardFolds: fileConfig.walkForwardFolds ?? DEFAULT_CONFIG.walkForwardFolds!,
      minConsistencyScore: fileConfig.minConsistencyScore ?? DEFAULT_CONFIG.minConsistencyScore!,
      minImprovementPercent: fileConfig.minImprovementPercent ?? DEFAULT_CONFIG.minImprovementPercent!,
      maxDeltaPercent: fileConfig.maxDeltaPercent ?? DEFAULT_CONFIG.maxDeltaPercent!,
      fullSpace: !coreOnly && (fileConfig.fullSpace ?? DEFAULT_CONFIG.fullSpace!),
      startDate: fileConfig.startDate ?? getDefaultStartDate(),
      endDate: fileConfig.endDate ?? getDefaultEndDate(),
      instruments: fileConfig.instruments ?? getDefaultInstruments(),
      supabaseUrl,
      supabaseKey,
      userId: targetUserId,
      configId: fileConfig.configId ?? "",
      historyPath: undefined, // No file persistence in edge function mode
      seed: fileConfig.seed,
    };

    // ── Fetch current config ──
    const currentConfig = await fetchCurrentConfig(supabaseUrl, supabaseKey, targetUserId);
    if (!config.configId) {
      config.configId = currentConfig.id;
    }

    // ── Create backtest runner ──
    const paramSpace = config.fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
    const runBacktest = createHTTPBacktestRunner(
      {
        supabaseUrl,
        supabaseKey,
        timeoutMs: 600_000,
        pollIntervalMs: 5_000,
        verbose: false,
      },
      {
        userId: config.userId,
        configId: config.configId,
        instruments: config.instruments,
        startDate: config.startDate,
        endDate: config.endDate,
        walkForwardFolds: config.walkForwardFolds,
      },
    );

    // ── Run optimization ──
    const loop = new OptimizationLoop(config, currentConfig.config_json || currentConfig, paramSpace);
    const result: OptimizationResult = await loop.run(runBacktest);

    // ── Auto-apply ──
    let applyOutcome = "skipped";
    if (!dryRun && result.autoApplied) {
      const applyResult = await autoApplyResult(result, currentConfig, {
        supabaseUrl,
        supabaseKey,
        userId: targetUserId,
        configId: config.configId,
      });
      applyOutcome = applyResult.applied ? "applied" : "rejected";
    } else if (dryRun && result.autoApplied) {
      applyOutcome = "dry_run_would_apply";
    }

    // ── Record completion ──
    await db.from("optimizer_runs").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      trials_count: result.trials.length,
      baseline_score: result.baseline.compositeScore,
      best_score: result.bestTrial?.compositeScore ?? null,
      improvement_percent: result.improvementPercent,
      auto_applied: result.autoApplied && applyOutcome === "applied",
      reject_reason: result.rejectReason ?? null,
      result_summary: {
        applyOutcome,
        durationMs: result.durationMs,
        bestTrialWinRate: result.bestTrial?.backtest.winRate ?? null,
        bestTrialPF: result.bestTrial?.backtest.profitFactor ?? null,
        bestTrialExpectancy: result.bestTrial?.backtest.expectancy ?? null,
        walkForwardVerdict: result.bestTrial?.backtest.walkForward?.verdict ?? null,
      },
    }).eq("id", runId);

    console.log(`[optimizer:${runId}] Completed: ${result.trials.length} trials, improvement: ${result.improvementPercent.toFixed(1)}%, outcome: ${applyOutcome}`);

    return respond({
      runId,
      status: "completed",
      trialsCount: result.trials.length,
      baselineScore: result.baseline.compositeScore,
      bestScore: result.bestTrial?.compositeScore ?? null,
      improvementPercent: result.improvementPercent,
      applyOutcome,
      durationMs: result.durationMs,
    });

  } catch (err: any) {
    console.error("[optimizer] Fatal error:", err);

    // Try to mark the run as failed
    try {
      const db = createClient(supabaseUrl, supabaseKey);
      // We don't have runId here if it failed before insert, but try anyway
      await db.from("optimizer_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: err?.message || "Unknown error",
        })
        .eq("status", "running")
        .order("started_at", { ascending: false })
        .limit(1);
    } catch { /* best effort */ }

    return respond({ error: err?.message || "Internal error" }, 500);
  }
});

// ─── Helpers ───

function getDefaultStartDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

function getDefaultEndDate(): string {
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
