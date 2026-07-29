import type {
  GamePlanValidityPolicy,
  InstrumentGamePlan,
  SessionGamePlan,
  SessionName,
} from "./gamePlan.ts";
import { analyzeNewsImpact, getNewsPairBias } from "./newsImpact.ts";
import type { ResolvedStylePolicy } from "./stylePolicy.ts";

export const GAME_PLAN_CONTRACT_VERSION = "phase3.v1";
export const GAME_PLAN_VALIDITY_CONTRACT_VERSION =
  "gameplan-validity.v1" as const;

export type GamePlanGenerationSource = "automatic_scan" | "manual_refresh";

export interface PersistGamePlanOptions {
  userId: string;
  botId: string;
  source: GamePlanGenerationSource;
  configSnapshot: Record<string, unknown>;
  marketDataSnapshot?: Record<string, unknown>;
}

export interface ActiveGamePlanRow {
  id: string;
  user_id: string;
  bot_id: string;
  plan_version: string;
  symbol: string;
  session: SessionName;
  bias: "bullish" | "bearish" | "neutral";
  bias_confidence: number | string;
  v2_conviction:
    | InstrumentGamePlan["conviction"]
    | Record<string, unknown>
    | null;
  state: "tradeable" | "wait" | "skip";
  state_reason: string | null;
  generated_at: string;
  expires_at: string;
  invalidation_conditions: unknown[] | null;
  source_candle_timestamps: Record<string, string | null> | null;
  plan_json: InstrumentGamePlan;
  focus_pairs: string[] | null;
  news_events: unknown[] | null;
  news_impacts: unknown[] | null;
  summary: string | null;
  generation_source: GamePlanGenerationSource;
  config_snapshot: Record<string, unknown> | null;
  market_data_snapshot: Record<string, unknown> | null;
  is_active: boolean;
}

function asNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildGamePlanConfigSnapshot(
  config: any,
  stylePolicy?: ResolvedStylePolicy | null,
): Record<string, unknown> {
  return {
    instruments: Array.isArray(config?.instruments)
      ? [...config.instruments]
      : [],
    entryTimeframe: config?.entryTimeframe ?? "15m",
    gamePlanValidityMinutes: Number(
      stylePolicy?.lifecycle.gamePlanValidityMinutes ??
        config?.gamePlanValidityMinutes,
    ) || 240,
    ipdaRangesEnabled: config?.ipdaRangesEnabled !== false,
    equalHighsLowsSensitivity: config?.equalHighsLowsSensitivity,
    liquidityPoolMinTouches: config?.liquidityPoolMinTouches,
    stylePolicy: stylePolicy || null,
  };
}

export function applyGamePlanValidityWindow(
  gamePlan: SessionGamePlan,
  stylePolicy: Pick<ResolvedStylePolicy, "style" | "lifecycle">,
): SessionGamePlan {
  const configuredMinutes = Number(
    stylePolicy.lifecycle.gamePlanValidityMinutes,
  );
  const durationMinutes =
    Number.isFinite(configuredMinutes) && configuredMinutes > 0
      ? Math.trunc(configuredMinutes)
      : 240;
  const validFrom = gamePlan.generatedAt;
  const expiresAt = new Date(
    new Date(validFrom).getTime() + durationMinutes * 60 * 1000,
  ).toISOString();
  const validityPolicy: GamePlanValidityPolicy = {
    contractVersion: GAME_PLAN_VALIDITY_CONTRACT_VERSION,
    style: stylePolicy.style,
    durationMinutes,
    validFrom,
    expiresAt,
  };
  return {
    ...gamePlan,
    validityPolicy,
    plans: gamePlan.plans.map((plan) => ({
      ...plan,
      expiresAt,
      validityPolicy,
    })),
  };
}

export interface GamePlanReuseDecision {
  reusable: boolean;
  reason: string;
  expiresAt: string | null;
}

/**
 * A version can be reused only when its immutable validity policy still
 * matches the active style and session. This prevents a saved style change
 * from continuing to authorize candidates under the previous plan.
 */
