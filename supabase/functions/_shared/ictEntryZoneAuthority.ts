import type {
  CanonicalZoneLifecycleObservation,
} from "./zoneCandidateModel.ts";

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

function overlap(a: ICTEntryZoneComponent, b: ICTEntryZoneComponent) {
  const low = Math.max(a.low, b.low);
  const high = Math.min(a.high, b.high);
  return high > low ? { low, high } : null;
}

function lifecycleScore(component: ICTEntryZoneComponent): number {
  switch (component.lifecycle.state) {
    case "fresh": return 2;
    case "tapped_and_held": return 3;
    case "partially_mitigated": return 0.5;
    case "violated": return -100;
  }
}

function scoreComponents(components: ICTEntryZoneComponent[]): number {
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

function candidateFor(
  components: ICTEntryZoneComponent[],
  bounds?: { low: number; high: number },
): ICTEntryZoneCandidate {
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
  const zoneBounds = bounds ?? { low: components[0].low, high: components[0].high };
  const validationTrades = components
    .map((item) => item.validationTrade)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const validationTrade = validationTrades.length > 0
    ? {
      entryPrice: components[0].direction === "bullish"
        ? zoneBounds.low
        : zoneBounds.high,
      stopLoss: components[0].direction === "bullish"
        ? Math.min(...validationTrades.map((item) => item.stopLoss))
        : Math.max(...validationTrades.map((item) => item.stopLoss)),
      takeProfit: validationTrades[0].takeProfit,
    }
    : null;
  return {
    contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
    enforcement: "observe_only",
    id: componentIds.join("+"),
    type,
    direction: components[0].direction,
    low: zoneBounds.low,
    high: zoneBounds.high,
    timeframe: components[0].timeframe,
    impulseId: components[0].impulseId,
    componentIds,
    components: types,
    eligible,
    score: eligible ? Number(scoreComponents(components).toFixed(4)) : -100,
    reasons: [
      `belongs to ${components[0].timeframe} impulse ${components[0].impulseId}`,
      components.length > 1
        ? `${types.join(" + ")} overlap forms one composite zone`
        : `${types[0]} is evaluated without a type preference`,
      `lifecycle ${components.map((item) => item.lifecycle.state).join("/")}`,
    ],
    validationTrade,
  };
}

export function selectICTEntryZone(
  input: readonly ICTEntryZoneComponent[],
): ICTEntryZoneSelection {
  const components = input.filter((item) =>
    item.high > item.low && item.impulseId.length > 0
  );
  const consumed = new Set<string>();
  const candidates: ICTEntryZoneCandidate[] = [];

  for (const component of components) {
    if (consumed.has(component.id)) continue;
    const partner = components.find((other) =>
      other.id !== component.id &&
      !consumed.has(other.id) &&
      other.direction === component.direction &&
      other.timeframe === component.timeframe &&
      other.impulseId === component.impulseId &&
      ((component.type === "fvg" && other.type !== "fvg") ||
        (other.type === "fvg" && component.type !== "fvg")) &&
      overlap(component, other) !== null
    );
    if (partner) {
      const bounds = overlap(component, partner)!;
      candidates.push(candidateFor([component, partner], bounds));
      consumed.add(component.id);
      consumed.add(partner.id);
    } else {
      candidates.push(candidateFor([component]));
      consumed.add(component.id);
    }
  }

  candidates.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    b.score - a.score ||
    b.components.length - a.components.length ||
    a.id.localeCompare(b.id)
  );
  const selected = candidates.find((item) => item.eligible) ?? null;
  return {
    contractVersion: ICT_ENTRY_ZONE_AUTHORITY_VERSION,
    enforcement: "observe_only",
    selected,
    ranked: candidates,
    explanation: selected
      ? `${selected.type} selected at ${selected.low}-${selected.high}: ${selected.reasons.join("; ")}`
      : "No eligible ICT entry zone candidate",
  };
}
