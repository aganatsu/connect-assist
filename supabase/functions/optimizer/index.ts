/**
 * optimizer — Supabase Edge Function (Async State Machine)
 * ──────────────────────────────────────────────────────────────────────
 * Runs the TPE optimization loop using a non-blocking state machine.
 * Each invocation does ONE short task and self-invokes for the next step.
 * 
 * This avoids Supabase's 150s idle timeout by never blocking on long polls.
 * 
 * State Machine:
 *   "start"         → create run, start baseline backtest, self-invoke "poll-backtest"
 *   "poll-backtest" → check if current backtest is done. If not, self-invoke again in 10s.
 *                     If done: score it, decide next step (start trial or finalize)
 *   "start-trial"   → sample TPE, start trial backtest, self-invoke "poll-backtest"
 *   "finalize"      → evaluate results, auto-apply, send notification
 *   "status"        → return run status
 *   "cancel"        → cancel run
 * 
 * Endpoint: POST /functions/v1/optimizer
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { verifyCronOrUserCaller } from "../_shared/cronAuth.ts";
import { TPEOptimizer } from "./lib/tpe.ts";
import type { Trial, TPEConfig } from "./lib/tpe.ts";
import {
  computeCompositeScore,
} from "./lib/optimizationLoop.ts";
import type { OptimizationConfig, BacktestResult, TrialResult, OptimizationResult } from "./lib/optimizationLoop.ts";
import { fetchCurrentConfig } from "./lib/backtestRunner.ts";
import { autoApplyResult } from "./lib/autoApply.ts";
import {
  getFullParameterSpace,
  getCoreParameterSpace,
  paramsToConfig,
  configToParams,
  validateParams,
  enforceMaxDelta,
} from "./lib/parameterSpace.ts";

// ─── Constants ───

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function respond(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── State persisted between invocations ───

interface OptimizerState {
  /** What phase we're in */
  phase: "awaiting-baseline" | "awaiting-trial" | "ready-for-trial" | "done";
  /** Serialized TPE state */
  tpeState: { trials: Trial[]; nextId: number; rngState: number[]; config: TPEConfig };
  /** Baseline trial result (set after baseline completes) */
  baseline: TrialResult | null;
  /** All completed trial results */
  completedTrials: TrialResult[];
  /** Best passing trial */
  bestPassingTrial: TrialResult | null;
  /** Baseline params */
  baselineParams: Record<string, number | string | boolean>;
  /** Total trials to run */
  maxTrials: number;
  /** Trials completed */
  trialsCompleted: number;
  /** Optimization config */
  config: OptimizationConfig;
  /** Current config row from DB */
  currentConfig: Record<string, any>;
  /** Dry run flag */
  dryRun: boolean;
  /** Run start timestamp */
  startTime: number;
  /** Full or core param space */
  fullSpace: boolean;
  /** Current backtest run ID being awaited */
  pendingBacktestRunId: string | null;
  /** How many times we've polled the current backtest */
  pollCount: number;
}

