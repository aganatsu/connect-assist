import type { DirectionVerdictPolicy } from "./decisionContract.ts";

export const SINGLE_OWNERSHIP_DECISION_VERSION =
  "single-ownership-decision.v2";
export const LEGACY_SINGLE_OWNERSHIP_DECISION_VERSION =
  "single-ownership-decision.v1";

export type SingleOwnershipDecision =
  | "allow"
  | "watch"
  | "block"
  | "unavailable";

export interface EntryZoneAuthorityDecision {
  available: boolean;
  valid: boolean | null;
  entryReady: boolean | null;
  source: string | null;
  candidateId?: string | null;
  setupFamily?: "impulse" | "cascade" | "structure_poi" | null;
  sourceEvidenceIds?: string[];
  impulseId?: string | null;
  poiType?: string | null;
  reasonCodes: string[];
}

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
  entryZone: EntryZoneAuthorityDecision;
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
    entryZone: SingleOwnershipDecisionInput["entryZone"];
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
  "spread", "invalid_sl_tp", "live_broker_connection_required",
  "multiple_live_connections_require_per_connection_sizing",
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

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function currentEntryZoneReason(value: unknown): string {
  return String(value || "")
    .replace(/^zone_story/, "entry_zone")
    .replace(/^frozen_zone_story/, "frozen_entry_zone");
}

function normalizeEntryZoneAuthorityDecision(
  value: unknown,
): EntryZoneAuthorityDecision | null {
  const zone = record(value);
  if (Object.keys(zone).length === 0) return null;
  if (
    typeof zone.available !== "boolean" ||
    ![true, false, null].includes(zone.valid) ||
    ![true, false, null].includes(zone.entryReady) ||
    (zone.source !== null && typeof zone.source !== "string") ||
    !Array.isArray(zone.reasonCodes)
  ) return null;
  const setupFamily = zone.setupFamily == null
    ? null
    : zone.setupFamily === "impulse" || zone.setupFamily === "cascade" ||
        zone.setupFamily === "structure_poi"
    ? zone.setupFamily
    : undefined;
  if (setupFamily === undefined) return null;
  const optionalString = (item: unknown): string | null | undefined =>
    item == null
      ? item as null | undefined
      : typeof item === "string" && item.length > 0
      ? item
      : undefined;
  const candidateId = optionalString(zone.candidateId);
  const impulseId = optionalString(zone.impulseId);
  const poiType = optionalString(zone.poiType);
  if (
    (zone.candidateId != null && candidateId === undefined) ||
    (zone.impulseId != null && impulseId === undefined) ||
    (zone.poiType != null && poiType === undefined)
  ) return null;
  const sourceEvidenceIds = zone.sourceEvidenceIds == null
    ? undefined
    : Array.isArray(zone.sourceEvidenceIds) &&
        zone.sourceEvidenceIds.every((item: unknown) =>
          typeof item === "string" && item.length > 0
        )
    ? [...new Set(zone.sourceEvidenceIds as string[])].sort()
    : null;
  if (sourceEvidenceIds === null) return null;
  return {
    available: zone.available,
    valid: zone.valid,
    entryReady: zone.entryReady,
    source: zone.source,
    ...(candidateId !== undefined ? { candidateId } : {}),
    ...(setupFamily !== null ? { setupFamily } : {}),
    ...(sourceEvidenceIds !== undefined ? { sourceEvidenceIds } : {}),
    ...(impulseId !== undefined ? { impulseId } : {}),
    ...(poiType !== undefined ? { poiType } : {}),
    reasonCodes: zone.reasonCodes.map(currentEntryZoneReason),
  };
}

/**
 * Reads both persisted v1 `zoneStory` decisions and current v2 `entryZone`
 * decisions into one in-memory shape. Historical rows are never rewritten.
 */
export function normalizeSingleOwnershipDecision(
  value: unknown,
): SingleOwnershipDecisionResult | null {
  const decision = record(value);
  const version = decision.contractVersion;
  if (
    version !== SINGLE_OWNERSHIP_DECISION_VERSION &&
    version !== LEGACY_SINGLE_OWNERSHIP_DECISION_VERSION
  ) return null;
  const authorities = record(decision.authorities);
  const completeness = record(decision.completeness);
  const rawEntryZone = record(
    version === LEGACY_SINGLE_OWNERSHIP_DECISION_VERSION
      ? authorities.zoneStory
      : authorities.entryZone,
  );
  const normalizedEntryZone = normalizeEntryZoneAuthorityDecision(rawEntryZone);
  if (
    (version === SINGLE_OWNERSHIP_DECISION_VERSION &&
      !normalizedEntryZone) ||
    !["allow", "watch", "block", "unavailable"].includes(decision.decision) ||
    !Array.isArray(decision.reasonCodes) ||
    !Array.isArray(completeness.unavailable)
  ) return null;
  const entryZone = normalizedEntryZone
    ? normalizedEntryZone
    : {
      available: false,
      valid: null,
      entryReady: null,
      source: null,
      reasonCodes: ["legacy_entry_zone_authority_unavailable"],
    };
  const normalizedAuthorities = {
    direction: authorities.direction,
    entryZone,
    canonicalLocation: authorities.canonicalLocation,
    confirmation: authorities.confirmation,
    thesis: authorities.thesis,
    safety: authorities.safety,
  } as SingleOwnershipDecisionResult["authorities"];
  return {
    contractVersion: SINGLE_OWNERSHIP_DECISION_VERSION,
    observationOnly: true,
    affectsAuthorization: false,
    evaluatedAt: String(decision.evaluatedAt || ""),
    identity: decision.identity,
    authorities: normalizedAuthorities,
    decision: decision.decision,
    reasonCodes: decision.reasonCodes.map(currentEntryZoneReason),
    completeness: {
      complete: completeness.complete === true,
      unavailable: completeness.unavailable.map(currentEntryZoneReason),
    },
    legacyDiagnostics: record(decision.legacyDiagnostics),
  } as SingleOwnershipDecisionResult;
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

  if (!input.entryZone.available || input.entryZone.valid === null) {
    unavailable.push("entry_zone");
  } else if (!input.entryZone.valid) {
    reasons.push("entry_zone_invalid");
  } else if (input.entryZone.entryReady === false) {
    reasons.push("entry_zone_waiting");
  } else if (input.entryZone.entryReady === null) {
    unavailable.push("entry_zone_entry_readiness");
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
    reason !== "entry_zone_waiting" && reason !== "confirmation_waiting"
  );
  const waiting = normalizedReasons.includes("entry_zone_waiting") ||
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
      entryZone: input.entryZone,
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
