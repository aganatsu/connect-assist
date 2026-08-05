export const CANONICAL_DEALING_RANGE_VERSION = "canonical-dealing-range.v1";

export type DealingRangeMode = "off" | "avoid_wrong_side" | "strict_value";
export type TradeDirection = "long" | "short";
export type ImpulseDirection = "bullish" | "bearish";
export type DealingRangeZone = "discount" | "equilibrium" | "premium";

export interface DealingRangeImpulseReference {
  impulseId: string | null;
  timeframe: string | null;
  high: number | null;
  low: number | null;
  direction: string | null;
}

export interface DealingRangeEvidenceSlot {
  timeframe: string;
  impulses: Array<{
    impulseId: string;
    selected: boolean;
    direction: string;
    high: number;
    low: number;
  }>;
}

export interface CanonicalDealingRange {
  contractVersion: typeof CANONICAL_DEALING_RANGE_VERSION;
  authority: "canonical_impulse";
  source: "higher_timeframe_parent" | "entry_timeframe_impulse";
  impulseId: string;
  timeframe: string;
  high: number;
  low: number;
  midpoint: number;
  direction: ImpulseDirection;
  frozenAt: string;
}

export type CanonicalDealingRangeSelection =
  | { available: true; range: CanonicalDealingRange; reason: "parent_selected" | "child_selected_no_valid_parent" }
  | { available: false; range: null; reason: "no_valid_impulse_range" };

export interface DealingRangeEvaluation {
  contractVersion: typeof CANONICAL_DEALING_RANGE_VERSION;
  mode: DealingRangeMode;
  available: boolean;
  allowed: boolean;
  direction: TradeDirection;
  price: number;
  percent: number | null;
  zone: DealingRangeZone | null;
  code:
    | "mode_off"
    | "range_unavailable"
    | "allowed"
    | "wrong_side"
    | "strict_value_required";
  explanation: string;
  range: CanonicalDealingRange | null;
}

