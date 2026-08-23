import type { Candle } from "./candleSource.ts";
import { checkCorrelationExposure } from "./gateCorrelation.ts";
import { checkCooldown } from "./gateCooldown.ts";
import { detectSession, isSessionEnabled, toNYTime } from "./sessions.ts";
import { getQuoteToUSDRate, SPECS } from "./smcAnalysis.ts";

export interface FinalRuntimeGate {
  passed: boolean;
  reason: string;
}

export interface FinalRuntimeGateStates {
  executionMode: FinalRuntimeGate;
  brokerConnectionAvailability: FinalRuntimeGate;
  brokerConnectionSizing: FinalRuntimeGate;
  portfolioHeat: FinalRuntimeGate;
  correlation: FinalRuntimeGate;
  cooldown: FinalRuntimeGate;
  news: FinalRuntimeGate;
  session: FinalRuntimeGate;
  freshness: FinalRuntimeGate;
}

export interface FinalRuntimeGateConfig {
  portfolioHeat: number;
  riskPerTrade: number;
  correlationFilterEnabled: boolean;
  maxCorrelation: number;
  maxCorrelatedPositions: number;
  cooldownMinutes: number;
  newsFilterEnabled: boolean;
  newsFilterPauseMinutes: number;
  enabledSessions: string[];
  enabledDays: number[];
  killZoneOnly: boolean;
}

export interface RuntimeGatePosition {
  symbol: string;
  direction?: string | null;
  entry_price?: string | number | null;
  stop_loss?: string | number | null;
  size?: string | number | null;
}

export interface BuildFinalRuntimeGateStatesInput {
  supabase: any;
  userId: string;
  accountExecutionMode?: string | null;
  /** Null when this authorization stage cannot send a broker order. */
  brokerExecutionConnectionCount: number | null;
  symbol: string;
  direction: "long" | "short";
  currentPrice: number;
  candles: Candle[];
  interval: string;
  openPositions: RuntimeGatePosition[];
  accountBalance: string | number | null | undefined;
  config: FinalRuntimeGateConfig;
  rateMap?: Record<string, number>;
  now?: Date;
  newsFetcher?: typeof fetch;
}

export const LIVE_BROKER_CONNECTION_REQUIRED =
  "live_broker_connection_required";
export const MULTIPLE_LIVE_CONNECTIONS_REQUIRE_PER_CONNECTION_SIZING =
  "multiple_live_connections_require_per_connection_sizing";

function asFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intervalMilliseconds(interval: string): number {
  const normalized = interval.toLowerCase().trim();
  const match = normalized.match(/^(\d+)\s*(m|min|h|d|w)$/);
  if (!match) return 15 * 60_000;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "m" || unit === "min") return amount * 60_000;
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "d") return amount * 24 * 60 * 60_000;
  return amount * 7 * 24 * 60 * 60_000;
}

export function checkExecutionMode(mode: unknown): FinalRuntimeGate {
  if (mode !== "paper" && mode !== "live") {
    return {
      passed: false,
      reason: `Execution mode is invalid or unavailable (${String(mode)})`,
    };
  }
  return { passed: true, reason: `Execution mode is ${mode}` };
}

export function checkBrokerConnectionAvailabilityAtExecution(input: {
  executionMode: unknown;
  executionConnectionCount: number | null;
}): FinalRuntimeGate {
  if (input.executionMode !== "live") {
    return {
      passed: true,
      reason: "Broker connection availability does not apply to paper execution",
    };
  }
  if (input.executionConnectionCount === null) {
    return {
      passed: true,
      reason: "This authorization stage does not send a broker order",
    };
  }
  if (input.executionConnectionCount > 0) {
    return {
      passed: true,
      reason: "A live broker execution connection is available",
    };
  }
  return { passed: false, reason: LIVE_BROKER_CONNECTION_REQUIRED };
}

/**
 * Blocks live fan-out while a route still reuses one position size for every
 * broker. Paper execution and non-executing authorization stages are outside
 * this operational guard.
 */
export function checkBrokerConnectionSizingAtExecution(input: {
  executionMode: unknown;
  executionConnectionCount: number | null;
}): FinalRuntimeGate {
  if (input.executionMode !== "live") {
    return {
      passed: true,
      reason: "Broker sizing fan-out does not apply to paper execution",
    };
  }
  if (input.executionConnectionCount === null) {
    return {
      passed: true,
      reason: "This authorization stage does not send a broker order",
    };
  }
  if (input.executionConnectionCount > 1) {
    return {
      passed: false,
      reason: MULTIPLE_LIVE_CONNECTIONS_REQUIRE_PER_CONNECTION_SIZING,
    };
  }
  return {
    passed: true,
    reason:
      `Live execution targets ${input.executionConnectionCount} broker connection(s)`,
  };
}

