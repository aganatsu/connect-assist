import {
  evaluateSingleOwnershipDecision,
  operationalSafetyChecks,
  type SingleOwnershipDecisionResult,
} from "./singleOwnershipDecision.ts";
import { evaluateSingleOwnershipEnforcement } from "./singleOwnershipEnforcement.ts";
import { normalizeRejectedGate } from "./rejectedSetupLogger.ts";

export function evaluateSingleOwnershipFillAuthorization(input: {
  frozenDecision: SingleOwnershipDecisionResult | null;
  evaluatedAt: string;
  candidateId: string;
  symbol: string;
  direction: "long" | "short";
  directionVerdict: { verdict?: string | null; shouldBlock?: boolean | null; id?: string | null } | null;
  canonicalLocation: { required: boolean; available: boolean; allowed: boolean | null; rangeId?: string | null; reasonCode?: string | null };
  confirmation: { passed: boolean; authorityVersion?: string | null; reasonCodes?: string[] };
  thesis: { valid: boolean | null; reasonCodes?: string[] };
  finalChecks: Array<{ passed: boolean; reason: string }>;
  rawFinalAuthorized: boolean;
  requestedMode?: unknown;
  runtimeTarget: "paper" | "live";
}) {
  const frozenZone = input.frozenDecision?.authorities.zoneStory;
  const decision = evaluateSingleOwnershipDecision({
    evaluatedAt: input.evaluatedAt,
    identity: {
      candidateId: input.candidateId,
      symbol: input.symbol,
      direction: input.direction,
    },
    direction: {
      verdict: input.directionVerdict?.verdict === "long" || input.directionVerdict?.verdict === "short" || input.directionVerdict?.verdict === "neutral"
        ? input.directionVerdict.verdict
        : null,
      shouldBlock: input.directionVerdict?.shouldBlock ?? null,
      evidenceId: input.directionVerdict?.id || null,
    },
    zoneStory: frozenZone ? { ...frozenZone, entryReady: true, reasonCodes: [...frozenZone.reasonCodes, "fill_confirmation_ready"] } : {
      available: false,
      valid: null,
      entryReady: null,
      source: null,
      reasonCodes: ["frozen_zone_story_unavailable"],
    },
    canonicalLocation: input.canonicalLocation,
    confirmation: {
      required: true,
      passed: input.confirmation.passed,
      authorityVersion: input.confirmation.authorityVersion || null,
      reasonCodes: input.confirmation.reasonCodes || [],
    },
    thesis: {
      required: true,
      valid: input.thesis.valid,
      reasonCodes: input.thesis.reasonCodes || [],
    },
    safety: {
      complete: true,
      checks: operationalSafetyChecks(input.finalChecks.map((check) => ({
        code: normalizeRejectedGate(check.reason),
        passed: check.passed,
      }))),
    },
    legacyDiagnostics: input.frozenDecision?.legacyDiagnostics || null,
  });
  const enforcement = evaluateSingleOwnershipEnforcement({
    requestedMode: input.requestedMode,
    runtimeTarget: input.runtimeTarget,
    decision,
  });
  const ownershipAllows = enforcement.effectiveMode !== "enforce" ||
    enforcement.authorized;
  return {
    decision,
    enforcement,
    authorized: input.rawFinalAuthorized && ownershipAllows,
  };
}
