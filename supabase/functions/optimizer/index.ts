/**
 * optimizer — Supabase Edge Function (Chunked Self-Invocation)
 * ──────────────────────────────────────────────────────────────────────
 * Runs the TPE optimization loop in chunks of TRIALS_PER_CHUNK trials,
 * persisting state to the optimizer_runs table between invocations.
 * 
 * Flow:
 *   1. "start" action → creates run, evaluates baseline, self-invokes chunk 0
 *   2. "chunk" action → runs TRIALS_PER_CHUNK trials, persists state, self-invokes next chunk
 *   3. Final chunk → evaluates results, auto-applies if gates pass, sends notification
 * 
 * This pattern keeps each invocation under Supabase's 400s wall-clock limit
 * while supporting 50+ total trials across multiple invocations.
 * 
 * Endpoint: POST /functions/v1/optimizer
 * Actions:
 *   { action: "start", userId?, dryRun?, trials?, coreOnly?, source? }
 *   { action: "chunk", runId, chunkIndex }
 *   { action: "status", runId }
 *   { action: "cancel", runId }
 * 
 * Auth: Service role key (this function is NOT user-facing directly)
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { TPEOptimizer } from "./lib/tpe.ts";
import type { ParameterSpec, Trial, TPEConfig } from "./lib/tpe.ts";
import {
  computeCompositeScore,
} from "./lib/optimizationLoop.ts";
import type { OptimizationConfig, BacktestResult, TrialResult, OptimizationResult } from "./lib/optimizationLoop.ts";
import { createHTTPBacktestRunner, fetchCurrentConfig } from "./lib/backtestRunner.ts";
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

/** Trials per invocation — keeps each chunk well under 400s */
const TRIALS_PER_CHUNK = 3;

/** Max wall-clock per invocation before forcing a persist + chain (safety net) */
const MAX_INVOCATION_MS = 280_000; // 280s — leaves 120s buffer

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

// ─── Partial State Shape (persisted between chunks) ───

interface OptimizerPartialState {
  /** Serialized TPE state (trials + RNG) */
  tpeState: { trials: Trial[]; nextId: number; rngState: number[]; config: TPEConfig };
  /** Baseline trial result */
  baseline: TrialResult;
  /** All completed trial results so far */
  completedTrials: TrialResult[];
  /** Best passing trial so far */
  bestPassingTrial: TrialResult | null;
  /** Baseline params (for enforceMaxDelta) */
  baselineParams: Record<string, number | string | boolean>;
  /** Total trials to run */
  maxTrials: number;
  /** Trials completed so far */
  trialsCompleted: number;
  /** Full optimization config */
  config: OptimizationConfig;
  /** Current config row from DB */
  currentConfig: Record<string, any>;
  /** Whether this is a dry run */
  dryRun: boolean;
  /** Run start timestamp */
  startTime: number;
  /** Use full or core param space */
  fullSpace: boolean;
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !supabaseKey) {
    return respond({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  const db = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "start";
    // Pipe auth header into body so handlers can derive userId from JWT
    body._authHeader = req.headers.get("authorization") ?? "";

    switch (action) {
      case "start":
        return await handleStart(db, supabaseUrl, supabaseKey, body);
      case "chunk":
        return await handleChunk(db, supabaseUrl, supabaseKey, body);
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

  // Fallback: derive userId from JWT `sub` claim in Authorization header
  let jwtUserId: string | undefined;
  try {
    const auth = (body._authHeader as string | undefined) ?? "";
    const headerAuth = auth || "";
    const token = headerAuth.replace(/^Bearer\s+/i, "");
    if (token && token.split(".").length === 3) {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload?.sub) jwtUserId = payload.sub;
    }
  } catch { /* ignore */ }

  // Load optimizer config from file
  let fileConfig: Partial<OptimizationConfig> = {};
  try {
    const configText = await Deno.readTextFile(new URL("./config.json", import.meta.url).pathname);
    fileConfig = JSON.parse(configText);
  } catch { /* use defaults */ }

  const targetUserId = userId || jwtUserId || fileConfig.userId;
  if (!targetUserId) {
    return respond({ error: "userId is required (in body or config.json)" }, 400);
  }

  // Deduplication: check if already ran this week (only for cron triggers)
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
      console.log(`[optimizer] Skipping — already ran this week (run: ${recentRuns[0].id})`);
      return respond({ status: "skipped", reason: "Already ran this week", lastRunId: recentRuns[0].id });
    }
  }

  // Build config
  const maxTrials = trials ?? fileConfig.maxTrials ?? 50;
  const fullSpace = !coreOnly && (fileConfig.fullSpace ?? true);
  const config: OptimizationConfig = {
    maxTrials,
    walkForwardFolds: fileConfig.walkForwardFolds ?? 4,
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
  console.log(`[optimizer:${runId}] Starting (source: ${source}, trials: ${maxTrials}, chunks of ${TRIALS_PER_CHUNK})`);

  // Initialize TPE and evaluate baseline
  const paramSpace = fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  const baselineParams = configToParams(currentConfig.config_json || currentConfig);

  const tpe = new TPEOptimizer(paramSpace, {
    ...config.tpeConfig,
    seed: config.seed,
    nStartupTrials: Math.min(10, Math.floor(maxTrials * 0.3)),
  });

  // Run baseline backtest
  const runBacktest = createHTTPBacktestRunner(
    { supabaseUrl, supabaseKey, timeoutMs: 600_000, pollIntervalMs: 5_000, verbose: false },
    { userId: config.userId, configId: config.configId, instruments: config.instruments, startDate: config.startDate, endDate: config.endDate, walkForwardFolds: config.walkForwardFolds },
  );

  const baselineConfig = paramsToConfig(baselineParams, {});
  baselineConfig.walkForwardFolds = config.walkForwardFolds;

  let baselineBacktest: BacktestResult;
  try {
    baselineBacktest = await runBacktest(baselineConfig);
  } catch (err) {
    await db.from("optimizer_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: `Baseline backtest failed: ${(err as Error).message}`,
    }).eq("id", runId);
    return respond({ error: `Baseline backtest failed: ${(err as Error).message}` }, 500);
  }

  const baselineScore = computeCompositeScore(baselineBacktest);
  const baselineTrial: TrialResult = {
    trial: { id: -1, params: baselineParams, score: baselineScore, timestamp: Date.now() },
    backtest: baselineBacktest,
    compositeScore: baselineScore,
    violations: [],
    walkForwardPassed: (baselineBacktest.walkForward?.consistencyScore ?? 0) >= config.minConsistencyScore,
  };

  // Warm-start TPE with baseline
  tpe.tell(baselineParams, baselineScore);

  // Build partial state
  const partialState: OptimizerPartialState = {
    tpeState: tpe.serialize(),
    baseline: baselineTrial,
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
  };

  // Persist state and chain to chunk 0
  await db.from("optimizer_runs").update({
    progress: 5,
    progress_message: `Baseline evaluated (score: ${baselineScore.toFixed(2)}). Starting trials...`,
    result_summary: { partial_state: partialState },
    baseline_score: baselineScore,
  }).eq("id", runId);

  // Self-invoke chunk 0
  await selfInvoke(supabaseUrl, supabaseKey, { action: "chunk", runId, chunkIndex: 0 });

  return respond({ runId, status: "running", message: "Optimization started, processing in chunks" });
}

