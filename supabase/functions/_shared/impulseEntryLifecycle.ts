export const IMPULSE_ENTRY_LIFECYCLE_VERSION = "impulse-entry-lifecycle.v1";

export type ImpulseEntryLifecycleMode = "off" | "observe" | "enforce";
export type EntryCandidateState =
  | "queued"
  | "active"
  | "confirming"
  | "failed"
  | "entered"
  | "expired";

export interface ImpulseEntryCandidate {
  id: string;
  type: "ob" | "fvg" | "breaker" | "ob_fvg" | "breaker_fvg";
  low: number;
  high: number;
  timeframe: string;
  impulseId: string;
  rank: number;
  depth: number;
  state: EntryCandidateState;
  activatedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
}

export interface CandidateConfirmationContract {
  candidateId: string;
  generation: number;
  status: "building" | "trigger_locked" | "confirmed" | "cancelled";
  startedAt: string;
  method: "choch" | "indicators" | "choch_and_indicators";
  timeframe: string;
  refinementTimeframe: string;
  protectedLevel: number | null;
  breakLevel: number | null;
  lockedAt: string | null;
  expiresAt: string;
  revisions: Array<{
    revision: number;
    protectedLevel: number;
    breakLevel: number;
    observedAt: string;
    reason: string;
  }>;
  confirmedAt: string | null;
}

export interface ImpulseEntryLifecycle {
  contractVersion: typeof IMPULSE_ENTRY_LIFECYCLE_VERSION;
  mode: ImpulseEntryLifecycleMode;
  impulse: {
    id: string;
    direction: "long" | "short";
    timeframe: string;
    rangeLow: number;
    rangeHigh: number;
    protectedLevel: number;
    expiresAt: string;
  };
  status: "active" | "entered" | "invalidated" | "expired" | "exhausted";
  activeCandidateId: string | null;
  candidates: ImpulseEntryCandidate[];
  confirmation: CandidateConfirmationContract | null;
  revision: number;
  lastTransitionReason: string;
}