// ─── Main Handler ───
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Gate 0: Requires either cron-secret (scheduled) or valid user JWT (manual trigger).
  const authError = await verifyCronOrUserCaller(req);
  if (authError) return authError;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !supabaseKey) {
    return respond({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  const db = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "start";
    body._authHeader = req.headers.get("authorization") ?? "";

    switch (action) {
      case "start":
        return await handleStart(db, supabaseUrl, supabaseKey, body);
      case "poll-backtest":
        return await handlePollBacktest(db, supabaseUrl, supabaseKey, body);
      case "start-trial":
        return await handleStartTrial(db, supabaseUrl, supabaseKey, body);
      case "finalize":
        return await handleFinalize(db, supabaseUrl, supabaseKey, body);
      case "status":
        return await handleStatus(db, body);
      case "cancel":
        return await handleCancel(db, body);
      default:
        return respond({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err: any) {
    console.error("[optimizer] Fatal error:", err);
    return respond({ error: err?.message || "Internal error" }, 500);
  }
});

// ─── Action: START ───

async function handleStart(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  body: any,
): Promise<Response> {
  const {
    userId,
    dryRun = false,
    trials,
    coreOnly = false,
    source = "unknown",
  } = body;

  // Derive userId from JWT if not provided
  let jwtUserId: string | undefined;
  try {
    const auth = (body._authHeader as string | undefined) ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token && token.split(".").length === 3) {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload?.sub) jwtUserId = payload.sub;
    }
  } catch { /* ignore */ }

  // Load file config
  let fileConfig: Partial<OptimizationConfig> = {};
  try {
    const configText = await Deno.readTextFile(new URL("./config.json", import.meta.url).pathname);
    fileConfig = JSON.parse(configText);
  } catch { /* use defaults */ }

  const targetUserId = userId || jwtUserId || fileConfig.userId;
  if (!targetUserId) {
    return respond({ error: "userId is required (in body or config.json)" }, 400);
  }

  // Deduplication for cron triggers
  if (source === "cron") {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: recentRuns } = await db
      .from("optimizer_runs")
      .select("id, status, started_at")
      .eq("user_id", targetUserId)
      .gte("started_at", oneWeekAgo)
      .in("status", ["running", "completed"])
      .limit(1);

    if (recentRuns && recentRuns.length > 0) {
      return respond({ status: "skipped", reason: "Already ran this week", lastRunId: recentRuns[0].id });
    }
  }

  // Build config
  const maxTrials = trials ?? fileConfig.maxTrials ?? 30;
  const fullSpace = !coreOnly && (fileConfig.fullSpace ?? true);
  const config: OptimizationConfig = {
    maxTrials,
    walkForwardFolds: fileConfig.walkForwardFolds ?? 3,
    minConsistencyScore: fileConfig.minConsistencyScore ?? 0.75,
    minImprovementPercent: fileConfig.minImprovementPercent ?? 0.15,
    maxDeltaPercent: fileConfig.maxDeltaPercent ?? 0.50,
    fullSpace,
    startDate: fileConfig.startDate ?? getDefaultStartDate(),
    endDate: fileConfig.endDate ?? getDefaultEndDate(),
    instruments: fileConfig.instruments ?? getDefaultInstruments(),
    supabaseUrl,
    supabaseKey,
    userId: targetUserId,
    configId: fileConfig.configId ?? "",
    seed: fileConfig.seed,
  };

  // Fetch current config
  const currentConfig = await fetchCurrentConfig(supabaseUrl, supabaseKey, targetUserId);
  if (!config.configId) config.configId = currentConfig.id;

  // Create run record
  const { data: runRow, error: insertErr } = await db
    .from("optimizer_runs")
    .insert({
      user_id: targetUserId,
      status: "running",
      trials_count: 0,
      config_snapshot: { maxTrials, coreOnly, source, startDate: config.startDate, endDate: config.endDate },
    })
    .select("id")
    .single();

  if (insertErr || !runRow) {
    return respond({ error: `Failed to create run: ${insertErr?.message}` }, 500);
  }

  const runId = runRow.id;
  console.log(`[optimizer:${runId}] Starting (source: ${source}, trials: ${maxTrials})`);

  // Initialize TPE
  const paramSpace = fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  const baselineParams = configToParams(currentConfig.config_json || currentConfig);

  const tpe = new TPEOptimizer(paramSpace, {
    ...config.tpeConfig,
    seed: config.seed,
    nStartupTrials: Math.min(8, Math.floor(maxTrials * 0.3)),
  });

  // Start baseline backtest (non-blocking)
  const baselineConfig = paramsToConfig(baselineParams, {});
  baselineConfig.walkForwardFolds = config.walkForwardFolds;
  baselineConfig.startDate = config.startDate;
  baselineConfig.endDate = config.endDate;
  baselineConfig.instruments = config.instruments;

  let backtestRunId: string;
  try {
    backtestRunId = await startBacktest(supabaseUrl, supabaseKey, config, baselineConfig);
  } catch (err) {
    await db.from("optimizer_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: `Baseline backtest failed: ${(err as Error).message}`,
    }).eq("id", runId);
    return respond({ error: `Baseline backtest failed: ${(err as Error).message}` }, 500);
  }

  // Build initial state
  const state: OptimizerState = {
    phase: "awaiting-baseline",
    tpeState: tpe.serialize(),
    baseline: null,
    completedTrials: [],
    bestPassingTrial: null,
    baselineParams,
    maxTrials,
    trialsCompleted: 0,
    config,
    currentConfig,
    dryRun,
    startTime: Date.now(),
    fullSpace,
    pendingBacktestRunId: backtestRunId,
    pollCount: 0,
  };

  // Persist state
  await db.from("optimizer_runs").update({
    progress: 2,
    progress_message: `Baseline backtest started (run: ${backtestRunId})...`,
    result_summary: { state },
  }).eq("id", runId);

  // Self-invoke poll-backtest after a short delay (give backtest engine time to start)
  await selfInvokeDelayed(supabaseUrl, supabaseKey, { action: "poll-backtest", runId }, 10_000);

  return respond({ runId, status: "running", message: "Optimization started" });
}

