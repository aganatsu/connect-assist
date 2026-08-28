import type {
  CanonicalZoneLifecycleObservation,
} from "./zoneCandidateModel.ts";
import type {
  ZoneLocalEvidenceObservation,
  ZoneLocalEvidenceSource,
} from "./zoneLocalConfluence.ts";
import { distanceToBounds } from "./conceptEvidence.ts";

export const ICT_ENTRY_ZONE_AUTHORITY_VERSION = "ict-entry-zone-authority.v1";

export type ICTEntryZoneComponentType = "ob" | "fvg" | "breaker";
export type ICTEntryZoneType =
  | ICTEntryZoneComponentType
  | "ob_fvg"
  | "breaker_fvg";

export interface ICTEntryZoneComponent {
  id: string;
  type: ICTEntryZoneComponentType;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  timeframe: string;
  impulseId: string;
  lifecycle: CanonicalZoneLifecycleObservation;
  fibDepth: number;
  valueLocationScore: number;
  displacementScore: number;
  liquidityScore: number;
  htfLineageScore: number;
  historicalSRScore: number;
  proximityScore: number;
  validationTrade?: { entryPrice: number; stopLoss: number; takeProfit: number };
}

export interface ICTEntryZoneCandidate {
  contractVersion: typeof ICT_ENTRY_ZONE_AUTHORITY_VERSION;
  enforcement: "observe_only";
  id: string;
  type: ICTEntryZoneType;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  timeframe: string;
  impulseId: string;
  componentIds: string[];
  components: ICTEntryZoneComponentType[];
  eligible: boolean;
  score: number;
  reasons: string[];
  validationTrade: { entryPrice: number; stopLoss: number; takeProfit: number } | null;
}

export interface ICTEntryZoneSelection {
  contractVersion: typeof ICT_ENTRY_ZONE_AUTHORITY_VERSION;
  enforcement: "observe_only";
  selected: ICTEntryZoneCandidate | null;
  ranked: ICTEntryZoneCandidate[];
  explanation: string;
}

export type ICTStructurePoiTimeframeRole =
  | "setup"
  | "structure"
  | "confirmation";

/**
 * A non-impulse POI that has already been produced by an existing shared
 * detector. The authority ranks these components; it does not detect them.
 * Stable entity/evidence IDs and closed-bar provenance are mandatory so a
 * candidate can be compared across scans without inventing a new identity.
 */
export interface ICTStructurePoiComponent
  extends Omit<ICTEntryZoneComponent, "impulseId" | "validationTrade"> {
  evidenceId: string;
  sourceCandleStart: string;
  sourceCandleEnd: string;
}

export interface ICTStructurePoiEntryZoneInput {
  mode: "structure_poi";
  contextId: string;
  direction: "bullish" | "bearish";
  observedAt: string;
  currentPrice: number;
  timeframes: Record<ICTStructurePoiTimeframeRole, string>;
  components: readonly ICTStructurePoiComponent[];
}

export interface ICTStructurePoiEntryZoneCandidate {
  contractVersion: typeof ICT_ENTRY_ZONE_AUTHORITY_VERSION;
  enforcement: "observe_only";
  affectsAuthorization: false;
  mode: "structure_poi";
  setupFamily: "structure_poi";
  id: string;
  contextId: string;
  type: ICTEntryZoneType;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  timeframe: string;
  timeframeRoles: ICTStructurePoiTimeframeRole[];
  componentIds: string[];
  sourceEvidenceIds: string[];
  sourceWindow: {
    start: string;
    end: string;
  };
  components: ICTEntryZoneComponentType[];
  eligible: boolean;
  score: number;
  priceInsideZone: boolean;
  distanceToZone: number;
  reasons: string[];
}

export interface ICTStructurePoiEntryZoneSelection {
  contractVersion: typeof ICT_ENTRY_ZONE_AUTHORITY_VERSION;
  enforcement: "observe_only";
  affectsAuthorization: false;
  mode: "structure_poi";
  setupFamily: "structure_poi";
  contextId: string;
  selected: ICTStructurePoiEntryZoneCandidate | null;
  ranked: ICTStructurePoiEntryZoneCandidate[];
  explanation: string;
  componentCounts: {
    received: number;
    accepted: number;
  };
}

export type ICTNestedEntryZoneType =
  | ICTEntryZoneComponentType
  | "support_resistance"
  | "fib";

