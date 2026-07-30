import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronOrUserCaller } from "../_shared/cronAuth.ts";
import {
  resolveEffectiveRuntimeConfig,
} from "../_shared/runtimeConfigResolver.ts";
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

const BOT_ID = "smc";

function respond(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
  const { data, error } = await adminClient
    .from("bot_configs")
    .select("config_json")
    .eq("user_id", userId)
    .is("connection_id", null)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load bot configuration: ${error.message}`);
  }
  return resolveEffectiveRuntimeConfig(data?.config_json || null);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authError = await verifyCronOrUserCaller(req);
  if (authError) return authError;

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "refresh") {
      return respond({ error: "Unknown action" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const userId = await getUserId(req, supabaseUrl);
    if (!userId) return respond({ error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const styleResolution = await loadConfig(adminClient, userId);
    const config = styleResolution.config;
    const stylePolicy = await buildResolvedStylePolicy({
      resolution: styleResolution,
      config,
    });
    const timeframeAuthority = resolveTimeframeAuthority(stylePolicy);
    if (config.gamePlanEnabled === false) {
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
      symbols: config.instruments,
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
    if (!generation.complete) {
      return respond({
        error:
          "Game Plan refresh was incomplete; the previous complete plan remains active",
        missingSymbols: generation.missingSymbols,
        details: errors,
        source: sourceSummary,
      }, 503);
    }
    const instrumentPlans = generation.plans;

    let gamePlan = buildSessionGamePlan(currentSession, instrumentPlans);
    try {
      const newsEvents = await fetchNewsForGamePlan(
        supabaseUrl,
        serviceRoleKey,
        config.instruments,
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
    gamePlan = await persistActiveGamePlan(adminClient, gamePlan, {
      userId,
      botId: BOT_ID,
      source: "manual_refresh",
      configSnapshot: buildGamePlanConfigSnapshot(config, stylePolicy),
      marketDataSnapshot: {
        hierarchy: ["Twelve Data", "Polygon"],
        source: sourceSummary,
        generationErrors: errors,
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
      warnings: errors,
    });
  } catch (error: any) {
    console.error("[game-plan-refresh] Failed:", error?.message || error);
    return respond(
      { error: error?.message || "Game Plan refresh failed" },
      500,
    );
  }
});
