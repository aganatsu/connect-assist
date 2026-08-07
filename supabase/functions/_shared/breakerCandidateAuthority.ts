export const BREAKER_CANDIDATE_AUTHORITY_VERSION = "breaker-candidate-authority.v1";

export type BreakerSemantic = "base_breaker_zone" | "sweep_displacement_retest_breaker_setup";

export interface NormalizedBreakerCandidate {
  contractVersion: typeof BREAKER_CANDIDATE_AUTHORITY_VERSION;
  semantic: BreakerSemantic;
  candidateId: string;
  direction: "long" | "short";
  low: number;
  high: number;
  timeframe: string;
  structureBreakIndex: number | null;
  retestComplete: boolean;
  impulseId: string | null;
  impulseOwned: boolean;
  eligibleForUnifiedQueue: boolean;
  reasonCodes: string[];
}

export function normalizeBreakerCandidate(input: {
  semantic: BreakerSemantic;
  symbol: string;
  direction: "long" | "short";
  low: number;
  high: number;
  timeframe: string;
  structureBreakIndex?: unknown;
  retestComplete?: boolean;
  impulse?: { id: string; low: number; high: number; direction: "long" | "short" } | null;
}): NormalizedBreakerCandidate {
  const validBounds = Number.isFinite(input.low) && Number.isFinite(input.high) && input.high > input.low;
  const sameDirection = input.impulse?.direction === input.direction;
  const contained = !!input.impulse && validBounds && input.low >= input.impulse.low && input.high <= input.impulse.high;
  const structureBreakIndex = Number.isInteger(Number(input.structureBreakIndex)) ? Number(input.structureBreakIndex) : null;
  const impulseOwned = !!input.impulse && sameDirection && contained;
  const eligibleForUnifiedQueue = validBounds && impulseOwned && structureBreakIndex !== null;
  const candidateId = [input.symbol, input.timeframe, input.semantic, input.direction, input.low, input.high, structureBreakIndex ?? "na"].join(":");
  return {
    contractVersion: BREAKER_CANDIDATE_AUTHORITY_VERSION,
    semantic: input.semantic, candidateId, direction: input.direction,
    low: input.low, high: input.high, timeframe: input.timeframe,
    structureBreakIndex, retestComplete: input.retestComplete === true,
    impulseId: input.impulse?.id || null, impulseOwned,
    eligibleForUnifiedQueue,
    reasonCodes: [
      validBounds ? "bounds_valid" : "bounds_invalid",
      input.impulse ? (sameDirection ? "impulse_direction_matches" : "impulse_direction_conflict") : "impulse_unavailable",
      contained ? "contained_in_frozen_impulse" : "outside_frozen_impulse",
      structureBreakIndex !== null ? "opposite_structure_owned" : "structure_ownership_missing",
      input.retestComplete ? "retest_complete" : "retest_pending",
    ],
  };
}