export interface ICTNestedEntryZoneInput {
  mode: "nested_poi";
  outerZone: {
    low: number;
    high: number;
    direction: "bullish" | "bearish";
  };
  impulseId: string;
  evidence: readonly ZoneLocalEvidenceObservation[];
}

export interface ICTNestedEntryZoneCandidate {
  contractVersion: typeof ICT_ENTRY_ZONE_AUTHORITY_VERSION;
  enforcement: "observe_only";
  mode: "nested_poi";
  id: string;
  type: ICTNestedEntryZoneType;
  geometry: "range" | "level";
  source: ZoneLocalEvidenceSource;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  entryPrice: number;
  timeframe: string;
  impulseId: string;
  lifecycle: string | null;
  evidenceId: string;
  entityId: string;
  supportingEvidenceIds: string[];
  supportingFamilies: ICTNestedEntryZoneType[];
  independentEvidenceCount: number;
  localScore: number;
  lifecycleRank: number;
  depth: number;
  widthRatio: number;
  rank: number;
  eligible: true;
  reasons: string[];
}

export interface ICTNestedEntryZoneSelection {
  contractVersion: typeof ICT_ENTRY_ZONE_AUTHORITY_VERSION;
  enforcement: "observe_only";
  mode: "nested_poi";
  selected: ICTNestedEntryZoneCandidate | null;
  ranked: ICTNestedEntryZoneCandidate[];
  explanation: string;
}

export type ICTEntryZoneAuthorityInput =
  | readonly ICTEntryZoneComponent[]
  | ICTNestedEntryZoneInput
  | ICTStructurePoiEntryZoneInput;

export type ICTEntryZoneSelectionFor<
  T extends ICTEntryZoneAuthorityInput,
> = T extends ICTNestedEntryZoneInput
  ? ICTNestedEntryZoneSelection
  : T extends ICTStructurePoiEntryZoneInput
  ? ICTStructurePoiEntryZoneSelection
  : ICTEntryZoneSelection;

interface ICTNestedEntryZoneSeed {
  id: string;
  type: ICTNestedEntryZoneType;
  geometry: "range" | "level";
  source: ZoneLocalEvidenceSource;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  entryPrice: number;
  timeframe: string;
  impulseId: string;
  lifecycle: string | null;
  evidenceId: string;
  entityId: string;
  legacyCredit: number;
  lifecycleRank: number;
  depth: number;
  widthRatio: number;
}

type ICTEntryZoneRankableComponent = Pick<
  ICTEntryZoneComponent,
  | "id"
  | "type"
  | "direction"
  | "low"
  | "high"
  | "timeframe"
  | "lifecycle"
  | "fibDepth"
  | "valueLocationScore"
  | "displacementScore"
  | "liquidityScore"
  | "htfLineageScore"
  | "historicalSRScore"
  | "proximityScore"
>;

interface ICTEntryZoneCandidateCore {
  id: string;
  type: ICTEntryZoneType;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  timeframe: string;
  componentIds: string[];
  components: ICTEntryZoneComponentType[];
  eligible: boolean;
  score: number;
}

interface ICTEntryZoneComponentGroup<T extends ICTEntryZoneRankableComponent> {
  components: T[];
  bounds?: { low: number; high: number };
}

function overlap(
  a: Pick<ICTEntryZoneRankableComponent, "low" | "high">,
  b: Pick<ICTEntryZoneRankableComponent, "low" | "high">,
) {
  const low = Math.max(a.low, b.low);
  const high = Math.min(a.high, b.high);
  return high > low ? { low, high } : null;
}

function groupEntryZoneComponents<T extends ICTEntryZoneRankableComponent>(
  components: readonly T[],
  sameContext: (left: T, right: T) => boolean,
): ICTEntryZoneComponentGroup<T>[] {
  const consumed = new Set<string>();
  const groups: ICTEntryZoneComponentGroup<T>[] = [];

  for (const component of components) {
    if (consumed.has(component.id)) continue;
    const partner = components.find((other) =>
      other.id !== component.id &&
      !consumed.has(other.id) &&
      other.direction === component.direction &&
      other.timeframe === component.timeframe &&
      sameContext(component, other) &&
      ((component.type === "fvg" && other.type !== "fvg") ||
        (other.type === "fvg" && component.type !== "fvg")) &&
      overlap(component, other) !== null
    );
    if (partner) {
      groups.push({
        components: [component, partner],
        bounds: overlap(component, partner)!,
      });
      consumed.add(component.id);
      consumed.add(partner.id);
    } else {
      groups.push({ components: [component] });
      consumed.add(component.id);
    }
  }

  return groups;
}