// ─── Action: POLL-BACKTEST ───
// Checks if the pending backtest is done. If not, self-invokes again.
// If done, either scores baseline and starts first trial, or scores trial and starts next.

async function handlePollBacktest(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  body: any,
): Promise<Response> {
  const { runId } = body;
  if (!runId) return respond({ error: "runId required" }, 400);

  // Load run
  const { data: run } = await db.from("optimizer_runs")
    .select("status, result_summary, user_id")
    .eq("id", runId)
    .single();

  if (!run) return respond({ error: "Run not found" }, 404);
  if (run.status === "cancelled") return respond({ status: "cancelled" });
  if (run.status !== "running") return respond({ error: `Run is ${run.status}` }, 400);

  const state: OptimizerState = run.result_summary?.state;
  if (!state) return respond({ error: "No state found" }, 500);

  const { pendingBacktestRunId, config } = state;
  if (!pendingBacktestRunId) return respond({ error: "No pending backtest" }, 500);

  // Check backtest status
  const backtestStatus = await checkBacktestStatus(supabaseUrl, supabaseKey, pendingBacktestRunId);

  if (backtestStatus.status === "running" || backtestStatus.status === "pending") {
    // Still running — increment poll count and self-invoke again
    state.pollCount++;
    
    // Safety: max 120 polls (20 minutes at 10s intervals)
    // Backtests with time-boxing can legitimately take 15+ min for multi-chunk runs
    if (state.pollCount > 120) {
      await db.from("optimizer_runs").update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: `Backtest ${pendingBacktestRunId} timed out after ${state.pollCount} polls`,
      }).eq("id", runId);
      return respond({ error: "Backtest timed out" }, 500);
    }

    await db.from("optimizer_runs").update({
      progress_message: state.phase === "awaiting-baseline" 
        ? `Waiting for baseline backtest... (poll ${state.pollCount})`
        : `Trial ${state.trialsCompleted + 1}/${state.maxTrials} — waiting for backtest... (poll ${state.pollCount})`,
      result_summary: { state },
    }).eq("id", runId);

    // Self-invoke again in 10 seconds
    await selfInvokeDelayed(supabaseUrl, supabaseKey, { action: "poll-backtest", runId }, 10_000);
    return respond({ status: "polling", pollCount: state.pollCount });
  }

  if (backtestStatus.status === "failed" || backtestStatus.status === "cancelled") {
    if (state.phase === "awaiting-baseline") {
      await db.from("optimizer_runs").update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: `Baseline backtest ${backtestStatus.status}: ${backtestStatus.error_message || backtestStatus.error || "unknown"}`,
      }).eq("id", runId);
      return respond({ error: `Baseline backtest ${backtestStatus.status}` }, 500);
    } else {
      // Trial backtest failed — score as 0, move to next trial
      return await handleTrialBacktestResult(db, supabaseUrl, supabaseKey, runId, state, null);
    }
  }

  // Backtest completed!
  const backtestResult = extractBacktestResult(backtestStatus.results);

  if (state.phase === "awaiting-baseline") {
    return await handleBaselineComplete(db, supabaseUrl, supabaseKey, runId, state, backtestResult);
  } else {
    return await handleTrialBacktestResult(db, supabaseUrl, supabaseKey, runId, state, backtestResult);
  }
}

// ─── Handle baseline backtest completion ───