export function checkPortfolioHeatAtExecution(input: {
  balance: string | number | null | undefined;
  openPositions: RuntimeGatePosition[];
  maximumPercent: number;
  riskPerTradeFallback: number;
  rateMap?: Record<string, number>;
}): FinalRuntimeGate {
  const balance = asFiniteNumber(input.balance);
  const maximum = asFiniteNumber(input.maximumPercent);
  if (maximum <= 0) {
    return { passed: true, reason: "Portfolio heat limit disabled" };
  }
  if (balance <= 0) {
    return {
      passed: false,
      reason: "Portfolio heat cannot be verified without a positive balance",
    };
  }

  let totalRiskDollars = 0;
  for (const position of input.openPositions) {
    const entry = asFiniteNumber(position.entry_price);
    const stop = asFiniteNumber(position.stop_loss);
    const size = asFiniteNumber(position.size);
    if (entry > 0 && stop > 0 && size > 0) {
      const spec = SPECS[position.symbol] || SPECS["EUR/USD"];
      totalRiskDollars += Math.abs(entry - stop) * spec.lotUnits * size *
        getQuoteToUSDRate(position.symbol, input.rateMap);
    } else {
      totalRiskDollars += balance *
        (asFiniteNumber(input.riskPerTradeFallback) / 100);
    }
  }

  const heatPercent = (totalRiskDollars / balance) * 100;
  if (heatPercent >= maximum) {
    return {
      passed: false,
      reason: `Portfolio heat ${heatPercent.toFixed(1)}% is at or above ` +
        `${maximum.toFixed(1)}%`,
    };
  }
  return {
    passed: true,
    reason: `Portfolio heat ${heatPercent.toFixed(1)}% is within limit`,
  };
}

export function checkSessionAtExecution(input: {
  symbol: string;
  enabledSessions: string[];
  enabledDays: number[];
  killZoneOnly: boolean;
  now: Date;
}): FinalRuntimeGate {
  const spec = SPECS[input.symbol] || SPECS["EUR/USD"];
  if (spec.type === "crypto") {
    return {
      passed: true,
      reason: "Session and weekday restrictions do not apply to crypto",
    };
  }

  const ny = toNYTime(input.now);
  const isSundayFxOpen = ny.nyDay === 0 && ny.t >= 17;
  const effectiveDay = isSundayFxOpen ? 1 : ny.nyDay;
  const fxClosed = ny.nyDay === 6 ||
    (ny.nyDay === 0 && ny.t < 17) ||
    (ny.nyDay === 5 && ny.t >= 17);
  if (fxClosed) {
    return { passed: false, reason: "FX market is closed for the weekend" };
  }
  if (!input.enabledDays.includes(effectiveDay)) {
    return {
      passed: false,
      reason: `Trading day ${effectiveDay} is not enabled`,
    };
  }

  const session = detectSession(input.now.getTime());
  const coreEnabled = ["asian", "london", "newyork"].every((key) =>
    input.enabledSessions.includes(key)
  );
  const offHoursImplicit = session.filterKey === "offhours" && coreEnabled;
  if (
    !isSessionEnabled(session, input.enabledSessions) &&
    !offHoursImplicit
  ) {
    return {
      passed: false,
      reason: `${session.name} session is not enabled`,
    };
  }
  if (input.killZoneOnly && !session.isKillZone) {
    return {
      passed: false,
      reason:
        `${session.name} is enabled, but the current time is outside its kill zone`,
    };
  }
  return {
    passed: true,
    reason: `${session.name} session and trading day are enabled`,
  };
}

export function checkMarketFreshness(input: {
  currentPrice: number;
  candles: Candle[];
  interval: string;
  now: Date;
}): FinalRuntimeGate {
  if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
    return {
      passed: false,
      reason: "Current market price is invalid or unavailable",
    };
  }
  const lastCandle = input.candles[input.candles.length - 1];
  const candleTime = lastCandle
    ? new Date(lastCandle.datetime).getTime()
    : Number.NaN;
  if (!lastCandle || !Number.isFinite(candleTime)) {
    return {
      passed: false,
      reason: "Latest candle timestamp is invalid or unavailable",
    };
  }
  const ageMs = input.now.getTime() - candleTime;
  const maximumAgeMs = intervalMilliseconds(input.interval) * 3 + 120_000;
  if (ageMs < -120_000 || ageMs > maximumAgeMs) {
    return {
      passed: false,
      reason: `Latest ${input.interval} candle is stale ` +
        `(${Math.max(0, ageMs / 60_000).toFixed(1)} minutes old)`,
    };
  }
  return {
    passed: true,
    reason: `Current price and latest ${input.interval} candle are fresh ` +
      `(${Math.max(0, ageMs / 60_000).toFixed(1)} minutes old)`,
  };
}