function rankEntryZoneCandidates<
  T extends {
    eligible: boolean;
    score: number;
    components: readonly unknown[];
    id: string;
  },
>(candidates: T[]): T[] {
  return candidates.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    b.score - a.score ||
    b.components.length - a.components.length ||
    a.id.localeCompare(b.id)
  );
}

function nestedEntryType(
  item: ZoneLocalEvidenceObservation,
): ICTNestedEntryZoneType | null {
  switch (item.source) {
    case "ltf_refinement":
      return item.evidence?.concept === "order_block"
        ? "ob"
        : item.evidence?.concept === "fvg"
        ? "fvg"
        : item.evidence?.concept === "breaker"
        ? "breaker"
        : null;
    case "htf_order_block":
      return "ob";
    case "htf_fvg":
      return "fvg";
    case "htf_breaker":
      return "breaker";
    case "historical_sr":
      return "support_resistance";
    case "impulse_fib":
    case "htf_fib":
      return "fib";
    default:
      return null;
  }
}

function nestedEntryLifecycleRank(
  type: ICTNestedEntryZoneType,
  value: unknown,
): number {
  if (type === "support_resistance" || type === "fib") return 1;
  const lifecycle = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (lifecycle === "fresh" || lifecycle === "open") return 5;
  if (lifecycle === "respected" || lifecycle === "tapped_and_held") return 4;
  if (lifecycle === "active") return 3;
  if (lifecycle === "tested" || lifecycle === "partially_filled") return 2;
  return 1;
}

function nestedEntryLifecycleEligible(
  item: ZoneLocalEvidenceObservation,
  type: ICTNestedEntryZoneType,
): boolean {
  const lifecycle = String(item.evidence?.lifecycle || "").trim().toLowerCase();
  if (type === "ob") return lifecycle !== "broken" && lifecycle !== "mitigated";
  if (type === "fvg") return lifecycle !== "filled";
  if (type !== "breaker") return true;
  const subtype = String(
    item.attributes.subtype ?? item.evidence?.attributes.subtype ?? "",
  ).trim().toLowerCase();
  return subtype === "breaker" &&
    (lifecycle === "active" || lifecycle === "tested" ||
      lifecycle === "respected");
}

function nestedEntrySeed(
  input: ICTNestedEntryZoneInput,
  item: ZoneLocalEvidenceObservation,
): ICTNestedEntryZoneSeed | null {
  const evidence = item.evidence;
  const type = nestedEntryType(item);
  if (!evidence || !type || !nestedEntryLifecycleEligible(item, type)) {
    return null;
  }
  if (
    evidence.direction !== "neutral" &&
    evidence.direction !== input.outerZone.direction
  ) return null;

  const outerLow = Math.min(input.outerZone.low, input.outerZone.high);
  const outerHigh = Math.max(input.outerZone.low, input.outerZone.high);
  const outerWidth = outerHigh - outerLow;
  if (!(outerWidth > 0)) return null;

  let geometry: "range" | "level";
  let low: number;
  let high: number;
  if (type === "support_resistance" || type === "fib") {
    const level = Number(evidence.level);
    if (!Number.isFinite(level) || level <= outerLow || level >= outerHigh) {
      return null;
    }
    geometry = "level";
    low = level;
    high = level;
  } else {
    const boundsLow = Number(evidence.bounds?.low);
    const boundsHigh = Number(evidence.bounds?.high);
    if (!Number.isFinite(boundsLow) || !Number.isFinite(boundsHigh)) {
      return null;
    }
    low = Math.min(boundsLow, boundsHigh);
    high = Math.max(boundsLow, boundsHigh);
    if (
      !(high > low) || low <= outerLow || high >= outerHigh ||
      high - low >= outerWidth
    ) return null;
    geometry = "range";
  }

  const entryPrice = geometry === "level"
    ? low
    : input.outerZone.direction === "bullish"
    ? high
    : low;
  const depth = input.outerZone.direction === "bullish"
    ? (outerHigh - entryPrice) / outerWidth
    : (entryPrice - outerLow) / outerWidth;
  const widthRatio = geometry === "range" ? (high - low) / outerWidth : 0;
  return {
    id: evidence.entityId,
    type,
    geometry,
    source: item.source,
    direction: input.outerZone.direction,
    low,
    high,
    entryPrice,
    timeframe: evidence.timeframe,
    impulseId: input.impulseId,
    lifecycle: evidence.lifecycle,
    evidenceId: evidence.evidenceId,
    entityId: evidence.entityId,
    legacyCredit: Math.max(0, Number(item.legacyScoreContribution) || 0),
    lifecycleRank: nestedEntryLifecycleRank(type, evidence.lifecycle),
    depth: Math.max(0, Math.min(1, depth)),
    widthRatio: Math.max(0, Math.min(1, widthRatio)),
  };
}