async function handleBaselineComplete(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  runId: string,
  state: OptimizerState,
  backtestResult: BacktestResult,
): Promise<Response> {
  const { config } = state;
  const baselineScore = computeCompositeScore(backtestResult);

  const baselineTrial: TrialResult = {
    trial: { id: -1, params: state.baselineParams, score: baselineScore, timestamp: Date.now() },
    backtest: backtestResult,
    compositeScore: baselineScore,
    violations: [],
    walkForwardPassed: (backtestResult.walkForward?.consistencyScore ?? 0) >= config.minConsistencyScore,
  };

  // Warm-start TPE with baseline
  const paramSpace = state.fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  const tpe = TPEOptimizer.restore(paramSpace, state.tpeState);
  tpe.tell(state.baselineParams, baselineScore);

  // Update state
  state.baseline = baselineTrial;
  state.tpeState = tpe.serialize();
  state.phase = "ready-for-trial";
  state.pendingBacktestRunId = null;
  state.pollCount = 0;

  await db.from("optimizer_runs").update({
    progress: 5,
    progress_message: `Baseline: ${baselineScore.toFixed(2)}. Starting trials...`,
    baseline_score: baselineScore,
    result_summary: { state },
  }).eq("id", runId);

  console.log(`[optimizer:${runId}] Baseline score: ${baselineScore.toFixed(2)}. Starting trials.`);

  // Immediately start first trial
  await selfInvoke(supabaseUrl, supabaseKey, { action: "start-trial", runId });
  return respond({ status: "baseline-complete", baselineScore });
}

// ─── Handle trial backtest result ───

async function handleTrialBacktestResult(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  runId: string,
  state: OptimizerState,
  backtestResult: BacktestResult | null,
): Promise<Response> {
  const { config } = state;
  const paramSpace = state.fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  const tpe = TPEOptimizer.restore(paramSpace, state.tpeState);

  // Get the candidate params from the last trial in TPE (the one we're awaiting)
  // We stored them in state before starting the backtest
  const candidateParams = (state as any)._pendingTrialParams;

  let score = 0;
  let wfPassed = false;
  let violations: string[] = [];

  if (backtestResult) {
    score = computeCompositeScore(backtestResult);
    wfPassed = (backtestResult.walkForward?.consistencyScore ?? 0) >= config.minConsistencyScore;
  } else {
    violations = ["Backtest failed or was cancelled"];
  }

  const trial = tpe.tell(candidateParams, score);
  const trialResult: TrialResult = {
    trial,
    backtest: backtestResult ?? { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 },
    compositeScore: score,
    violations,
    walkForwardPassed: wfPassed,
  };

  state.completedTrials.push(trialResult);
  state.trialsCompleted++;

  // Track best passing trial
  if (wfPassed && score > (state.bestPassingTrial?.compositeScore ?? 0)) {
    state.bestPassingTrial = trialResult;
  }

  // Update TPE state
  state.tpeState = tpe.serialize();
  state.pendingBacktestRunId = null;
  state.pollCount = 0;
  state.phase = "ready-for-trial";
  delete (state as any)._pendingTrialParams;

  const progress = Math.round(10 + (state.trialsCompleted / state.maxTrials) * 85);
  const bestScore = state.bestPassingTrial?.compositeScore ?? state.baseline?.compositeScore ?? 0;

  await db.from("optimizer_runs").update({
    progress,
    progress_message: `Trial ${state.trialsCompleted}/${state.maxTrials} — best: ${bestScore.toFixed(2)}`,
    trials_count: state.trialsCompleted,
    best_score: state.bestPassingTrial?.compositeScore ?? null,
    result_summary: { state },
  }).eq("id", runId);

  // Check if done
  if (state.trialsCompleted >= state.maxTrials) {
    await selfInvoke(supabaseUrl, supabaseKey, { action: "finalize", runId });
    return respond({ status: "trials-complete", trialsCompleted: state.trialsCompleted });
  }

  // Start next trial
  await selfInvoke(supabaseUrl, supabaseKey, { action: "start-trial", runId });
  return respond({ status: "trial-scored", trial: state.trialsCompleted, score });
}

// ─── Action: START-TRIAL ───

