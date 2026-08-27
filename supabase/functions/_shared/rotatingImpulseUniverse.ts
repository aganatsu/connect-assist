import { getSessionAffinity, type SessionAffinityResult } from "./sessionAffinity.ts";
import type { SessionResult } from "./sessions.ts";
import type { TradingStyleMode } from "./tradingStyleConfig.ts";

export type RotationOutcome = "active_zone" | "no_impulse" | "data_error";

export const SESSION_AWARE_ROTATION_OBSERVATION_CONTRACT =
  "session-aware-rotation-observation.v1" as const;

export type RotationPriorityReason =
  | "gameplan_focus"
  | "primary_session"
  | "session_affinity"
  | "fairness";

export interface RotationPriorityOptions {
  style: TradingStyleMode;
  session: SessionResult;
  /** Fixed scan-cycle timestamp. Never call Date.now() per symbol. */
  atMs: number;
  /** Focus pairs from the existing active Gameplan, when it affects execution. */
  focusSymbols?: Iterable<string>;
}

export interface RotationPriorityCandidate {
  symbol: string;
  reason: RotationPriorityReason;
  affinityTier: SessionAffinityResult["tier"];
  affinityScore: number;
  isPrimarySession: boolean;
  lastScannedAt: string | null;
}

export interface RotationPrioritySummary {
  style: TradingStyleMode;
  session: SessionResult;
  preferredCapacity: number;
  preferredSelected: number;
  fairnessSelected: number;
  selected: RotationPriorityCandidate[];
}

interface SessionRotationObservationBase {
  contract: typeof SESSION_AWARE_ROTATION_OBSERVATION_CONTRACT;
  mode: "observe";
  affectsExecution: false;
  additionalMarketDataCalls: 0;
  capturedAt: string;
  style: TradingStyleMode;
  session: SessionResult;
  enabledSessionKeys: string[];
  restrictedAssetSessionGateOpen: boolean;
  offHoursImplicitlyAllowed: boolean;
  actual: string[];
  lifecycleExcludedSymbols: string[];
}

export type SessionRotationObservation = SessionRotationObservationBase & (
  | {
    status: "ready";
    gamePlanFocusApplied: boolean;
    gamePlanFocusSymbols: string[];
    proposed: string[];
    overlap: string[];
    overlapCount: number;
    overlapPercent: number;
    wouldPromote: string[];
    wouldDefer: string[];
    preferredCapacity: number;
    preferredSelected: number;
    fairnessSelected: number;
    selection: RotationPriorityCandidate[];
  }
  | {
    status: "unavailable";
    unavailableReason: string;
  }
);

export interface RotationPairState {
  symbol: string;
  outcome: RotationOutcome;
  lastScannedAt: string;
  consecutiveNoImpulse: number;
}

export interface RotationState {
  version: "impulse-rotation.v1";
  updatedAt: string;
  pairs: Record<string, RotationPairState>;
}

export interface RotationSelection {
  selected: string[];
  pinned: string[];
  discovery: string[];
  state: RotationState;
  /** Present only when the caller explicitly requests session-aware ranking. */
  priority?: RotationPrioritySummary;
}

export interface LifecycleZoneProximity {
  distance: number;
  nearBuffer: number;
  nearZone: boolean;
}

export function measureLifecycleZoneProximity(input: {
  currentPrice: number;
  zoneLow: number;
  zoneHigh: number;
  pipSize: number;
  minimumBufferPips?: number;
  zoneWidthMultiplier?: number;
}): LifecycleZoneProximity | null {
  const values = [input.currentPrice, input.zoneLow, input.zoneHigh, input.pipSize];
  if (values.some((value) => !Number.isFinite(value)) || input.pipSize <= 0) return null;
  const zoneLow = Math.min(input.zoneLow, input.zoneHigh);
  const zoneHigh = Math.max(input.zoneLow, input.zoneHigh);
  const distance = input.currentPrice < zoneLow
    ? zoneLow - input.currentPrice
    : input.currentPrice > zoneHigh
    ? input.currentPrice - zoneHigh
    : 0;
  const minimumBufferPips = Number.isFinite(input.minimumBufferPips)
    ? Math.max(0, Number(input.minimumBufferPips))
    : 20;
  const zoneWidthMultiplier = Number.isFinite(input.zoneWidthMultiplier)
    ? Math.max(0, Number(input.zoneWidthMultiplier))
    : 2;
  const nearBuffer = Math.max(
    (zoneHigh - zoneLow) * zoneWidthMultiplier,
    input.pipSize * minimumBufferPips,
  );
  return { distance, nearBuffer, nearZone: distance <= nearBuffer };
}