// ─── Action: CHUNK ───

async function handleChunk(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  body: any,
): Promise<Response> {
  const { runId, chunkIndex } = body;
  if (!runId) return respond({ error: "runId required" }, 400);

  const INVOCATION_START = Date.now();

  // Load run state
  const { data: run } = await db.from("optimizer_runs")
    .select("status, result_summary, user_id")
    .eq("id", runId)
    .single();

  if (!run) return respond({ error: "Run not found" }, 404);
  if (run.status === "cancelled") return respond({ status: "cancelled" });
  if (run.status !== "running") return respond({ error: `Run is ${run.status}, not running` }, 400);

  // Restore partial state
  const partialState: OptimizerPartialState = run.result_summary?.partial_state;
  if (!partialState) {
    return respond({ error: "No partial state found — run may be corrupted" }, 500);
  }

  const { config, baselineParams, maxTrials, dryRun, fullSpace, currentConfig, startTime } = partialState;
  let { trialsCompleted, completedTrials, bestPassingTrial } = partialState;

  // Restore TPE from serialized state
  const paramSpace = fullSpace ? getFullParameterSpace() : getCoreParameterSpace();
  const tpe = TPEOptimizer.restore(paramSpace, partialState.tpeState);

  // Create backtest runner
  const runBacktest = createHTTPBacktestRunner(
    { supabaseUrl, supabaseKey, timeoutMs: 600_000, pollIntervalMs: 5_000, verbose: false },
    { userId: config.userId, configId: config.configId, instruments: config.instruments, startDate: config.startDate, endDate: config.endDate, walkForwardFolds: config.walkForwardFolds },
  );

  // Run trials for this chunk
  const trialsThisChunk = Math.min(TRIALS_PER_CHUNK, maxTrials - trialsCompleted);
  console.log(`[optimizer:${runId}] Chunk ${chunkIndex}: running ${trialsThisChunk} trials (${trialsCompleted}/${maxTrials} done)`);

  for (let i = 0; i < trialsThisChunk; i++) {
    // Time-box safety: if approaching limit, persist and chain
    if (Date.now() - INVOCATION_START > MAX_INVOCATION_MS) {
      console.log(`[optimizer:${runId}] Time-box hit at trial ${trialsCompleted}. Persisting and chaining.`);
      break;
    }

    // Check cancellation
    const { data: statusCheck } = await db.from("optimizer_runs").select("status").eq("id", runId).single();
    if (statusCheck?.status === "cancelled") {
      console.log(`[optimizer:${runId}] Cancelled by user.`);
      return respond({ status: "cancelled" });
    }

    // Sample candidate from TPE
    let candidateParams = tpe.ask();

    // Enforce max delta from baseline
    candidateParams = enforceMaxDelta(candidateParams, baselineParams, config.maxDeltaPercent) as Record<string, number | string | boolean>;

    // Validate constraints
    const violations = validateParams(candidateParams);
    if (violations.length > 0) {
      const trial = tpe.tell(candidateParams, 0);
      completedTrials.push({
        trial,
        backtest: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 },
        compositeScore: 0,
        violations,
        walkForwardPassed: false,
      });
      trialsCompleted++;
      continue;
    }

    // Build config and run backtest
    const candidateConfig = paramsToConfig(candidateParams, {});
    candidateConfig.walkForwardFolds = config.walkForwardFolds;
    candidateConfig.startDate = config.startDate;
    candidateConfig.endDate = config.endDate;
    candidateConfig.instruments = config.instruments;

    let backtestResult: BacktestResult;
    try {
      backtestResult = await runBacktest(candidateConfig);
    } catch (err) {
      const trial = tpe.tell(candidateParams, 0);
      completedTrials.push({
        trial,
        backtest: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdownPercent: 0, netPnlPips: 0 },
        compositeScore: 0,
        violations: [`Backtest error: ${(err as Error).message}`],
        walkForwardPassed: false,
      });
      trialsCompleted++;
      continue;
    }

    // Score and record
    const score = computeCompositeScore(backtestResult);
    const trial = tpe.tell(candidateParams, score);
    const wfPassed = (backtestResult.walkForward?.consistencyScore ?? 0) >= config.minConsistencyScore;

    const trialResult: TrialResult = {
      trial,
      backtest: backtestResult,
      compositeScore: score,
      violations: [],
      walkForwardPassed: wfPassed,
    };
    completedTrials.push(trialResult);
    trialsCompleted++;

    // Track best passing trial
    if (wfPassed && score > (bestPassingTrial?.compositeScore ?? 0)) {
      bestPassingTrial = trialResult;
    }
  }

  // Calculate progress
  const progress = Math.round(10 + (trialsCompleted / maxTrials) * 85);
  const bestScore = bestPassingTrial?.compositeScore ?? partialState.baseline.compositeScore;

  // Check if we're done
  if (trialsCompleted >= maxTrials) {
    // ── FINAL: evaluate and auto-apply ──
    return await handleFinalize(db, supabaseUrl, supabaseKey, runId, {
      ...partialState,
      trialsCompleted,
      completedTrials,
      bestPassingTrial,
    });
  }

  // ── NOT DONE: persist state and chain to next chunk ──
  const updatedState: OptimizerPartialState = {
    ...partialState,
    tpeState: tpe.serialize(),
    completedTrials,
    bestPassingTrial,
    trialsCompleted,
  };

  await db.from("optimizer_runs").update({
    progress,
    progress_message: `Trial ${trialsCompleted}/${maxTrials} — best: ${bestScore.toFixed(2)}`,
    trials_count: trialsCompleted,
    best_score: bestPassingTrial?.compositeScore ?? null,
    result_summary: { partial_state: updatedState },
  }).eq("id", runId);

  // Self-invoke next chunk
  await selfInvoke(supabaseUrl, supabaseKey, { action: "chunk", runId, chunkIndex: chunkIndex + 1 });

  return respond({ status: "running", trialsCompleted, maxTrials, chunkIndex });
}