async function handleStartTrial(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  body: any,
): Promise<Response> {
  const { runId } = body;
  if (!runId) return respond({ error: "runId required" }, 400);

  // Load run
  const { data: run } = await db.from("optimizer_runs")
    .select("status, result_summary")
    .eq("id", runId)
    .single();

  if (!run) return respond({ error: "Run not found" }, 404);
  if (run.status === "cancelled") return respond({ status: "cancelled" });
  if (run.status !== "running") return respond({ error: `Run is ${run.status}` }, 400);

  const state: OptimizerState = run.result_summary?.state;
  if (!state) return respond({ error: "No state found" }, 500);

  const { config } = state;
  const paramSpace = state.fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  const tpe = TPEOptimizer.restore(paramSpace, state.tpeState);

  // Sample candidate from TPE
  let candidateParams = tpe.ask();

  // Enforce max delta from baseline
  candidateParams = enforceMaxDelta(candidateParams, state.baselineParams, config.maxDeltaPercent) as Record<string, number | string | boolean>;

  // Validate constraints
  const violations = validateParams(candidateParams);
  if (violations.length > 0) {
    // Skip this trial — score as 0
    const trial = tpe.tell(candidateParams, 0);
    state.completedTrials.push({
      trial,
      backtest: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 },
      compositeScore: 0,
      violations,
      walkForwardPassed: false,
    });
    state.trialsCompleted++;
    state.tpeState = tpe.serialize();

    const progress = Math.round(10 + (state.trialsCompleted / state.maxTrials) * 85);
    await db.from("optimizer_runs").update({
      progress,
      progress_message: `Trial ${state.trialsCompleted}/${state.maxTrials} — skipped (constraint violation)`,
      trials_count: state.trialsCompleted,
      result_summary: { state },
    }).eq("id", runId);

    // Check if done
    if (state.trialsCompleted >= state.maxTrials) {
      await selfInvoke(supabaseUrl, supabaseKey, { action: "finalize", runId });
    } else {
      await selfInvoke(supabaseUrl, supabaseKey, { action: "start-trial", runId });
    }
    return respond({ status: "trial-skipped", trial: state.trialsCompleted });
  }

  // Build config for this trial
  const candidateConfig = paramsToConfig(candidateParams, {});
  candidateConfig.walkForwardFolds = config.walkForwardFolds;
  candidateConfig.startDate = config.startDate;
  candidateConfig.endDate = config.endDate;
  candidateConfig.instruments = config.instruments;

  // Start backtest (non-blocking)
  let backtestRunId: string;
  try {
    backtestRunId = await startBacktest(supabaseUrl, supabaseKey, config, candidateConfig);
  } catch (err) {
    // Backtest start failed — score as 0 and move on
    const trial = tpe.tell(candidateParams, 0);
    state.completedTrials.push({
      trial,
      backtest: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 },
      compositeScore: 0,
      violations: [`Backtest start error: ${(err as Error).message}`],
      walkForwardPassed: false,
    });
    state.trialsCompleted++;
    state.tpeState = tpe.serialize();

    await db.from("optimizer_runs").update({
      progress: Math.round(10 + (state.trialsCompleted / state.maxTrials) * 85),
      progress_message: `Trial ${state.trialsCompleted}/${state.maxTrials} — backtest start failed`,
      trials_count: state.trialsCompleted,
      result_summary: { state },
    }).eq("id", runId);

    if (state.trialsCompleted >= state.maxTrials) {
      await selfInvoke(supabaseUrl, supabaseKey, { action: "finalize", runId });
    } else {
      await selfInvoke(supabaseUrl, supabaseKey, { action: "start-trial", runId });
    }
    return respond({ status: "trial-backtest-failed", trial: state.trialsCompleted });
  }

  // Save candidate params so we can score them when backtest completes
  (state as any)._pendingTrialParams = candidateParams;
  state.phase = "awaiting-trial";
  state.pendingBacktestRunId = backtestRunId;
  state.pollCount = 0;
  // Update TPE state (ask was called, need to persist)
  state.tpeState = tpe.serialize();

  await db.from("optimizer_runs").update({
    progress_message: `Trial ${state.trialsCompleted + 1}/${state.maxTrials} — backtest running...`,
    result_summary: { state },
  }).eq("id", runId);

  // Poll after 15 seconds (give backtest time to start)
  await selfInvokeDelayed(supabaseUrl, supabaseKey, { action: "poll-backtest", runId }, 15_000);
  return respond({ status: "trial-started", backtestRunId });
}

// ─── Action: FINALIZE ───