function nestedEntryOverlaps(
  left: Pick<ICTNestedEntryZoneSeed, "low" | "high">,
  right: Pick<ICTNestedEntryZoneSeed, "low" | "high">,
): boolean {
  return Math.max(left.low, right.low) <= Math.min(left.high, right.high);
}

function selectNestedICTEntryZone(
  input: ICTNestedEntryZoneInput,
): ICTNestedEntryZoneSelection {
  const deduplicated = new Map<string, ICTNestedEntryZoneSeed>();
  for (const item of input.evidence) {
    const seed = nestedEntrySeed(input, item);
    if (!seed) continue;
    const existing = deduplicated.get(seed.entityId);
    if (
      !existing || seed.legacyCredit > existing.legacyCredit ||
      (seed.legacyCredit === existing.legacyCredit &&
        seed.source < existing.source)
    ) {
      deduplicated.set(seed.entityId, seed);
    }
  }

  const seeds = [...deduplicated.values()];
  const candidates = seeds.map((seed): ICTNestedEntryZoneCandidate => {
    const familyWinners = new Map<
      ICTNestedEntryZoneType,
      ICTNestedEntryZoneSeed
    >();
    for (const supporting of seeds) {
      if (!nestedEntryOverlaps(seed, supporting)) continue;
      const current = familyWinners.get(supporting.type);
      if (
        !current || supporting.legacyCredit > current.legacyCredit ||
        (supporting.legacyCredit === current.legacyCredit &&
          supporting.id < current.id)
      ) {
        familyWinners.set(supporting.type, supporting);
      }
    }
    const supporting = [...familyWinners.values()].sort((left, right) =>
      left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
    );
    return {
      contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
      enforcement: "observe_only",
      mode: "nested_poi",
      id: seed.id,
      type: seed.type,
      geometry: seed.geometry,
      source: seed.source,
      direction: seed.direction,
      low: seed.low,
      high: seed.high,
      entryPrice: seed.entryPrice,
      timeframe: seed.timeframe,
      impulseId: seed.impulseId,
      lifecycle: seed.lifecycle,
      evidenceId: seed.evidenceId,
      entityId: seed.entityId,
      supportingEvidenceIds: supporting.map((item) => item.evidenceId),
      supportingFamilies: supporting.map((item) => item.type),
      independentEvidenceCount: supporting.length,
      localScore: Number(
        supporting.reduce((sum, item) => sum + item.legacyCredit, 0).toFixed(4),
      ),
      lifecycleRank: seed.lifecycleRank,
      depth: Number(seed.depth.toFixed(6)),
      widthRatio: Number(seed.widthRatio.toFixed(6)),
      rank: 0,
      eligible: true,
      reasons: [
        `strictly contained in impulse ${seed.impulseId}`,
        `${supporting.length} independent overlapping evidence families`,
        `lifecycle ${seed.lifecycle || "not_applicable"}`,
      ],
    };
  });

  candidates.sort((left, right) =>
    right.independentEvidenceCount - left.independentEvidenceCount ||
    right.localScore - left.localScore ||
    right.lifecycleRank - left.lifecycleRank ||
    Number(right.geometry === "range") - Number(left.geometry === "range") ||
    right.depth - left.depth ||
    left.widthRatio - right.widthRatio ||
    left.id.localeCompare(right.id)
  );
  candidates.forEach((candidate, index) => candidate.rank = index + 1);
  const selected = candidates[0] || null;
  return {
    contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
    enforcement: "observe_only",
    mode: "nested_poi",
    selected,
    ranked: candidates,
    explanation: selected
      ? `${selected.type} selected at ${selected.low}-${selected.high}: ${selected.reasons.join("; ")}`
      : "No eligible strictly-contained nested ICT entry zone candidate",
  };
}

function lifecycleScore(component: ICTEntryZoneRankableComponent): number {
  switch (component.lifecycle.state) {
    case "fresh": return 2;
    case "tapped_and_held": return 3;
    case "partially_mitigated": return 0.5;
    case "violated": return -100;
  }
}