// ─── Finalize (called after last chunk) ───

async function handleFinalize(
  db: SupabaseClient,
  supabaseUrl: string,
  supabaseKey: string,
  runId: string,
  state: OptimizerPartialState,
): Promise<Response> {
  const { baseline, completedTrials, bestPassingTrial, config, currentConfig, dryRun, startTime } = state;
  const baselineScore = baseline.compositeScore;

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

  // Build result
  const result: OptimizationResult = {
    trials: completedTrials,
    bestTrial: bestPassingTrial,
    baseline,
    autoApplied,
    improvementPercent,
    durationMs,
    rejectReason,
  };

  // Auto-apply
  let applyOutcome = "skipped";
  if (!dryRun && autoApplied) {
    const applyResult = await autoApplyResult(result, currentConfig, {
      supabaseUrl,
      supabaseKey,
      userId: config.userId,
      configId: config.configId,
    });
    applyOutcome = applyResult.applied ? "applied" : "rejected";
  } else if (dryRun && autoApplied) {
    applyOutcome = "dry_run_would_apply";
  }

  // Record completion (clear partial_state from result_summary)
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
      totalChunks: Math.ceil(state.maxTrials / TRIALS_PER_CHUNK),
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

// ─── Self-Invoke ───

async function selfInvoke(supabaseUrl: string, supabaseKey: string, body: any): Promise<void> {
  const url = `${supabaseUrl}/functions/v1/optimizer`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
      },
      body: JSON.stringify(body),
    }).catch(e => console.error(`[optimizer] self-invoke fetch error:`, e));
  } catch (e) {
    console.error(`[optimizer] self-invoke failed:`, e);
  }
}

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