async function handleFinalize(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  body: any,
): Promise<Response> {
  const { runId } = body;
  if (!runId) return respond({ error: "runId required" }, 400);

  const { data: run } = await db.from("optimizer_runs")
    .select("status, result_summary")
    .eq("id", runId)
    .single();

  if (!run) return respond({ error: "Run not found" }, 404);

  const state: OptimizerState = run.result_summary?.state;
  if (!state) return respond({ error: "No state found" }, 500);

  const { baseline, completedTrials, bestPassingTrial, config, currentConfig, dryRun, startTime } = state;
  const baselineScore = baseline?.compositeScore ?? 0;

  // Determine auto-apply
  let autoApplied = false;
  let improvementPercent = 0;
  let rejectReason: string | undefined;

  if (bestPassingTrial && baselineScore > 0) {
    improvementPercent = ((bestPassingTrial.compositeScore - baselineScore) / baselineScore) * 100;
    if (improvementPercent >= config.minImprovementPercent * 100) {
      autoApplied = true;
    } else {
      rejectReason = `Improvement ${improvementPercent.toFixed(1)}% < required ${(config.minImprovementPercent * 100).toFixed(0)}%`;
    }
  } else if (!bestPassingTrial) {
    rejectReason = "No trial passed walk-forward validation gate";
  } else {
    rejectReason = "Baseline score is zero — cannot compute improvement";
  }

  const durationMs = Date.now() - startTime;

  const result: OptimizationResult = {
    trials: completedTrials,
    bestTrial: bestPassingTrial,
    baseline: baseline!,
    autoApplied,
    improvementPercent,
    durationMs,
    rejectReason,
  };

  // Auto-apply
  let applyOutcome = "skipped";
  if (!dryRun && autoApplied) {
    try {
      const applyResult = await autoApplyResult(result, currentConfig, {
        supabaseUrl,
        supabaseKey,
        userId: config.userId,
        configId: config.configId,
      });
      applyOutcome = applyResult.applied ? "applied" : "rejected";
    } catch (err) {
      applyOutcome = `error: ${(err as Error).message}`;
    }
  } else if (dryRun && autoApplied) {
    applyOutcome = "dry_run_would_apply";
  }

  // Record completion (clear state from result_summary)
  await db.from("optimizer_runs").update({
    status: "completed",
    completed_at: new Date().toISOString(),
    progress: 100,
    progress_message: `Done — ${applyOutcome}`,
    trials_count: completedTrials.length,
    baseline_score: baselineScore,
    best_score: bestPassingTrial?.compositeScore ?? null,
    improvement_percent: improvementPercent,
    auto_applied: autoApplied && applyOutcome === "applied",
    reject_reason: rejectReason ?? null,
    result_summary: {
      applyOutcome,
      durationMs,
      bestTrialWinRate: bestPassingTrial?.backtest.winRate ?? null,
      bestTrialPF: bestPassingTrial?.backtest.profitFactor ?? null,
      bestTrialExpectancy: bestPassingTrial?.backtest.expectancy ?? null,
      walkForwardVerdict: bestPassingTrial?.backtest.walkForward?.verdict ?? null,
    },
  }).eq("id", runId);

  console.log(`[optimizer:${runId}] COMPLETED: ${completedTrials.length} trials, improvement: ${improvementPercent.toFixed(1)}%, outcome: ${applyOutcome}`);

  return respond({
    runId,
    status: "completed",
    trialsCount: completedTrials.length,
    baselineScore,
    bestScore: bestPassingTrial?.compositeScore ?? null,
    improvementPercent,
    applyOutcome,
    durationMs,
  });
}

// ─── Action: STATUS ───

async function handleStatus(db: SupabaseClient, body: any): Promise<Response> {
  const { runId } = body;
  if (!runId) return respond({ error: "runId required" }, 400);

  const { data: run } = await db.from("optimizer_runs")
    .select("id, status, progress, progress_message, trials_count, baseline_score, best_score, improvement_percent, auto_applied, reject_reason, started_at, completed_at, error_message")
    .eq("id", runId)
    .single();

  if (!run) return respond({ error: "Run not found" }, 404);
  return respond(run);
}

// ─── Action: CANCEL ───

async function handleCancel(db: SupabaseClient, body: any): Promise<Response> {
  const { runId } = body;
  if (!runId) return respond({ error: "runId required" }, 400);

  await db.from("optimizer_runs").update({
    status: "cancelled",
    completed_at: new Date().toISOString(),
    progress_message: "Cancelled by user",
  }).eq("id", runId);

  return respond({ status: "cancelled", runId });
}

