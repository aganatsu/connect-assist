import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronOrUserCaller } from "../_shared/cronAuth.ts";
import { loadEffectiveRuntimeConfig } from "../_shared/runtimeConfigStore.ts";
import { buildResolvedStylePolicy } from "../_shared/stylePolicy.ts";
import {
  bindTimeframeCandles,
  buildTimeframeCandleMap,
  resolveTimeframeAuthority,
  timeframeFetchRange,
} from "../_shared/timeframeAuthority.ts";
import {
  buildStyleDecisionEvidence,
} from "../_shared/styleDecisionEvidence.ts";
import { generateGamePlansWithRetry } from "../_shared/gamePlanGeneration.ts";
import { resolveGamePlanMarketScope } from "../_shared/gamePlanMarketScope.ts";
import {
  beginScanSourceTally,
  endScanSourceTally,
  fetchCandlesWithFallback,
} from "../_shared/candleSource.ts";
import { createScanCache } from "../_shared/dataCache.ts";
import {
  buildSessionGamePlan,
  enrichGamePlanWithNews,
  fetchNewsForGamePlan,
  formatGamePlanAuthoritySummary,
  generateInstrumentGamePlan,
  getCurrentSession,
  type InstrumentGamePlan,
} from "../_shared/gamePlan.ts";
import {
  applyGamePlanValidityWindow,
  buildGamePlanConfigSnapshot,
  enrichGamePlanWithDirectionalNews,
  persistActiveGamePlan,
} from "../_shared/gamePlanStore.ts";
import type { Candle } from "../_shared/smcAnalysis.ts";

import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";

setCreditCallerContext("game-plan-refresh");

const BOT_ID = "smc";

function respond(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function recordRefreshFailure(
  adminClient: any,
  userId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  const failedAt = new Date();
  await adminClient.from("game_plan_refresh_status").upsert({
    user_id: userId, bot_id: BOT_ID, status: "failed",
    last_attempt_at: failedAt.toISOString(),
    next_retry_at: new Date(failedAt.getTime() + 15 * 60 * 1000).toISOString(),
    failure_code: code, failure_message: message.slice(0, 1000),
    details, updated_at: failedAt.toISOString(),
  }, { onConflict: "user_id,bot_id" });
}

function getEntryInterval(entryTf: string): string {
  const map: Record<string, string> = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "15min": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "1h",
    "1d": "1d",
    "1day": "1d",
  };
  return map[entryTf] || "15m";
}

function getEntryRange(entryTf: string): string {
  const map: Record<string, string> = {
    "1m": "1d",
    "5m": "5d",
    "15m": "5d",
    "15min": "5d",
    "30m": "5d",
    "1h": "1mo",
    "4h": "1mo",
  };
  return map[entryTf] || "5d";
}

async function getUserId(
  req: Request,
  supabaseUrl: string,
): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await userClient.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;
  return String(data.claims.sub);
}

