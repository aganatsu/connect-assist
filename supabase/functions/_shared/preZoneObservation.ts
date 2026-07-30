export type UnifiedWatchDisposition =
  | "none"
  | "pre_zone_observation"
  | "execution_watch"
  | "ready";

export interface UnifiedWatchInput {
  requireUnifiedZone: boolean;
  unifiedGatePassed: boolean;
  unifiedState: string | null | undefined;
  hasZone: boolean;
  stagingEnabled: boolean;
  hasDirection: boolean;
  isPaused: boolean;
  score: number;
  watchThreshold: number;
  tier1Count: number;
}

const COMPLETE_WAITING_STATES = new Set([
  "watching",
  "at_zone",
  "waiting_for_sweep",
]);

/**
 * Classifies visibility separately from execution.
 *
 * A hard unified-zone requirement remains authoritative for execution. A
 * directional candidate can still be observed before a zone exists, but that
 * row is explicitly non-executable. Once a complete zone appears, the scanner
 * must create a fresh execution candidate rather than rewriting the original
 * frozen evidence.
 */
export function classifyUnifiedWatch(
  input: UnifiedWatchInput,
): UnifiedWatchDisposition {
  if (input.unifiedGatePassed) return "ready";
  if (
    !input.stagingEnabled ||
    !input.hasDirection ||
    input.isPaused
  ) {
    return "none";
  }
  if (
    input.hasZone &&
    COMPLETE_WAITING_STATES.has(input.unifiedState || "") &&
    (
      input.requireUnifiedZone ||
      input.unifiedState === "waiting_for_sweep"
    )
  ) {
    return "execution_watch";
  }
  if (!input.requireUnifiedZone) return "none";
  if (
    (input.unifiedState === "no_zone" ||
      input.unifiedState === "no_impulse") &&
    input.score >= input.watchThreshold &&
    input.tier1Count >= 1
  ) {
    return "pre_zone_observation";
  }
  return "none";
}

export function isPreZoneObservation(
  setup: Record<string, unknown> | null | undefined,
): boolean {
  if (!setup) return false;
  return setup.execution_eligible === false ||
    setup.setup_type === "waiting_for_unified_zone";
}

export function requiresFreshCandidateHandoff(
  setup: Record<string, unknown> | null | undefined,
  nextExecutionEligible: boolean,
): boolean {
  if (!setup) return false;
  return isPreZoneObservation(setup) !== !nextExecutionEligible;
}