export function emptyRotationState(now = new Date().toISOString()): RotationState {
  return { version: "impulse-rotation.v1", updatedAt: now, pairs: {} };
}

export function selectRotatingImpulseUniverse(
  universe: string[],
  slotCount: number,
  state: RotationState | null | undefined,
  now = new Date().toISOString(),
  excludedSymbols: Iterable<string> = [],
  priorityOptions?: RotationPriorityOptions,
): RotationSelection {
  const unique = [...new Set(universe)];
  const slots = Math.max(1, Math.min(Math.floor(slotCount) || 8, unique.length));
  const current = state?.version === "impulse-rotation.v1" ? state : emptyRotationState(now);
  const excluded = new Set(excludedSymbols);
  const pinned: string[] = [];
  const eligible = unique.filter((symbol) => !excluded.has(symbol));
  const compareByScanRecency = (left: string, right: string): number => {
    const leftTime = current.pairs[left]?.lastScannedAt;
    const rightTime = current.pairs[right]?.lastScannedAt;
    if (!leftTime && rightTime) return -1;
    if (leftTime && !rightTime) return 1;
    if (leftTime !== rightTime) return String(leftTime || "").localeCompare(String(rightTime || ""));
    return 0;
  };
  const compareByDiscoveryAge = (left: string, right: string): number => {
    const recencyDifference = compareByScanRecency(left, right);
    if (recencyDifference !== 0) return recencyDifference;
    return unique.indexOf(left) - unique.indexOf(right);
  };

  // Preserve the production selector exactly unless the caller explicitly asks
  // for the observation ranking. The bot-scanner's execution universe continues
  // to use this branch while the proposed ranking gathers evidence.
  if (!priorityOptions) {
    const discovery = eligible.sort(compareByDiscoveryAge).slice(0, slots);
    return { selected: discovery, pinned, discovery, state: current };
  }

  const focus = new Set(priorityOptions.focusSymbols || []);
  const tierRank: Record<SessionAffinityResult["tier"], number> = {
    prime: 0,
    good: 1,
    marginal: 2,
    avoid: 3,
  };
  const preferredShare: Record<TradingStyleMode, number> = {
    // Shorter holding periods are more dependent on current-session liquidity;
    // longer styles retain more least-recently-scanned coverage.
    scalper: 0.75,
    day_trader: 0.5,
    swing_trader: 0.25,
  };
  const styleShare = preferredShare[priorityOptions.style] ?? 0.5;
  const preferredCapacity = Math.min(
    slots,
    Math.max(1, Math.ceil(slots * styleShare)),
  );
  const ranked = eligible.map((symbol) => ({
    symbol,
    affinity: getSessionAffinity(symbol, priorityOptions.session, {
      atMs: priorityOptions.atMs,
    }),
    isFocus: focus.has(symbol),
  }));
  const preferred = ranked
    // Avoid-tier symbols are not banned. They remain available to the fairness
    // lane so session affinity cannot silently become a new entry gate.
    .filter((candidate) => candidate.isFocus || candidate.affinity.tier !== "avoid")
    .sort((left, right) => {
      if (left.isFocus !== right.isFocus) return left.isFocus ? -1 : 1;
      if (left.affinity.isPrimarySession !== right.affinity.isPrimarySession) {
        return left.affinity.isPrimarySession ? -1 : 1;
      }
      const tierDifference = tierRank[left.affinity.tier] - tierRank[right.affinity.tier];
      if (tierDifference !== 0) return tierDifference;
      const ageDifference = compareByScanRecency(left.symbol, right.symbol);
      if (ageDifference !== 0) return ageDifference;
      if (left.affinity.score !== right.affinity.score) return right.affinity.score - left.affinity.score;
      return unique.indexOf(left.symbol) - unique.indexOf(right.symbol);
    })
    .slice(0, preferredCapacity);
  const preferredSymbols = new Set(preferred.map((candidate) => candidate.symbol));
  const fairness = ranked
    .filter((candidate) => !preferredSymbols.has(candidate.symbol))
    .sort((left, right) => compareByDiscoveryAge(left.symbol, right.symbol))
    .slice(0, Math.max(0, slots - preferred.length));
  const chosen = [...preferred, ...fairness];
  const discovery = chosen.map((candidate) => candidate.symbol);
  const selected: RotationPriorityCandidate[] = chosen.map((candidate, index) => ({
    symbol: candidate.symbol,
    reason: index >= preferred.length
      ? "fairness"
      : candidate.isFocus
      ? "gameplan_focus"
      : candidate.affinity.isPrimarySession
      ? "primary_session"
      : "session_affinity",
    affinityTier: candidate.affinity.tier,
    affinityScore: candidate.affinity.score,
    isPrimarySession: candidate.affinity.isPrimarySession,
    lastScannedAt: current.pairs[candidate.symbol]?.lastScannedAt || null,
  }));

  return {
    selected: discovery,
    pinned,
    discovery,
    state: current,
    priority: {
      style: priorityOptions.style,
      session: priorityOptions.session,
      preferredCapacity,
      preferredSelected: preferred.length,
      fairnessSelected: fairness.length,
      selected,
    },
  };
}