async function loadConfig(adminClient: any, userId: string) {
  return await loadEffectiveRuntimeConfig(adminClient, { userId });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authError = await verifyCronOrUserCaller(req);
  if (authError) return authError;

  let refreshAdmin: any = null;
  let refreshUserId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "refresh") {
      return respond({ error: "Unknown action" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const cronRequest = req.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET");
    const authenticatedUserId = await getUserId(req, supabaseUrl);
    const userId = cronRequest && body.source === "scheduled"
      ? String(body.userId || "")
      : authenticatedUserId;
    if (!userId) return respond({ error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    refreshAdmin = adminClient;
    refreshUserId = userId;
    const attemptAt = new Date();
    await adminClient.from("game_plan_refresh_status").upsert({
      user_id: userId, bot_id: BOT_ID, status: "running",
      last_attempt_at: attemptAt.toISOString(), failure_code: null,
      failure_message: null, updated_at: attemptAt.toISOString(),
    }, { onConflict: "user_id,bot_id" });

    if (body.source === "scheduled") {
      const { data: latestPlan } = await adminClient.from("active_game_plans")
        .select("generated_at,expires_at").eq("user_id", userId)
        .eq("bot_id", BOT_ID).eq("is_active", true)
        .order("generated_at", { ascending: false }).limit(1).maybeSingle();
      if (latestPlan?.generated_at && latestPlan?.expires_at) {
        const generatedAt = Date.parse(latestPlan.generated_at);
        const expiresAt = Date.parse(latestPlan.expires_at);
        const refreshAt = generatedAt + (expiresAt - generatedAt) * 0.75;
        if (Date.now() < refreshAt) {
          await adminClient.from("game_plan_refresh_status").upsert({
            user_id: userId, bot_id: BOT_ID, status: "skipped",
            last_attempt_at: attemptAt.toISOString(),
            next_retry_at: new Date(refreshAt).toISOString(),
            active_plan_expires_at: latestPlan.expires_at,
            details: { reason: "active_plan_inside_refresh_window" },
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id,bot_id" });
          return respond({ success: true, skipped: true, nextRetryAt: new Date(refreshAt).toISOString() });
        }
      }
    }
    const styleResolution = await loadConfig(adminClient, userId);
    const config = styleResolution.config;
    const stylePolicy = await buildResolvedStylePolicy({
      resolution: styleResolution,
      config,
    });
    const timeframeAuthority = resolveTimeframeAuthority(stylePolicy);
    if (config.gamePlanEnabled === false) {
      await recordRefreshFailure(adminClient, userId, "game_plan_disabled", "Game Plan is disabled in bot configuration");
      return respond(
        { error: "Game Plan is disabled in bot configuration" },
        409,
      );
    }

    beginScanSourceTally();
    const fetchCandles = async (
      symbol: string,
      interval: string,
      _range: string,
    ): Promise<Candle[]> => {
      const result = await fetchCandlesWithFallback({
        symbol,
        interval,
        limit: 300,
        skipBroker: true,
      });
      return result.candles;
    };
    const scanCache = createScanCache(fetchCandles);
    const retryCache = createScanCache(fetchCandles);
    const currentSession = getCurrentSession();
    const marketScope = resolveGamePlanMarketScope(
      config.instruments,
      new Date(),
    );
    if (marketScope.eligibleSymbols.length === 0) {
      await recordRefreshFailure(adminClient, userId, "no_open_instruments", "No enabled instruments are open for Game Plan generation in the current market window", { marketScope });
      return respond({
        error:
          "No enabled instruments are open for Game Plan generation in the current market window",
        marketScope,
      }, 409);
    }
    const generateForSymbol = async (
      symbol: string,
      cache: ReturnType<typeof createScanCache>,
    ): Promise<InstrumentGamePlan> => {
      const [daily, h4, entry, hourly, bias, structure, setup] = await Promise
        .all([
          cache.get(symbol, "1d", "1y"),
          cache.get(symbol, "4h", "1mo"),
          cache.get(
            symbol,
            getEntryInterval(config.entryTimeframe),
            getEntryRange(config.entryTimeframe),
          ),
          cache.get(symbol, "1h", "5d"),
          cache.get(
            symbol,
            timeframeAuthority.roles.bias,
            timeframeFetchRange(timeframeAuthority.roles.bias),
          ),
          cache.get(
            symbol,
            timeframeAuthority.roles.structure,
            timeframeFetchRange(timeframeAuthority.roles.structure),
          ),
          cache.get(
            symbol,
            timeframeAuthority.roles.setup,
            timeframeFetchRange(timeframeAuthority.roles.setup),
          ),
        ]);
      if (daily.length < 10 || entry.length < 10) {
        throw new Error(
          `Insufficient candle history (daily=${daily.length}, entry=${entry.length})`,
        );
      }
      const decisionEvidence = buildStyleDecisionEvidence(
        timeframeAuthority,
        bindTimeframeCandles(
          timeframeAuthority,
          buildTimeframeCandleMap([
            { timeframe: timeframeAuthority.roles.bias, candles: bias },
            {
              timeframe: timeframeAuthority.roles.structure,
              candles: structure,
            },
            { timeframe: timeframeAuthority.roles.setup, candles: setup },
            {
              timeframe: getEntryInterval(config.entryTimeframe),
              candles: entry,
            },
          ]),
        ),
        {
          h4ChochLookback: config.simpleDirectionH4ChochLookback,
          h1BosLookback: config.simpleDirectionH1BosLookback,
          confirmedTrendFibFactor: config.confirmedTrendFibFactor,
          confirmedTrendSwingLookback: config.confirmedTrendSwingLookback,
          useConfirmedTrend: config.useConfirmedTrend,
        },
      );
      return generateInstrumentGamePlan(
        symbol,
        daily,
        h4,
        entry,
        hourly,
        currentSession,
        {
          ipdaRangesEnabled: config.ipdaRangesEnabled !== false,
          equalHighsLowsSensitivity: config.equalHighsLowsSensitivity,
          liquidityPoolMinTouches: config.liquidityPoolMinTouches,
          decisionEvidence,
        },
      );
    };
    const generation = await generateGamePlansWithRetry({
      symbols: marketScope.eligibleSymbols,
      batchSize: 3,
      batchDelayMs: 1_200,
      retryDelayMs: 1_500,
      generate: (symbol, attempt) =>
        generateForSymbol(symbol, attempt === 1 ? scanCache : retryCache),
    });
    const sourceSummary = endScanSourceTally();
    const errors = generation.failures.map(({ symbol, attempt, error }) => ({
      symbol,
      attempt,
      error,
    }));
    // A symbol whose every attempt returned zero candles is a data-provider
    // coverage gap (e.g. index feeds not enabled), not a transient failure.
    // Those symbols are excluded from the scope so one unsupported instrument
    // cannot block an otherwise complete plan.
    const dataUnavailableSymbols = generation.missingSymbols.filter((symbol) => {
      const attempts = generation.failures.filter((f) => f.symbol === symbol);
      return attempts.length > 0 &&
        attempts.every((f) => /daily=0/.test(f.error));
    });
    const unavailableSet = new Set(dataUnavailableSymbols);
    const blockingMissing = generation.missingSymbols.filter((symbol) =>
      !unavailableSet.has(symbol)
    );
    if (blockingMissing.length > 0 || generation.plans.length === 0) {
      await recordRefreshFailure(adminClient, userId, "incomplete_market_data", "Game Plan refresh was incomplete; the previous complete plan remains active", { missingSymbols: generation.missingSymbols, errors, marketScope });
      return respond({
        error:
          "Game Plan refresh was incomplete; the previous complete plan remains active",
        missingSymbols: generation.missingSymbols,
        details: errors,
        source: sourceSummary,
        marketScope,
      }, 503);
    }
    if (dataUnavailableSymbols.length > 0) {
      console.warn(
        `[game-plan-refresh] Excluding symbols with no provider data: ${
          dataUnavailableSymbols.join(", ")
        }`,
      );
      marketScope.eligibleSymbols = marketScope.eligibleSymbols.filter(
        (symbol) => !unavailableSet.has(symbol),
      );
      marketScope.excludedSymbols = [
        ...marketScope.excludedSymbols,
        ...dataUnavailableSymbols,
      ];
    }
    const instrumentPlans = generation.plans;

    let gamePlan = buildSessionGamePlan(currentSession, instrumentPlans);
    try {
      const newsEvents = await fetchNewsForGamePlan(
        supabaseUrl,
        serviceRoleKey,
        marketScope.eligibleSymbols,
      );
      gamePlan = enrichGamePlanWithNews(gamePlan, newsEvents);
      gamePlan = enrichGamePlanWithDirectionalNews(gamePlan);
    } catch (error: any) {
      console.warn(
        `[game-plan-refresh] News enrichment failed: ${
          error?.message || error
        }`,
      );
    }

    gamePlan = applyGamePlanValidityWindow(
      gamePlan,
      stylePolicy,
    );
    gamePlan.summary = formatGamePlanAuthoritySummary(gamePlan);
    gamePlan = await persistActiveGamePlan(adminClient, gamePlan, {
      userId,
      botId: BOT_ID,
      source: "manual_refresh",
      configSnapshot: buildGamePlanConfigSnapshot(
        config,
        stylePolicy,
        styleResolution.provenance,
      ),
      marketDataSnapshot: {
        hierarchy: ["Twelve Data", "Polygon"],
        source: sourceSummary,
        generationErrors: errors,
        gamePlanMarketScope: marketScope,
      },
    });
    const tradeableCount = gamePlan.plans.filter((plan) =>
      plan.state === "tradeable"
    ).length;
    const waitCount = gamePlan.plans.filter((plan) =>
      plan.state === "wait"
    ).length;
    const skipCount = gamePlan.plans.filter((plan) =>
      plan.state === "skip"
    ).length;
    await adminClient.from("game_plan_refresh_status").upsert({
      user_id: userId, bot_id: BOT_ID, status: "succeeded",
      last_attempt_at: attemptAt.toISOString(), last_success_at: new Date().toISOString(),
      next_retry_at: gamePlan.validityPolicy?.expiresAt
        ? new Date(Date.parse(gamePlan.generatedAt) + (Date.parse(gamePlan.validityPolicy.expiresAt) - Date.parse(gamePlan.generatedAt)) * 0.75).toISOString()
        : null,
      active_plan_expires_at: gamePlan.validityPolicy?.expiresAt || null,
      failure_code: null, failure_message: null,
      details: { source: body.source === "scheduled" ? "scheduled" : "manual", planVersion: gamePlan.planVersion },
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,bot_id" });

    return respond({
      success: true,
      id: gamePlan.planVersion,
      generatedAt: gamePlan.generatedAt,
      scannedAt: gamePlan.generatedAt,
      session: currentSession,
      planCount: gamePlan.plans.length,
      tradeableCount,
      waitCount,
      skipCount,
      source: sourceSummary,
      planVersion: gamePlan.planVersion,
      validityPolicy: gamePlan.validityPolicy,
      runtimeConfigProvenance: styleResolution.provenance,
      warnings: errors,
      marketScope,
    });
  } catch (error: any) {
    const message = String(error?.message || error || "");
    // A market-data outage (provider DNS failure, exhausted credit budget, no
    // candles) is upstream unavailability, not an app fault: answer 503 so the
    // caller retries and keeps the previous complete plan, instead of 500.
    const upstreamUnavailable =
      /dns error|failed to lookup address|all sources failed|insufficient candle history|budget exhausted|rate limit|429|timeout|network error|fetch failed/i
        .test(message);
    if (refreshAdmin && refreshUserId) {
      await recordRefreshFailure(
        refreshAdmin,
        refreshUserId,
        upstreamUnavailable ? "incomplete_market_data" : "refresh_failed",
        message,
      );
    }
    console.error("[game-plan-refresh] Failed:", message);
    return respond(
      {
        error: upstreamUnavailable
          ? `Market data is temporarily unavailable; the previous plan remains active (${message})`
          : (message || "Game Plan refresh failed"),
        transient: upstreamUnavailable,
      },
      upstreamUnavailable ? 503 : 500,
    );
  }

});