async function checkCooldownAtExecution(input: {
  supabase: any;
  userId: string;
  symbol: string;
  cooldownMinutes: number;
  now: Date;
}): Promise<FinalRuntimeGate> {
  if (input.cooldownMinutes <= 0) {
    return { passed: true, reason: "Cooldown disabled" };
  }
  const { data, error } = await input.supabase
    .from("paper_trade_history")
    .select("closed_at")
    .eq("user_id", input.userId)
    .eq("symbol", input.symbol)
    .order("closed_at", { ascending: false })
    .limit(1);
  if (error) {
    return {
      passed: false,
      reason: `Cooldown could not be verified: ${error.message}`,
    };
  }
  const closedAt = data?.[0]?.closed_at;
  const elapsedMinutes = closedAt
    ? (input.now.getTime() - new Date(closedAt).getTime()) / 60_000
    : null;
  return checkCooldown({
    elapsedMinutes,
    cooldownMinutes: input.cooldownMinutes,
    symbol: input.symbol,
  });
}

async function checkNewsAtExecution(input: {
  symbol: string;
  enabled: boolean;
  withinMinutes: number;
  fetcher: typeof fetch;
}): Promise<FinalRuntimeGate> {
  if (!input.enabled) {
    return { passed: true, reason: "News filter disabled" };
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return {
      passed: false,
      reason:
        "News restrictions cannot be verified because service credentials are unavailable",
    };
  }
  try {
    const response = await input.fetcher(
      `${supabaseUrl}/functions/v1/fundamentals`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          action: "high_impact_check",
          pair: input.symbol,
          withinMinutes: input.withinMinutes,
        }),
      },
    );
    if (!response.ok) {
      return {
        passed: false,
        reason:
          `News restrictions could not be verified (HTTP ${response.status})`,
      };
    }
    const data: any = await response.json();
    if (data.hasHighImpact) {
      const names = (data.events || [])
        .map((event: any) => event.name || event.title || "event")
        .join(", ");
      return {
        passed: false,
        reason: `High-impact news within ${input.withinMinutes} minutes` +
          `${names ? ` — ${names}` : ""}`,
      };
    }
    return {
      passed: true,
      reason: `No high-impact news within ${input.withinMinutes} minutes`,
    };
  } catch (error) {
    return {
      passed: false,
      reason: `News restrictions could not be verified: ${
        (error as Error)?.message
      }`,
    };
  }
}

export async function buildFinalRuntimeGateStates(
  input: BuildFinalRuntimeGateStatesInput,
): Promise<FinalRuntimeGateStates> {
  const now = input.now ?? new Date();
  const [cooldown, news] = await Promise.all([
    checkCooldownAtExecution({
      supabase: input.supabase,
      userId: input.userId,
      symbol: input.symbol,
      cooldownMinutes: input.config.cooldownMinutes,
      now,
    }),
    checkNewsAtExecution({
      symbol: input.symbol,
      enabled: input.config.newsFilterEnabled,
      withinMinutes: input.config.newsFilterPauseMinutes || 30,
      fetcher: input.newsFetcher ?? fetch,
    }),
  ]);

  return {
    executionMode: checkExecutionMode(input.accountExecutionMode),
    brokerConnectionAvailability: checkBrokerConnectionAvailabilityAtExecution({
      executionMode: input.accountExecutionMode,
      executionConnectionCount: input.brokerExecutionConnectionCount,
    }),
    brokerConnectionSizing: checkBrokerConnectionSizingAtExecution({
      executionMode: input.accountExecutionMode,
      executionConnectionCount: input.brokerExecutionConnectionCount,
    }),
    portfolioHeat: checkPortfolioHeatAtExecution({
      balance: input.accountBalance,
      openPositions: input.openPositions,
      maximumPercent: input.config.portfolioHeat,
      riskPerTradeFallback: input.config.riskPerTrade,
      rateMap: input.rateMap,
    }),
    correlation: checkCorrelationExposure({
      enabled: input.config.correlationFilterEnabled,
      symbol: input.symbol,
      direction: input.direction,
      openPositions: input.openPositions,
      maxCorrelation: input.config.maxCorrelation,
      maxCorrelatedPositions: input.config.maxCorrelatedPositions,
    }),
    cooldown,
    news,
    session: checkSessionAtExecution({
      symbol: input.symbol,
      enabledSessions: input.config.enabledSessions,
      enabledDays: input.config.enabledDays,
      killZoneOnly: input.config.killZoneOnly,
      now,
    }),
    freshness: checkMarketFreshness({
      currentPrice: input.currentPrice,
      candles: input.candles,
      interval: input.interval,
      now,
    }),
  };
}