export function evaluateGamePlanReuse(
  gamePlan: SessionGamePlan | null,
  input: {
    session: SessionName;
    style: ResolvedStylePolicy["style"];
    now?: Date;
  },
): GamePlanReuseDecision {
  if (!gamePlan) {
    return { reusable: false, reason: "no active plan", expiresAt: null };
  }
  const expiresAt = gamePlan.validityPolicy?.expiresAt ||
    gamePlan.plans
      .map((plan) => plan.expiresAt)
      .filter((value): value is string => !!value)
      .sort()[0] ||
    null;
  if (gamePlan.session !== input.session) {
    return {
      reusable: false,
      reason: `session changed (${gamePlan.session} → ${input.session})`,
      expiresAt,
    };
  }
  const planStyle = gamePlan.validityPolicy?.style ||
    gamePlan.plans[0]?.decisionEvidence?.style ||
    null;
  if (planStyle && planStyle !== input.style) {
    return {
      reusable: false,
      reason: `style changed (${planStyle} → ${input.style})`,
      expiresAt,
    };
  }
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    return {
      reusable: false,
      reason: "plan expiry is unavailable",
      expiresAt,
    };
  }
  if ((input.now || new Date()).getTime() >= Date.parse(expiresAt)) {
    return { reusable: false, reason: "plan expired", expiresAt };
  }
  return {
    reusable: true,
    reason: `valid ${input.style} plan`,
    expiresAt,
  };
}

/**
 * Apply the same directional-news interpretation to manual and automatic
 * refreshes. News remains context: it annotates the plan and feeds the
 * existing news-alignment gate without rewriting the Gameplan bias.
 */
export function enrichGamePlanWithDirectionalNews(
  gamePlan: SessionGamePlan,
): SessionGamePlan {
  if (!gamePlan.newsEvents?.length) return gamePlan;
  const impacts = analyzeNewsImpact(gamePlan.newsEvents.map((event) => ({
    name: event.event,
    currency: event.currency,
    impact: event.impact,
    scheduledTime: event.time,
    forecast: event.forecast,
    previous: event.previous,
  })));
  const impactSummaries = impacts
    .filter((impact) =>
      impact.directionalImpact !== "unknown" &&
      impact.directionalImpact !== "neutral"
    )
    .map((impact) => impact.reasoning);

  const plans = gamePlan.plans.map((plan) => {
    const pairBias = getNewsPairBias(plan.symbol, impacts);
    const aligned =
      (plan.bias === "bullish" && pairBias.pairBias === "bullish") ||
      (plan.bias === "bearish" && pairBias.pairBias === "bearish");
    const opposed = plan.bias !== "neutral" &&
      pairBias.pairBias !== "neutral" &&
      !aligned;
    return {
      ...plan,
      newsBias: {
        pairBias: pairBias.pairBias,
        strength: pairBias.netStrength,
        summary: pairBias.summary,
        baseBias: pairBias.baseBias.bias,
        quoteBias: pairBias.quoteBias.bias,
      },
      ...(pairBias.netStrength >= 40 && aligned
        ? { newsConfirmation: `NEWS CONFIRMS: ${pairBias.summary}` }
        : {}),
      ...(pairBias.netStrength >= 40 && opposed
        ? { newsConflict: `⚠ NEWS CONFLICTS: ${pairBias.summary}` }
        : {}),
    } as InstrumentGamePlan;
  });

  return {
    ...gamePlan,
    plans,
    summary: impactSummaries.length > 0
      ? `${gamePlan.summary}\n\n📊 News Impact Analysis:\n${
        impactSummaries.join("\n")
      }`
      : gamePlan.summary,
    newsImpacts: impacts.map((impact) => ({
      name: impact.event.name,
      currency: impact.event.currency,
      impact: impact.event.impact,
      directionalImpact: impact.directionalImpact,
      confidence: impact.confidence,
      reasoning: impact.reasoning,
      category: impact.category,
      actual: impact.event.actual,
      forecast: impact.event.forecast,
      previous: impact.event.previous,
    })),
  } as SessionGamePlan;
}

/**
 * Rebuild the canonical SessionGamePlan from dedicated storage rows.
 * This is shared by automatic scans, fast confirmation, and tests so every
 * consumer reads the same version and instrument IDs.
 */
