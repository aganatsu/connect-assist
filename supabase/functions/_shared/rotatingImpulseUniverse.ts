export type RotationOutcome = "active_zone" | "no_impulse" | "data_error";

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
): RotationSelection {
  const unique = [...new Set(universe)];
  const slots = Math.max(1, Math.min(Math.floor(slotCount) || 8, unique.length));
  const current = state?.version === "impulse-rotation.v1" ? state : emptyRotationState(now);
  const excluded = new Set(excludedSymbols);
  const pinned: string[] = [];
  const discovery = unique
    .filter((symbol) => !excluded.has(symbol))
    .sort((left, right) => {
      const leftTime = current.pairs[left]?.lastScannedAt;
      const rightTime = current.pairs[right]?.lastScannedAt;
      if (!leftTime && rightTime) return -1;
      if (leftTime && !rightTime) return 1;
      if (leftTime !== rightTime) return String(leftTime || "").localeCompare(String(rightTime || ""));
      return unique.indexOf(left) - unique.indexOf(right);
    })
    .slice(0, slots);
  return { selected: discovery, pinned, discovery, state: current };
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