export interface DealingRangeDecisionComparison {
  contractVersion: typeof CANONICAL_DEALING_RANGE_VERSION;
  enforcement: "observe_only";
  canonical: DealingRangeEvaluation;
  rollingAllowed: boolean | null;
  rollingPercent: number | null;
  decisionsMatch: boolean | null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeImpulseDirection(value: string | null): ImpulseDirection | null {
  const normalized = value?.toLowerCase();
  if (normalized === "bullish" || normalized === "long") return "bullish";
  if (normalized === "bearish" || normalized === "short") return "bearish";
  return null;
}

function toCanonicalRange(
  impulse: DealingRangeImpulseReference | null | undefined,
  source: CanonicalDealingRange["source"],
  frozenAt: string,
): CanonicalDealingRange | null {
  if (!impulse?.impulseId || !impulse.timeframe) return null;
  if (!finite(impulse.high) || !finite(impulse.low) || impulse.high <= impulse.low) return null;
  const direction = normalizeImpulseDirection(impulse.direction);
  if (!direction) return null;
  return {
    contractVersion: CANONICAL_DEALING_RANGE_VERSION,
    authority: "canonical_impulse",
    source,
    impulseId: impulse.impulseId,
    timeframe: impulse.timeframe,
    high: impulse.high,
    low: impulse.low,
    midpoint: Number((((impulse.high + impulse.low) / 2).toPrecision(15))),
    direction,
    frozenAt,
  };
}

export function selectCanonicalDealingRange(input: {
  parentImpulse?: DealingRangeImpulseReference | null;
  childImpulse?: DealingRangeImpulseReference | null;
  frozenAt: string;
}): CanonicalDealingRangeSelection {
  const parent = toCanonicalRange(input.parentImpulse, "higher_timeframe_parent", input.frozenAt);
  if (parent) return { available: true, range: parent, reason: "parent_selected" };
  const child = toCanonicalRange(input.childImpulse, "entry_timeframe_impulse", input.frozenAt);
  if (child) return { available: true, range: child, reason: "child_selected_no_valid_parent" };
  return { available: false, range: null, reason: "no_valid_impulse_range" };
}

function selectedImpulseFor(
  slots: readonly DealingRangeEvidenceSlot[],
  timeframe: string | null | undefined,
): DealingRangeImpulseReference | null {
  if (!timeframe) return null;
  const normalized = timeframe.trim().toLowerCase();
  const slot = slots.find((candidate) =>
    candidate.timeframe.trim().toLowerCase() === normalized
  );
  const impulse = slot?.impulses.find((candidate) => candidate.selected);
  return impulse
    ? {
      impulseId: impulse.impulseId,
      timeframe: slot!.timeframe,
      high: impulse.high,
      low: impulse.low,
      direction: impulse.direction,
    }
    : null;
}

/** Resolve real selected impulse evidence using the frozen zone lineage. */
export function resolveCanonicalDealingRange(input: {
  slots: readonly DealingRangeEvidenceSlot[];
  parentTimeframe?: string | null;
  childTimeframe: string;
  frozenAt: string;
}): CanonicalDealingRangeSelection {
  return selectCanonicalDealingRange({
    parentImpulse: selectedImpulseFor(input.slots, input.parentTimeframe),
    childImpulse: selectedImpulseFor(input.slots, input.childTimeframe),
    frozenAt: input.frozenAt,
  });
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

export function readFrozenCanonicalDealingRange(
  frozenCrossTimeframeContext: unknown,
): CanonicalDealingRange | null {
  const context = objectRecord(frozenCrossTimeframeContext);
  const selection = objectRecord(context.canonicalDealingRange);
  const range = objectRecord(selection.range);
  if (selection.available !== true) return null;
  if (range.contractVersion !== CANONICAL_DEALING_RANGE_VERSION) return null;
  if (!finite(range.high) || !finite(range.low) || range.high <= range.low) return null;
  if (!finite(range.midpoint) || range.midpoint !== Number((((range.high + range.low) / 2).toPrecision(15)))) return null;
  if (typeof range.impulseId !== "string" || typeof range.timeframe !== "string") return null;
  if (range.direction !== "bullish" && range.direction !== "bearish") return null;
  if (range.source !== "higher_timeframe_parent" && range.source !== "entry_timeframe_impulse") return null;
  if (typeof range.frozenAt !== "string") return null;
  return range as CanonicalDealingRange;
}

export function normalizeDealingRangeMode(
  value: unknown,
  legacy?: { onlyBuyInDiscount?: unknown; onlySellInPremium?: unknown } | null,
): DealingRangeMode {
  if (value === "off" || value === "avoid_wrong_side" || value === "strict_value") return value;
  // Existing accounts enter observation with the behavior of the old toggles,
  // never the more restrictive strict-value policy.
  if (legacy || value == null) return "avoid_wrong_side";
  return "avoid_wrong_side";
}

function zoneAt(percent: number): DealingRangeZone {
  if (percent < 50) return "discount";
  if (percent > 50) return "premium";
  return "equilibrium";
}

function displayMode(mode: DealingRangeMode): string {
  if (mode === "avoid_wrong_side") return "Avoid Wrong Side";
  if (mode === "strict_value") return "Strict Value";
  return "Off";
}

function formatPrice(price: number, decimals: number): string {
  return price.toFixed(Math.max(0, Math.min(10, decimals)));
}

export function evaluateCanonicalDealingRange(input: {
  range: CanonicalDealingRange | null;
  direction: TradeDirection;
  price: number;
  mode: DealingRangeMode;
  priceDecimals?: number;
}): DealingRangeEvaluation {
  const base = {
    contractVersion: CANONICAL_DEALING_RANGE_VERSION,
    mode: input.mode,
    direction: input.direction,
    price: input.price,
    range: input.range,
  };
  if (!input.range || !finite(input.price)) {
    return {
      ...base,
      available: false,
      allowed: true,
      percent: null,
      zone: null,
      code: "range_unavailable",
      explanation: "Canonical dealing range unavailable; observation cannot make an entry decision.",
    };
  }

  const percent = Number((
    ((input.price - input.range.low) / (input.range.high - input.range.low)) *
    100
  ).toFixed(10));
  const zone = zoneAt(percent);
  if (input.mode === "off") {
    return {
      ...base,
      available: true,
      allowed: true,
      percent,
      zone,
      code: "mode_off",
      explanation: `Canonical dealing range observed at ${percent.toFixed(1)}%; mode is Off.`,
    };
  }

  const wrongSide = input.mode === "avoid_wrong_side" && (
    (input.direction === "long" && percent > 55) ||
    (input.direction === "short" && percent < 45)
  );
  const outsideStrictValue = input.mode === "strict_value" && (
    (input.direction === "long" && percent >= 45) ||
    (input.direction === "short" && percent <= 55)
  );
  const blocked = wrongSide || outsideStrictValue;
  const decimals = input.priceDecimals ?? 5;
  const side = input.direction === "long" ? "Long" : "Short";
  const impulse = input.range.direction === "bullish" ? "bullish" : "bearish";
  const thresholdPercent = input.direction === "long"
    ? input.mode === "strict_value" ? 45 : 55
    : input.mode === "strict_value" ? 55 : 45;
  const thresholdPrice = input.range.low +
    (input.range.high - input.range.low) * (thresholdPercent / 100);
  const ictZone = zone[0].toUpperCase() + zone.slice(1);
  const requiredZone = input.direction === "long" ? "Discount" : "Premium";
  const comparison = input.direction === "long"
    ? input.mode === "strict_value" ? "below" : "at or below"
    : input.mode === "strict_value" ? "above" : "at or above";
  const rangeLabel = `${input.range.timeframe.toUpperCase()} ${impulse} impulse range ${formatPrice(input.range.low, decimals)}-${formatPrice(input.range.high, decimals)}`;
  const entryLabel = `Entry ${formatPrice(input.price, decimals)} is at ${percent.toFixed(1)}% (${ictZone})`;
  const policyLabel = `${displayMode(input.mode)} requires a ${requiredZone} entry ${comparison} ${thresholdPercent}% (${formatPrice(thresholdPrice, decimals)})`;

  return {
    ...base,
    available: true,
    allowed: !blocked,
    percent,
    zone,
    code: wrongSide ? "wrong_side" : outsideStrictValue ? "strict_value_required" : "allowed",
    explanation: blocked
      ? `${side} rejected: entry is in ${ictZone}. ${rangeLabel}. ${entryLabel}. ${policyLabel}.`
      : `${side} allowed: ${entryLabel} within ${rangeLabel}.`,
  };
}

export function compareDealingRangeDecisions(input: {
  canonical: DealingRangeEvaluation;
  rollingAllowed?: boolean | null;
  rollingPercent?: number | null;
}): DealingRangeDecisionComparison {
  const rollingAllowed = typeof input.rollingAllowed === "boolean" ? input.rollingAllowed : null;
  return {
    contractVersion: CANONICAL_DEALING_RANGE_VERSION,
    enforcement: "observe_only",
    canonical: input.canonical,
    rollingAllowed,
    rollingPercent: finite(input.rollingPercent) ? input.rollingPercent : null,
    decisionsMatch: rollingAllowed == null || !input.canonical.available
      ? null
      : rollingAllowed === input.canonical.allowed,
  };
}