// ─── Backtest Helpers (non-blocking) ───

/** Start a backtest and return the runId immediately (does NOT wait for completion) */
async function startBacktest(
  supabaseUrl: string,
  supabaseKey: string,
  config: OptimizationConfig,
  backtestConfig: Record<string, any>,
): Promise<string> {
  const engineUrl = `${supabaseUrl}/functions/v1/backtest-engine`;

  // Normalize instrument codes
  const normalizeSymbol = (s: string): string => {
    if (s.includes("/")) return s;
    if (s.length === 6) return `${s.slice(0, 3)}/${s.slice(3)}`;
    return s;
  };

  const payload = {
    action: "start",
    userId: config.userId,
    instruments: (config.instruments ?? []).map(normalizeSymbol),
    startDate: config.startDate,
    endDate: config.endDate,
    startingBalance: 10000,
    config: backtestConfig,
    walkForwardFolds: backtestConfig.walkForwardFolds ?? config.walkForwardFolds ?? 0,
  };

  const response = await fetch(engineUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Backtest start failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  if (!data.runId) {
    throw new Error(`Backtest start returned no runId: ${JSON.stringify(data)}`);
  }

  return data.runId;
}

/** Check backtest status without blocking */
async function checkBacktestStatus(
  supabaseUrl: string,
  supabaseKey: string,
  backtestRunId: string,
): Promise<{ status: string; results?: any; error?: string; error_message?: string }> {
  const engineUrl = `${supabaseUrl}/functions/v1/backtest-engine`;

  const response = await fetch(engineUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ action: "status", runId: backtestRunId }),
  });

  if (!response.ok) {
    return { status: "error", error: `Status check failed (${response.status})` };
  }

  return await response.json();
}

// ─── Self-Invoke ───

async function selfInvoke(supabaseUrl: string, supabaseKey: string, body: any): Promise<void> {
  const url = `${supabaseUrl}/functions/v1/optimizer`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "x-cron-secret": Deno.env.get("CRON_SECRET") || "",
      },
      body: JSON.stringify(body),
    }).catch(e => console.error(`[optimizer] self-invoke fetch error:`, e));
  } catch (e) {
    console.error(`[optimizer] self-invoke failed:`, e);
  }
}

/** Self-invoke with a delay (uses setTimeout pattern via sleep + self-invoke) */
async function selfInvokeDelayed(supabaseUrl: string, supabaseKey: string, body: any, delayMs: number): Promise<void> {
  // Sleep within this invocation, then self-invoke
  // This keeps the function "active" (not idle) during the delay
  await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 5_000)));
  await selfInvoke(supabaseUrl, supabaseKey, body);
}

// ─── Helpers ───

function getDefaultStartDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function getDefaultEndDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getDefaultInstruments(): string[] {
  return ["EURUSD", "GBPUSD"];
}

function extractBacktestResult(results: any): BacktestResult {
  if (!results) {
    return { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 };
  }

  // Handle both array results (multi-instrument) and single result
  const summary = Array.isArray(results)
    ? results.reduce((acc: any, r: any) => ({
        totalTrades: (acc.totalTrades || 0) + (r.totalTrades || 0),
        winRate: r.winRate ?? acc.winRate ?? 0,
        profitFactor: r.profitFactor ?? acc.profitFactor ?? 0,
        expectancy: r.expectancy ?? acc.expectancy ?? 0,
        maxDrawdownPercent: Math.max(acc.maxDrawdownPercent || 0, r.maxDrawdownPercent || 0),
        netPnlPips: (acc.netPnlPips || 0) + (r.netPnlPips || 0),
        walkForward: r.walkForward ?? acc.walkForward,
      }), {})
    : results;

  return {
    totalTrades: summary.totalTrades ?? 0,
    winRate: summary.winRate ?? 0,
    profitFactor: summary.profitFactor ?? 0,
    expectancy: summary.expectancy ?? 0,
    maxDrawdownPercent: summary.maxDrawdownPercent ?? 0,
    netPnlPips: summary.netPnlPips ?? 0,
    walkForward: summary.walkForward,
  };
}