export interface BuildImpulseEntryLifecycleInput {
  mode?: ImpulseEntryLifecycleMode;
  now: string;
  impulse: ImpulseEntryLifecycle["impulse"];
  candidates: Array<Omit<ImpulseEntryCandidate,
    "rank" | "depth" | "state" | "activatedAt" | "failedAt" | "failureReason">>;
  confirmation: {
    method: CandidateConfirmationContract["method"];
    timeframe: string;
    refinementTimeframe: string;
    expiresAt: string;
  };
  initialCandidateId?: string | null;
  maxCandidates?: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function depthFor(
  direction: "long" | "short",
  rangeLow: number,
  rangeHigh: number,
  candidate: { low: number; high: number },
): number {
  const width = rangeHigh - rangeLow;
  const midpoint = (candidate.low + candidate.high) / 2;
  if (!(width > 0)) return 0;
  return direction === "long"
    ? (rangeHigh - midpoint) / width
    : (midpoint - rangeLow) / width;
}

function newConfirmation(
  candidateId: string,
  generation: number,
  input: BuildImpulseEntryLifecycleInput["confirmation"],
  now: string,
): CandidateConfirmationContract {
  return {
    candidateId,
    generation,
    status: "building",
    startedAt: now,
    method: input.method,
    timeframe: input.timeframe,
    refinementTimeframe: input.refinementTimeframe,
    protectedLevel: null,
    breakLevel: null,
    lockedAt: null,
    expiresAt: input.expiresAt,
    revisions: [],
    confirmedAt: null,
  };
}

export function buildImpulseEntryLifecycle(
  input: BuildImpulseEntryLifecycleInput,
): ImpulseEntryLifecycle {
  const { impulse } = input;
  if (!impulse.id || !(impulse.rangeHigh > impulse.rangeLow) ||
    !finite(impulse.protectedLevel)) {
    throw new Error("Impulse authority is incomplete");
  }

  const seen = new Set<string>();
  const rankedCandidates = input.candidates
    .filter((candidate) => {
      if (!candidate.id || seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return candidate.impulseId === impulse.id &&
        candidate.high > candidate.low &&
        candidate.low >= impulse.rangeLow &&
        candidate.high <= impulse.rangeHigh;
    })
    .map((candidate) => ({
      ...candidate,
      depth: depthFor(
        impulse.direction,
        impulse.rangeLow,
        impulse.rangeHigh,
        candidate,
      ),
    }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const selectedDepth = rankedCandidates.find((candidate) =>
    candidate.id === input.initialCandidateId
  )?.depth;
  const candidates = rankedCandidates
    .filter((candidate) =>
      selectedDepth === undefined || candidate.depth >= selectedDepth
    )
    .sort((a, b) => {
      if (a.id === input.initialCandidateId) return -1;
      if (b.id === input.initialCandidateId) return 1;
      return a.depth - b.depth || a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(1, input.maxCandidates ?? 3))
    .map((candidate, index): ImpulseEntryCandidate => ({
      ...candidate,
      rank: index + 1,
      state: index === 0 ? "active" : "queued",
      activatedAt: index === 0 ? input.now : null,
      failedAt: null,
      failureReason: null,
    }));

  const active = candidates[0] ?? null;
  return {
    contractVersion: IMPULSE_ENTRY_LIFECYCLE_VERSION,
    mode: input.mode ?? "observe",
    impulse: { ...impulse },
    status: active ? "active" : "exhausted",
    activeCandidateId: active?.id ?? null,
    candidates,
    confirmation: active
      ? newConfirmation(active.id, 1, input.confirmation, input.now)
      : null,
    revision: 1,
    lastTransitionReason: active
      ? `Activated ${active.type} candidate ${active.id}`
      : "No eligible zone candidate belongs to the frozen impulse",
  };
}

export type ImpulseEntryLifecycleEvent =
  | { type: "zone_touched"; at: string }
  | { type: "candidate_failed"; at: string; reason: string }
  | {
    type: "trigger_revised";
    at: string;
    protectedLevel: number;
    breakLevel: number;
    reason: string;
  }
  | {
    type: "trigger_locked";
    at: string;
    protectedLevel: number;
    breakLevel: number;
  }
  | { type: "confirmation_passed"; at: string }
  | { type: "impulse_invalidated"; at: string; reason: string }
  | { type: "expired"; at: string };

export function transitionImpulseEntryLifecycle(
  current: ImpulseEntryLifecycle,
  event: ImpulseEntryLifecycleEvent,
): ImpulseEntryLifecycle {
  if (current.contractVersion !== IMPULSE_ENTRY_LIFECYCLE_VERSION) {
    throw new Error("Unsupported impulse entry lifecycle version");
  }
  if (
    ["entered", "invalidated", "expired", "exhausted"].includes(
      current.status,
    )
  ) {
    return current;
  }

  const next: ImpulseEntryLifecycle = structuredClone(current);
  next.revision += 1;
  const activeIndex = next.candidates.findIndex((candidate) =>
    candidate.id === next.activeCandidateId
  );
  const active = activeIndex >= 0 ? next.candidates[activeIndex] : null;

  if (event.type === "impulse_invalidated") {
    next.status = "invalidated";
    next.activeCandidateId = null;
    if (active && active.state !== "entered") active.state = "failed";
    if (next.confirmation) next.confirmation.status = "cancelled";
    next.lastTransitionReason = event.reason;
    return next;
  }
  if (event.type === "expired") {
    next.status = "expired";
    next.activeCandidateId = null;
    if (active) active.state = "expired";
    if (next.confirmation) next.confirmation.status = "cancelled";
    next.lastTransitionReason = "Impulse entry lifecycle expired";
    return next;
  }
  if (!active || !next.confirmation) return current;

  if (event.type === "zone_touched") {
    if (active.state === "confirming") return current;
    active.state = "confirming";
    next.lastTransitionReason = `Price touched candidate ${active.id}; confirmation is building`;
    return next;
  }
  if (event.type === "trigger_revised") {
    if (next.confirmation.status !== "building") return current;
    const last = next.confirmation.revisions.at(-1);
    if (last?.protectedLevel === event.protectedLevel &&
      last?.breakLevel === event.breakLevel) return current;
    next.confirmation.protectedLevel = event.protectedLevel;
    next.confirmation.breakLevel = event.breakLevel;
    next.confirmation.revisions.push({
      revision: next.confirmation.revisions.length + 1,
      protectedLevel: event.protectedLevel,
      breakLevel: event.breakLevel,
      observedAt: event.at,
      reason: event.reason,
    });
    next.lastTransitionReason = event.reason;
    return next;
  }
  if (event.type === "trigger_locked") {
    if (next.confirmation.status !== "building") return current;
    next.confirmation.status = "trigger_locked";
    next.confirmation.protectedLevel = event.protectedLevel;
    next.confirmation.breakLevel = event.breakLevel;
    next.confirmation.lockedAt = event.at;
    if (next.confirmation.revisions.length === 0) {
      next.confirmation.revisions.push({
        revision: 1, protectedLevel: event.protectedLevel,
        breakLevel: event.breakLevel, observedAt: event.at,
        reason: "Initial trigger locked by qualified displacement",
      });
    }
    active.state = "confirming";
    next.lastTransitionReason = `Locked confirmation trigger ${event.breakLevel} for candidate ${active.id}`;
    return next;
  }
  if (event.type === "confirmation_passed") {
    if (next.confirmation.status !== "trigger_locked") return current;
    next.confirmation.status = "confirmed";
    next.confirmation.confirmedAt = event.at;
    active.state = "entered";
    next.status = "entered";
    next.lastTransitionReason = `Candidate ${active.id} confirmed entry`;
    return next;
  }

  active.state = "failed";
  active.failedAt = event.at;
  active.failureReason = event.reason;
  next.confirmation.status = "cancelled";
  const replacement = next.candidates.find((candidate, index) =>
    index > activeIndex && candidate.state === "queued" &&
    candidate.depth > active.depth
  );
  if (!replacement) {
    next.status = "exhausted";
    next.activeCandidateId = null;
    next.confirmation = null;
    next.lastTransitionReason = `${event.reason}; no deeper prequalified candidate remains`;
    return next;
  }
  replacement.state = "active";
  replacement.activatedAt = event.at;
  next.activeCandidateId = replacement.id;
  next.confirmation = newConfirmation(
    replacement.id,
    current.confirmation.generation + 1,
    {
      method: current.confirmation.method,
      timeframe: current.confirmation.timeframe,
      refinementTimeframe: current.confirmation.refinementTimeframe,
      expiresAt: current.confirmation.expiresAt,
    },
    event.at,
  );
  next.lastTransitionReason = `${event.reason}; activated deeper ${replacement.type} candidate ${replacement.id}`;
  return next;
}

export function candidateFailedByClose(
  lifecycle: ImpulseEntryLifecycle,
  close: number,
): boolean {
  const active = lifecycle.candidates.find((candidate) =>
    candidate.id === lifecycle.activeCandidateId
  );
  if (!active) return false;
  return lifecycle.impulse.direction === "long"
    ? close < active.low
    : close > active.high;
}

export function impulseInvalidatedByClose(
  lifecycle: ImpulseEntryLifecycle,
  close: number,
): boolean {
  return lifecycle.impulse.direction === "long"
    ? close < lifecycle.impulse.protectedLevel
    : close > lifecycle.impulse.protectedLevel;
}
