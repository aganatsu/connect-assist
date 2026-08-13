import type { Candle } from "./smcAnalysis.ts";

export const POST_CHOCH_RETRACEMENT_VERSION = "post-choch-retracement.v1";
export type AfterChochMode =
  | "confirmation_close"
  | "observe_retracement"
  | "wait_retracement";

export interface PostChochEntryPlan {
  contractVersion: typeof POST_CHOCH_RETRACEMENT_VERSION;
  state: "awaiting_retracement" | "ready" | "invalidated" | "expired";
  mode: AfterChochMode;
  direction: "long" | "short";
  candidateId: string | null;
  confirmationGeneration: number | null;
  confirmation: {
    type: string;
    tier: number;
    price: number;
    candleIndex: number;
    candleTime: string;
    displacement: number;
    significance: "internal" | "external" | null;
    closeBased: boolean;
    supportingSignals: string[];
    authority: unknown;
  };
  zone: {
    type: "fvg_ob_overlap" | "fvg" | "micro_ob" | "displacement_50";
    low: number;
    high: number;
    midpoint: number;
  };
  protectedLevel: number;
  createdAt: string;
  expiresAt: string;
  touchedAt: string | null;
  resolvedAt: string | null;
  reason: string;
}

export function normalizeAfterChochMode(value: unknown): AfterChochMode {
  return value === "observe_retracement" || value === "wait_retracement"
    ? value : "confirmation_close";
}

function overlap(
  left: { low: number; high: number } | null,
  right: { low: number; high: number } | null,
) {
  if (!left || !right) return null;
  const low = Math.max(left.low, right.low);
  const high = Math.min(left.high, right.high);
  return high > low ? { low, high } : null;
}

export function derivePostChochEntryPlan(input: {
  candles: Candle[];
  direction: "long" | "short";
  signal: {
    type: string; tier: number; price: number; candleIndex: number;
    displacement: number; significance?: "internal" | "external";
    closeBased: boolean; supportingSignals: string[]; authority?: unknown;
  };
  protectedLevel: number;
  candidateId?: string | null;
  confirmationGeneration?: number | null;
  mode: AfterChochMode;
  createdAt: string;
  expiryMinutes: number;
}): PostChochEntryPlan | null {
  const { candles, direction, signal } = input;
  const index = signal.candleIndex;
  const confirmation = candles[index];
  if (!confirmation || !Number.isFinite(input.protectedLevel)) return null;

  const prior2 = candles[index - 2];
  const fvg = prior2
    ? direction === "long" && prior2.high < confirmation.low
      ? { low: prior2.high, high: confirmation.low }
      : direction === "short" && prior2.low > confirmation.high
      ? { low: confirmation.high, high: prior2.low }
      : null
    : null;

  let microOb: { low: number; high: number } | null = null;
  for (let cursor = index - 1; cursor >= Math.max(0, index - 5); cursor--) {
    const candle = candles[cursor];
    const opposing = direction === "long"
      ? candle.close < candle.open
      : candle.close > candle.open;
    if (opposing) {
      microOb = { low: candle.low, high: candle.high };
      break;
    }
  }
  const composite = overlap(fvg, microOb);
  const selected = composite
    ? { ...composite, type: "fvg_ob_overlap" as const }
    : fvg ? { ...fvg, type: "fvg" as const }
    : microOb ? { ...microOb, type: "micro_ob" as const }
    : {
      low: input.protectedLevel + (signal.price - input.protectedLevel) * 0.45,
      high: input.protectedLevel + (signal.price - input.protectedLevel) * 0.55,
      type: "displacement_50" as const,
    };
  if (!(selected.high > selected.low)) return null;
  const expiresAt = new Date(
    Date.parse(input.createdAt) + Math.max(1, input.expiryMinutes) * 60_000,
  ).toISOString();
  return {
    contractVersion: POST_CHOCH_RETRACEMENT_VERSION,
    state: "awaiting_retracement",
    mode: input.mode,
    direction,
    candidateId: input.candidateId || null,
    confirmationGeneration: input.confirmationGeneration ?? null,
    confirmation: {
      type: signal.type, tier: signal.tier, price: signal.price,
      candleIndex: index, candleTime: confirmation.datetime,
      displacement: signal.displacement,
      significance: signal.significance || null,
      closeBased: signal.closeBased,
      supportingSignals: signal.supportingSignals,
      authority: signal.authority || null,
    },
    zone: {
      type: selected.type, low: selected.low, high: selected.high,
      midpoint: (selected.low + selected.high) / 2,
    },
    protectedLevel: input.protectedLevel,
    createdAt: input.createdAt,
    expiresAt,
    touchedAt: null,
    resolvedAt: null,
    reason: `Waiting for retracement into ${selected.type} ${selected.low}-${selected.high}`,
  };
}

export function evaluatePostChochRetracement(
  plan: PostChochEntryPlan,
  candle: Candle,
): PostChochEntryPlan {
  if (plan.state !== "awaiting_retracement") return plan;
  const now = candle.datetime;
  if (Date.parse(now) > Date.parse(plan.expiresAt)) {
    return { ...plan, state: "expired", resolvedAt: now, reason: "Post-CHoCH retracement window expired" };
  }
  const protectedFailed = plan.direction === "long"
    ? candle.close < plan.protectedLevel
    : candle.close > plan.protectedLevel;
  if (protectedFailed) {
    return { ...plan, state: "invalidated", resolvedAt: now, reason: `CHoCH protected level ${plan.protectedLevel} failed on close ${candle.close}` };
  }
  if (Date.parse(now) <= Date.parse(plan.confirmation.candleTime)) return plan;
  // The scanner can execute only at the current market price. A historical
  // wick through the zone is evidence, not a fill price.
  const touched = candle.close >= plan.zone.low && candle.close <= plan.zone.high;
  if (touched) {
    return { ...plan, state: "ready", touchedAt: now, resolvedAt: now, reason: `Price retraced into frozen ${plan.zone.type}` };
  }
  return plan;
}

export function rearmPostChochRetracement(
  plan: PostChochEntryPlan,
  reason: string,
): PostChochEntryPlan {
  if (plan.state !== "ready") return plan;
  return {
    ...plan,
    state: "awaiting_retracement",
    touchedAt: null,
    resolvedAt: null,
    reason: `Final authorization waiting: ${reason}`,
  };
}
