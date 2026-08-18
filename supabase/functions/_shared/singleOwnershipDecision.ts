import type { DirectionVerdictPolicy } from "./decisionContract.ts";

export const SINGLE_OWNERSHIP_DECISION_VERSION =
  "single-ownership-decision.v1";

export type SingleOwnershipDecision =
  | "allow"
  | "watch"
  | "block"
  | "unavailable";

export interface SingleOwnershipDecisionInput {
  evaluatedAt: string;
  identity: {
    candidateId: string;
    symbol: string;
    direction: "long" | "short" | null;
  };
  direction: {
    verdict: "long" | "short" | "neutral" | null;
    shouldBlock: boolean | null;
    evidenceId?: string | null;
    policy?: DirectionVerdictPolicy;
  };
  zoneStory: {
    available: boolean;
    valid: boolean | null;
    entryReady: boolean | null;
    source: string | null;
    candidateId?: string | null;
    impulseId?: string | null;
    poiType?: string | null;
    reasonCodes: string[];
  };
  canonicalLocation: {
    required: boolean;
    available: boolean;
    allowed: boolean | null;
    rangeId?: string | null;
    reasonCode?: string | null;
  };
  confirmation: {
    required: boolean;
    passed: boolean | null;
    authorityVersion?: string | null;
    reasonCodes: string[];
  };
  thesis: {
    required: boolean;
    valid: boolean | null;
    reasonCodes: string[];
  };
  safety: {
    complete: boolean;
    checks: Array<{ code: string; passed: boolean }>;
  };
  legacyDiagnostics?: {
    rawScore?: number | null;
    effectiveScore?: number | null;
    threshold?: number | null;
    tier1Count?: number | null;
    tier2Count?: number | null;
    tier3Count?: number | null;
    tier1GatePassed?: boolean | null;
  } | null;
}

export interface SingleOwnershipDecisionResult {
  contractVersion: typeof SINGLE_OWNERSHIP_DECISION_VERSION;
  observationOnly: true;
  affectsAuthorization: false;
  evaluatedAt: string;
  identity: SingleOwnershipDecisionInput["identity"];
  authorities: {
    direction: SingleOwnershipDecisionInput["direction"];
    zoneStory: SingleOwnershipDecisionInput["zoneStory"];
    canonicalLocation: SingleOwnershipDecisionInput["canonicalLocation"];
    confirmation: SingleOwnershipDecisionInput["confirmation"];
    thesis: SingleOwnershipDecisionInput["thesis"];
    safety: SingleOwnershipDecisionInput["safety"];
  };
  decision: SingleOwnershipDecision;
  reasonCodes: string[];
  completeness: { complete: boolean; unavailable: string[] };
  legacyDiagnostics: NonNullable<SingleOwnershipDecisionInput["legacyDiagnostics"]>;
}

const OPERATIONAL_SAFETY_CODES = new Set([
  "instrument_disabled", "max_positions", "max_per_symbol",
  "duplicate_position", "portfolio_heat", "daily_loss_limit",
  "drawdown_limit", "consecutive_loss_limit", "cooldown",
  "high_impact_news", "correlation", "minimum_risk_reward",
  "spread", "invalid_sl_tp",
]);

export function operationalSafetyChecks(
  checks: Array<{ code: string; passed: boolean }>,
): Array<{ code: string; passed: boolean }> {
  const collapsed = new Map<string, boolean>();
  for (const check of checks) {
    if (!OPERATIONAL_SAFETY_CODES.has(check.code)) continue;
    collapsed.set(check.code, (collapsed.get(check.code) ?? true) && check.passed);
  }
  return [...collapsed.entries()]
    .map(([code, passed]) => ({ code, passed }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function evaluateSingleOwnershipDecision(
  input: SingleOwnershipDecisionInput,
): SingleOwnershipDecisionResult {
  const unavailable: string[] = [];
  const reasons: string[] = [];

  const retainFrozenDirection = input.direction.policy ===
    "retain_frozen_until_opposed";
  const explicitOpposite = input.direction.shouldBlock === false &&
      (input.direction.verdict === "long" || input.direction.verdict === "short")
    ? input.direction.verdict !== input.identity.direction
    : false;
  if (retainFrozenDirection && explicitOpposite) {
    reasons.push("direction_not_authorized");
  } else if (
    !input.direction.verdict || input.direction.shouldBlock === null ||
    (retainFrozenDirection &&
      (input.direction.shouldBlock || input.direction.verdict === "neutral"))
  ) {
    unavailable.push("direction");
  } else if (
    input.direction.shouldBlock || input.direction.verdict === "neutral" ||
    input.direction.verdict !== input.identity.direction
  ) {
    reasons.push("direction_not_authorized");
  }

  if (!input.zoneStory.available || input.zoneStory.valid === null) {
    unavailable.push("zone_story");
  } else if (!input.zoneStory.valid) {
    reasons.push("zone_story_invalid");
  } else if (input.zoneStory.entryReady === false) {
    reasons.push("zone_story_waiting");
  } else if (input.zoneStory.entryReady === null) {
    unavailable.push("zone_story_entry_readiness");
  }

  if (input.canonicalLocation.required) {
    if (
      !input.canonicalLocation.available ||
      input.canonicalLocation.allowed === null
    ) {
      unavailable.push("canonical_location");
    } else if (!input.canonicalLocation.allowed) {
      reasons.push(input.canonicalLocation.reasonCode ||
        "canonical_location_blocked");
    }
  }

  if (input.confirmation.required) {
    if (input.confirmation.passed === null) {
      unavailable.push("confirmation");
    } else if (!input.confirmation.passed) {
      reasons.push("confirmation_waiting");
    }
  }

  if (input.thesis.required) {
    if (input.thesis.valid === null) {
      unavailable.push("thesis");
    } else if (!input.thesis.valid) {
      reasons.push("thesis_invalid");
    }
  }

  if (!input.safety.complete) unavailable.push("safety");
  for (const check of input.safety.checks) {
    if (!check.passed) reasons.push(`safety_${check.code}`);
  }

  const normalizedReasons = unique(reasons);
  const normalizedUnavailable = unique(unavailable);
  const hardBlocked = normalizedReasons.some((reason) =>
    reason !== "zone_story_waiting" && reason !== "confirmation_waiting"
  );
  const waiting = normalizedReasons.includes("zone_story_waiting") ||
    normalizedReasons.includes("confirmation_waiting");
  const decision: SingleOwnershipDecision = hardBlocked
    ? "block"
    : normalizedUnavailable.length > 0
    ? "unavailable"
    : waiting
    ? "watch"
    : "allow";

  return {
    contractVersion: SINGLE_OWNERSHIP_DECISION_VERSION,
    observationOnly: true,
    affectsAuthorization: false,
    evaluatedAt: input.evaluatedAt,
    identity: input.identity,
    authorities: {
      direction: input.direction,
      zoneStory: input.zoneStory,
      canonicalLocation: input.canonicalLocation,
      confirmation: input.confirmation,
      thesis: input.thesis,
      safety: input.safety,
    },
    decision,
    reasonCodes: normalizedReasons,
    completeness: {
      complete: normalizedUnavailable.length === 0,
      unavailable: normalizedUnavailable,
    },
    legacyDiagnostics: input.legacyDiagnostics || {},
  };
}
