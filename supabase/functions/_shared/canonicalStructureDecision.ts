import type { CanonicalStructureAuthority, StructureDirection } from "./canonicalStructureAuthority.ts";
import type { CanonicalLiquiditySequenceReport } from "./canonicalLiquiditySequence.ts";

export const CANONICAL_STRUCTURE_DECISION_VERSION = "canonical-structure-decision.v1";

export function evaluateCanonicalStructureDecision(input: { direction: "long" | "short" | null; structure: CanonicalStructureAuthority; liquidity: CanonicalLiquiditySequenceReport; requireLiquiditySweep: boolean }) {
  const direction: StructureDirection | null = input.direction === "long" ? "bullish" : input.direction === "short" ? "bearish" : null;
  const externalTrend = input.structure.trend.external;
  const opposingExternal = direction !== null && externalTrend !== "ranging" && externalTrend !== direction;
  const sequence = direction ? [...input.liquidity.sequences].reverse().find((item) => item.direction === direction) || null : null;
  const shiftReady = sequence?.shift?.type === "choch" || sequence?.shift?.type === "mss";
  const liquidityReady = input.requireLiquiditySweep ? sequence?.entryReady === true : shiftReady;
  const available = direction !== null && input.structure.levels.length > 0;
  const decision = !available ? "unavailable" : opposingExternal ? "block" : liquidityReady ? "allow" : "watch";
  return { contractVersion: CANONICAL_STRUCTURE_DECISION_VERSION, observationOnly: true as const, affectsAuthorization: false as const, decision, direction, externalTrend, internalTrend: input.structure.trend.internal, requireLiquiditySweep: input.requireLiquiditySweep, sequenceId: sequence?.id || null, eventIds: [sequence?.sweep?.id, sequence?.shift?.id].filter(Boolean), reasonCode: !available ? "structure_unavailable" : opposingExternal ? "external_structure_opposes_setup" : liquidityReady ? "structure_sequence_ready" : input.requireLiquiditySweep ? "sweep_and_shift_pending" : "structure_shift_pending" } as const;
}

export function evaluateCanonicalStructureEnforcement(input: { requestedMode?: unknown; singleOwnershipEffectiveMode: "observe" | "enforce" | "enforce_live"; decision: ReturnType<typeof evaluateCanonicalStructureDecision> }) {
  const requestedMode = input.requestedMode === "enforce" ? "enforce" : "observe";
  const effectiveMode = requestedMode === "enforce" && input.singleOwnershipEffectiveMode === "enforce" ? "enforce" : "observe";
  return { contractVersion: "canonical-structure-enforcement.v1", requestedMode, effectiveMode, affectsAuthorization: effectiveMode === "enforce", authorized: effectiveMode === "observe" || input.decision.decision === "allow", reasonCode: effectiveMode === "observe" ? (requestedMode === "enforce" ? "single_ownership_required" : "observing") : input.decision.reasonCode } as const;
}