export function rowsToSessionGamePlan(
  rows: ActiveGamePlanRow[],
): SessionGamePlan | null {
  if (!rows.length) return null;
  const first = rows[0];
  const plans = rows.map((row) => ({
    ...(row.plan_json || {}),
    gamePlanId: row.id,
    planVersion: row.plan_version,
    symbol: row.symbol,
    session: row.session,
    bias: row.bias,
    biasConfidence: asNumber(row.bias_confidence),
    conviction:
      (row.v2_conviction || row.plan_json?.conviction) as InstrumentGamePlan[
        "conviction"
      ],
    state: row.state,
    stateReason: row.state_reason || row.plan_json?.stateReason,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    invalidationConditions: (row.invalidation_conditions as string[] | null) ||
      row.plan_json?.invalidationConditions ||
      [],
    sourceCandleTimestamps: (row
      .source_candle_timestamps as InstrumentGamePlan[
        "sourceCandleTimestamps"
      ]) ||
      row.plan_json?.sourceCandleTimestamps,
  })) as InstrumentGamePlan[];

  return {
    planVersion: first.plan_version,
    source: first.generation_source,
    contractVersion: GAME_PLAN_CONTRACT_VERSION,
    session: first.session,
    generatedAt: first.generated_at,
    validityPolicy: first.plan_json?.validityPolicy,
    focusPairs: first.focus_pairs || [],
    plans,
    newsEvents: (first.news_events || []) as SessionGamePlan["newsEvents"],
    summary: first.summary || "",
    ...((first.news_impacts?.length ?? 0) > 0
      ? { newsImpacts: first.news_impacts }
      : {}),
  } as SessionGamePlan;
}

export function gamePlanToScanLogDetails(
  gamePlan: SessionGamePlan,
  source: GamePlanGenerationSource,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "game_plan",
    source,
    contract_version: GAME_PLAN_CONTRACT_VERSION,
    plan_version: gamePlan.planVersion,
    session: gamePlan.session,
    generated_at: gamePlan.generatedAt,
    validity_policy: gamePlan.validityPolicy || null,
    focus_pairs: gamePlan.focusPairs,
    plans: gamePlan.plans.map((plan) => ({
      ...plan,
      keyLevels: plan.keyLevels?.slice(0, 10) || [],
    })),
    newsEvents: gamePlan.newsEvents || [],
    newsImpacts: (gamePlan as any).newsImpacts || [],
    summary: gamePlan.summary,
    ...extras,
  };
}

export async function persistActiveGamePlan(
  client: any,
  gamePlan: SessionGamePlan,
  options: PersistGamePlanOptions,
): Promise<SessionGamePlan> {
  const planVersion = crypto.randomUUID();
  const versionedPlan: SessionGamePlan = {
    ...gamePlan,
    planVersion,
    source: options.source,
    contractVersion: GAME_PLAN_CONTRACT_VERSION,
    plans: gamePlan.plans.map((plan) => ({
      ...plan,
      planVersion,
      invalidationConditions: plan.invalidationConditions ||
        plan.scenarios?.map((scenario) => scenario.invalidation).filter(
          (value): value is string => !!value,
        ) ||
        [],
    })),
  };

  const { data, error } = await client.rpc("activate_game_plan_version", {
    p_user_id: options.userId,
    p_bot_id: options.botId,
    p_plan_version: planVersion,
    p_source: options.source,
    p_config_snapshot: options.configSnapshot,
    p_market_data_snapshot: options.marketDataSnapshot || {},
    p_session_plan: versionedPlan,
  });
  if (error) {
    throw new Error(`Could not activate Gameplan version: ${error.message}`);
  }

  const storedRows = Array.isArray(data?.rows) ? data.rows : [];
  const idBySymbol = new Map<string, string>(
    storedRows.map((row: any) =>
      [String(row.symbol), String(row.id)] as [string, string]
    ),
  );
  return {
    ...versionedPlan,
    plans: versionedPlan.plans.map((plan) => ({
      ...plan,
      gamePlanId: idBySymbol.get(plan.symbol),
    })),
  };
}

export async function loadActiveGamePlan(
  client: any,
  userId: string,
  botId: string,
  now = new Date(),
): Promise<SessionGamePlan | null> {
  const { data, error } = await client
    .from("active_game_plans")
    .select(
      "id,user_id,bot_id,plan_version,symbol,session,bias,bias_confidence,v2_conviction,state,state_reason,generated_at,expires_at,invalidation_conditions,source_candle_timestamps,plan_json,focus_pairs,news_events,news_impacts,summary,generation_source,config_snapshot,market_data_snapshot,is_active",
    )
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .eq("is_active", true)
    .gt("expires_at", now.toISOString())
    .order("symbol", { ascending: true });
  if (error) {
    throw new Error(`Could not load active Gameplan: ${error.message}`);
  }
  return rowsToSessionGamePlan((data || []) as ActiveGamePlanRow[]);
}