function scoreComponents(components: ICTEntryZoneRankableComponent[]): number {
  const strongest = components.reduce((best, item) =>
    lifecycleScore(item) > lifecycleScore(best) ? item : best
  );
  const base = lifecycleScore(strongest) +
    Math.max(...components.map((item) => item.valueLocationScore)) +
    Math.max(...components.map((item) => item.displacementScore)) +
    Math.max(...components.map((item) => item.liquidityScore)) +
    Math.max(...components.map((item) => item.htfLineageScore)) +
    Math.max(...components.map((item) => item.historicalSRScore)) +
    Math.max(...components.map((item) => item.proximityScore));
  return base + (components.length > 1 ? 1.5 : 0);
}

function candidateCoreFor(
  components: ICTEntryZoneRankableComponent[],
  bounds?: { low: number; high: number },
): ICTEntryZoneCandidateCore {
  const types = [...new Set(components.map((item) => item.type))].sort();
  const type: ICTEntryZoneType = types.includes("breaker") && types.includes("fvg")
    ? "breaker_fvg"
    : types.includes("ob") && types.includes("fvg")
    ? "ob_fvg"
    : components[0].type;
  const eligible = components.every((item) =>
    item.lifecycle.state !== "violated"
  );
  const componentIds = components.map((item) => item.id).sort();
  const zoneBounds = bounds ?? {
    low: components[0].low,
    high: components[0].high,
  };
  return {
    id: componentIds.join("+"),
    type,
    direction: components[0].direction,
    low: zoneBounds.low,
    high: zoneBounds.high,
    timeframe: components[0].timeframe,
    componentIds,
    components: types,
    eligible,
    score: eligible ? Number(scoreComponents(components).toFixed(4)) : -100,
  };
}

function candidateFor(
  components: ICTEntryZoneComponent[],
  bounds?: { low: number; high: number },
): ICTEntryZoneCandidate {
  const core = candidateCoreFor(components, bounds);
  const validationTrades = components
    .map((item) => item.validationTrade)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const validationTrade = validationTrades.length > 0
    ? {
      entryPrice: components[0].direction === "bullish"
        ? core.low
        : core.high,
      stopLoss: components[0].direction === "bullish"
        ? Math.min(...validationTrades.map((item) => item.stopLoss))
        : Math.max(...validationTrades.map((item) => item.stopLoss)),
      takeProfit: validationTrades[0].takeProfit,
    }
    : null;
  return {
    contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
    enforcement: "observe_only",
    ...core,
    impulseId: components[0].impulseId,
    reasons: [
      `belongs to ${components[0].timeframe} impulse ${components[0].impulseId}`,
      components.length > 1
        ? `${core.components.join(" + ")} overlap forms one composite zone`
        : `${core.components[0]} is evaluated without a type preference`,
      `lifecycle ${components.map((item) => item.lifecycle.state).join("/")}`,
    ],
    validationTrade,
  };
}

function structurePoiTimeframeRoles(
  input: ICTStructurePoiEntryZoneInput,
  timeframe: string,
): ICTStructurePoiTimeframeRole[] {
  return (["setup", "structure", "confirmation"] as const).filter((role) =>
    input.timeframes[role] === timeframe
  );
}

function structurePoiCandidateFor(
  input: ICTStructurePoiEntryZoneInput,
  components: ICTStructurePoiComponent[],
  bounds?: { low: number; high: number },
): ICTStructurePoiEntryZoneCandidate {
  const core = candidateCoreFor(components, bounds);
  const contextId = input.contextId.trim();
  const sourceTimes = components.flatMap((component) => [
    component.sourceCandleStart,
    component.sourceCandleEnd,
  ]).sort((left, right) => Date.parse(left) - Date.parse(right));
  const timeframeRoles = structurePoiTimeframeRoles(input, core.timeframe);
  const priceDistance = distanceToBounds(core, { level: input.currentPrice });
  return {
    contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
    enforcement: "observe_only",
    affectsAuthorization: false,
    mode: "structure_poi",
    setupFamily: "structure_poi",
    ...core,
    id: `structure_poi:${core.id}`,
    contextId,
    timeframeRoles,
    sourceEvidenceIds: [...new Set(components.map((item) => item.evidenceId))]
      .sort(),
    sourceWindow: {
      start: sourceTimes[0],
      end: sourceTimes[sourceTimes.length - 1],
    },
    priceInsideZone: priceDistance === 0,
    distanceToZone: priceDistance,
    reasons: [
      `${
        timeframeRoles.join("/")
      } timeframe evidence in structure context ${contextId}`,
      components.length > 1
        ? `${core.components.join(" + ")} overlap forms one composite zone`
        : `${core.components[0]} is evaluated without a type preference`,
      `lifecycle ${components.map((item) => item.lifecycle.state).join("/")}`,
      "closed-bar source evidence only",
    ],
  };
}