export function updateRotatingImpulseState(
  state: RotationState,
  results: Array<{ symbol: string; outcome: RotationOutcome }>,
  now = new Date().toISOString(),
): RotationState {
  const pairs = { ...state.pairs };
  for (const result of results) {
    const previous = pairs[result.symbol];
    const preservePinnedZone = result.outcome === "data_error" &&
      previous?.outcome === "active_zone";
    pairs[result.symbol] = {
      symbol: result.symbol,
      outcome: preservePinnedZone ? "active_zone" : result.outcome,
      lastScannedAt: now,
      consecutiveNoImpulse: result.outcome === "no_impulse"
        ? (previous?.consecutiveNoImpulse || 0) + 1
        : 0,
    };
  }
  return { version: "impulse-rotation.v1", updatedAt: now, pairs };
}

export function classifyRotationOutcome(detail: any): RotationOutcome {
  if (detail?.impulseZone?.hasZone === true || detail?.unifiedZone?.hasZone === true) return "active_zone";
  const reason = String(detail?.skipReason || detail?.reason || detail?.impulseZone?.reason || "").toLowerCase();
  const status = String(detail?.status || "").toLowerCase();
  if (status.includes("error") || reason.includes("error") || reason.includes("insufficient data") || reason.includes("no data source")) return "data_error";
  return "no_impulse";
}

function rotationKey(userId: string, botId: string): string {
  return `impulse_rotation:${userId}:${botId}`;
}

export async function loadRotatingImpulseState(supabase: any, userId: string, botId: string): Promise<RotationState> {
  const fallback = emptyRotationState();
  try {
    const { data, error } = await supabase.from("kv_cache").select("value").eq("key", rotationKey(userId, botId)).maybeSingle();
    if (error || !data?.value) return fallback;
    const parsed = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
    return parsed?.version === "impulse-rotation.v1" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function saveRotatingImpulseState(supabase: any, userId: string, botId: string, state: RotationState): Promise<void> {
  const now = new Date();
  const { error } = await supabase.from("kv_cache").upsert({
    key: rotationKey(userId, botId),
    value: JSON.stringify(state),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  }, { onConflict: "key" });
  if (error) throw error;
}