function selectStructurePoiEntryZone(
  input: ICTStructurePoiEntryZoneInput,
): ICTStructurePoiEntryZoneSelection {
  const observedAtMs = Date.parse(input.observedAt);
  const allowedTimeframes = new Set(Object.values(input.timeframes));
  const contextId = input.contextId.trim();
  const validContext = contextId.length > 0;
  const validCurrentPrice = Number.isFinite(input.currentPrice);
  const components = validContext && validCurrentPrice &&
      Number.isFinite(observedAtMs)
    ? input.components.filter((item) => {
      const sourceStartMs = Date.parse(item.sourceCandleStart);
      const sourceEndMs = Date.parse(item.sourceCandleEnd);
      return item.id.trim().length > 0 &&
        item.evidenceId.trim().length > 0 &&
        item.timeframe.trim().length > 0 &&
        Number.isFinite(item.low) &&
        Number.isFinite(item.high) &&
        item.high > item.low &&
        item.direction === input.direction &&
        allowedTimeframes.has(item.timeframe) &&
        [
          item.fibDepth,
          item.valueLocationScore,
          item.displacementScore,
          item.liquidityScore,
          item.htfLineageScore,
          item.historicalSRScore,
          item.proximityScore,
        ].every((value) => Number.isFinite(value)) &&
        Number.isFinite(sourceStartMs) &&
        Number.isFinite(sourceEndMs) &&
        sourceStartMs <= sourceEndMs &&
        sourceEndMs <= observedAtMs;
    })
    : [];
  components.sort((left, right) => left.id.localeCompare(right.id));
  const candidates = groupEntryZoneComponents(
    components,
    () => true,
  ).map((group) =>
    structurePoiCandidateFor(input, group.components, group.bounds)
  );
  rankEntryZoneCandidates(candidates);
  const selected = candidates.find((item) => item.eligible) ?? null;
  return {
    contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
    enforcement: "observe_only",
    affectsAuthorization: false,
    mode: "structure_poi",
    setupFamily: "structure_poi",
    contextId,
    selected,
    ranked: candidates,
    explanation: selected
      ? `${selected.type} structure POI selected at ${selected.low}-${selected.high}: ${
        selected.reasons.join("; ")
      }`
      : "No eligible closed-bar structure POI candidate on the resolved setup, structure, or confirmation timeframes",
    componentCounts: {
      received: input.components.length,
      accepted: components.length,
    },
  };
}

export function selectICTEntryZone<T extends ICTEntryZoneAuthorityInput>(
  input: T,
): ICTEntryZoneSelectionFor<T> {
  if (!Array.isArray(input)) {
    const mode = (input as { mode?: unknown }).mode;
    if (mode === "nested_poi") {
      return selectNestedICTEntryZone(
        input as ICTNestedEntryZoneInput,
      ) as ICTEntryZoneSelectionFor<T>;
    }
    if (mode === "structure_poi") {
      return selectStructurePoiEntryZone(
        input as ICTStructurePoiEntryZoneInput,
      ) as ICTEntryZoneSelectionFor<T>;
    }
    throw new Error(`Unsupported ICT entry-zone authority mode: ${String(mode)}`);
  }
  const components = (input as readonly ICTEntryZoneComponent[]).filter((item) =>
    item.high > item.low && item.impulseId.length > 0
  );
  const candidates = groupEntryZoneComponents(
    components,
    (left, right) => left.impulseId === right.impulseId,
  ).map((group) => candidateFor(group.components, group.bounds));
  rankEntryZoneCandidates(candidates);
  const selected = candidates.find((item) => item.eligible) ?? null;
  return {
    contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
    enforcement: "observe_only",
    selected,
    ranked: candidates,
    explanation: selected
      ? `${selected.type} selected at ${selected.low}-${selected.high}: ${
        selected.reasons.join("; ")
      }`
      : "No eligible ICT entry zone candidate",
  } as ICTEntryZoneSelectionFor<T>;
}
