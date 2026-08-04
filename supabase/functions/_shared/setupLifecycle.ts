import {
  type DirectionVerdictDecision,
  TRADE_DECISION_CONTRACT_VERSION,
  type TradeDecisionContext,
} from "./decisionContract.ts";
import type { SessionGamePlan } from "./gamePlan.ts";
import type { ResolvedStylePolicy } from "./stylePolicy.ts";
import type { FrozenRuntimeConfigSnapshot } from "./runtimeConfigStore.ts";
import type { MarketConceptEvidence } from "./conceptEvidence.ts";
import type { ZoneLocalConfluenceObservation } from "./zoneLocalConfluence.ts";
import type { ZoneCandidateShadowRanking } from "./zoneCandidateShadowRanking.ts";
import type { ZoneLocalEnforcementDecision } from "./zoneLocalEnforcement.ts";
import type {
  CrossTimeframeEntryAuthorityDecision,
} from "./crossTimeframeEntryAuthority.ts";
import type {
  FrozenCrossTimeframeContext,
} from "./frozenCrossTimeframeContext.ts";
import {
  WATCHLIST_LIFECYCLE_EVIDENCE_VERSION,
  type WatchlistLifecycleEvidence,
  type WatchlistLifecycleReasonCode,
} from "./watchlistLifecycleEvidence.ts";

export const SETUP_LIFECYCLE_VERSION = "phase4.v1";
export const THESIS_VALIDATION_VERSION = "thesis.v1";
export const FROZEN_SETUP_POLICY_VERSION = "setup-policy-freeze.v1";
export const SCENARIO_ZONE_STORY_VERSION = "scenario-zone-story.v1";

export type SetupLifecycleStatus =
  | "watching"
  | "qualified"
  | "pending"
  | "awaiting_confirmation"
  | "filled"
  | "blocked_after_qualification"
  | "invalidated"
  | "expired"
  | "cancelled";

export type ConfirmationMethod =
  | "choch"
  | "indicators"
  | "choch_and_indicators";

export interface SetupLifecycleIdentity {
  setupId: string;
  candidateId: string;
}

export interface SetupLifecycleEvidence {
  [key: string]: unknown;
  lifecycleVersion: string;
  candidateId: string;
  setupId: string;
  gamePlanId: string | null;
  gamePlanVersion: string | null;
  directionVerdictId: string | null;
  directionVerdictVersion: string | null;
  thesisVersion: string;
  decisionContractVersion: string;
  confirmationMethod: ConfirmationMethod;
  originatingZone: Record<string, unknown> | null;
  frozenStrategyContext?: FrozenSetupStrategyContext | null;
}

export interface FrozenSetupStrategyContext {
  contractVersion: typeof FROZEN_SETUP_POLICY_VERSION;
  frozenAt: string;
  setupId: string;
  candidateId: string;
  /** Exact observation-only source row captured during the originating scan. */
  timeframeEvidenceId: string | null;
  symbol: string;
  direction: "long" | "short";
  stylePolicy: ResolvedStylePolicy;
  runtimeConfig: FrozenRuntimeConfigSnapshot | null;
  decisionContext: TradeDecisionContext | null;
  gamePlan: {
    id: string | null;
    version: string | null;
    validityPolicy: unknown | null;
  };
  directionVerdict: DirectionVerdictDecision | null;
  /** Observe-only primitive evidence attached to this candidate. */
  conceptEvidence?: MarketConceptEvidence[];
  /** Observe-only zone-local qualifications frozen with the candidate. */
  zoneLocalConfluence?: ZoneLocalConfluenceObservation | null;
  /** Observe-only alternative candidate rank frozen for later outcomes. */
  zoneCandidateShadowRanking?: ZoneCandidateShadowRanking | null;
  /** Effective evidence-capped policy decision at candidate creation. */
  zoneLocalEnforcement?: ZoneLocalEnforcementDecision | null;
  /** Exact cross-timeframe authority and provenance frozen at qualification. */
  crossTimeframeContext?: FrozenCrossTimeframeContext | null;
  scenarioZoneStory: {
    contractVersion: typeof SCENARIO_ZONE_STORY_VERSION;
    enforcement: "observe_only";
    originatingZone: Record<string, unknown> | null;
    scenarioCandidates: Array<{
      index: number;
      direction: string;
      condition: string;
      action: string;
      target: number | null;
      invalidation: string | null;
    }>;
    selectedScenarioIndex: null;
    status: "captured" | "no_directional_scenario";
    reason: string;
  };
  confirmation: {
    method: ConfirmationMethod;
    indicatorMinCount: number;
    maxAttempts: number;
    timeframe: string;
    refinementTimeframe: string;
  };
}

const ALLOWED_TRANSITIONS: Record<
  SetupLifecycleStatus,
  SetupLifecycleStatus[]
> = {
  watching: [
    "qualified",
    "invalidated",
    "expired",
    "cancelled",
  ],
  qualified: [
    "pending",
    "filled",
    "blocked_after_qualification",
    "invalidated",
    "expired",
    "cancelled",
  ],
  pending: [
    "awaiting_confirmation",
    "filled",
    "invalidated",
    "expired",
    "cancelled",
  ],
  awaiting_confirmation: [
    "pending",
    "filled",
    "invalidated",
    "expired",
    "cancelled",
  ],
  filled: [],
  blocked_after_qualification: [],
  invalidated: [],
  expired: [],
  cancelled: [],
};

export function canTransitionSetup(
  from: SetupLifecycleStatus,
  to: SetupLifecycleStatus,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from]?.includes(to) === true;
}

function normalizeConfirmationMethod(
  value: unknown,
): ConfirmationMethod | null {
  return value === "choch" ||
      value === "indicators" ||
      value === "choch_and_indicators"
    ? value
    : null;
}

function parseSignalReason(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function normalizeIndicatorMinimum(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 4
    ? Math.trunc(parsed)
    : 3;
}

function normalizeMaxConfirmationAttempts(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 3;
}

function isResolvedStylePolicy(
  value: unknown,
): value is ResolvedStylePolicy {
  const policy = asRecord(value);
  return typeof policy.contractVersion === "string" &&
    typeof policy.policyHash === "string" &&
    typeof policy.basePolicyHash === "string" &&
    typeof policy.style === "string" &&
    !!policy.timeframes &&
    !!policy.lifecycle;
}

export function buildFrozenSetupStrategyContext(input: {
  identity: SetupLifecycleIdentity;
  timeframeEvidenceId?: string | null;
  symbol: string;
  direction: "long" | "short";
  stylePolicy: ResolvedStylePolicy;
  runtimeConfig?: FrozenRuntimeConfigSnapshot | null;
  decisionContext?: TradeDecisionContext | null;
  gamePlan: SessionGamePlan | null;
  directionVerdict: DirectionVerdictDecision | null;
  conceptEvidence?: MarketConceptEvidence[];
  zoneLocalConfluence?: ZoneLocalConfluenceObservation | null;
  zoneCandidateShadowRanking?: ZoneCandidateShadowRanking | null;
  zoneLocalEnforcement?: ZoneLocalEnforcementDecision | null;
  crossTimeframeContext?: FrozenCrossTimeframeContext | null;
  originatingZone?: Record<string, unknown> | null;
  confirmationMethod: unknown;
  indicatorMinCount?: unknown;
  frozenAt?: string;
}): FrozenSetupStrategyContext {
  const pairPlan = input.gamePlan?.plans?.find((plan) =>
    plan.symbol === input.symbol
  );
  const scenarioCandidates = (pairPlan?.scenarios || [])
    .map((scenario, index) => ({ scenario, index }))
    .filter(({ scenario }) => scenario.direction === input.direction)
    .map(({ scenario, index }) => ({
      index,
      direction: scenario.direction,
      condition: scenario.condition,
      action: scenario.action,
      target: Number.isFinite(scenario.targetLevel)
        ? Number(scenario.targetLevel)
        : null,
      invalidation: scenario.invalidation || null,
    }));
  const confirmationMethod =
    normalizeConfirmationMethod(input.confirmationMethod) || "choch";
  return {
    contractVersion: FROZEN_SETUP_POLICY_VERSION,
    frozenAt: input.frozenAt || new Date().toISOString(),
    setupId: input.identity.setupId,
    candidateId: input.identity.candidateId,
    timeframeEvidenceId: input.timeframeEvidenceId || null,
    symbol: input.symbol,
    direction: input.direction,
    stylePolicy: input.stylePolicy,
    runtimeConfig: input.runtimeConfig || null,
    decisionContext: input.decisionContext || null,
    gamePlan: {
      id: pairPlan?.gamePlanId ||
        input.directionVerdict?.gamePlanId ||
        null,
      version: pairPlan?.planVersion ||
        input.directionVerdict?.gamePlanVersion ||
        input.gamePlan?.planVersion ||
        null,
      validityPolicy: input.gamePlan?.validityPolicy || null,
    },
    directionVerdict: input.directionVerdict
      ? { ...input.directionVerdict }
      : null,
    conceptEvidence: input.conceptEvidence || [],
    zoneLocalConfluence: input.zoneLocalConfluence || null,
    zoneCandidateShadowRanking: input.zoneCandidateShadowRanking || null,
    zoneLocalEnforcement: input.zoneLocalEnforcement || null,
    crossTimeframeContext: input.crossTimeframeContext || null,
    scenarioZoneStory: {
      contractVersion: SCENARIO_ZONE_STORY_VERSION,
      enforcement: "observe_only",
      originatingZone: input.originatingZone || null,
      scenarioCandidates,
      selectedScenarioIndex: null,
      status: scenarioCandidates.length > 0
        ? "captured"
        : "no_directional_scenario",
      reason: scenarioCandidates.length > 0
        ? "Directional Gameplan scenarios were frozen for later outcome analysis; no narrative scenario authorizes execution yet"
        : "No directional Gameplan scenario was available when the setup was frozen",
    },
    confirmation: {
      method: confirmationMethod,
      indicatorMinCount: normalizeIndicatorMinimum(
        input.indicatorMinCount,
      ),
      maxAttempts: normalizeMaxConfirmationAttempts(
        input.stylePolicy.lifecycle.maxConfirmationAttempts,
      ),
      timeframe: input.stylePolicy.timeframes.roles.confirmation,
      refinementTimeframe: input.stylePolicy.timeframes.roles.refinement,
    },
  };
}

export function readFrozenSetupStrategyContext(
  row: Record<string, unknown>,
): FrozenSetupStrategyContext | null {
  const signalReason = parseSignalReason(row.signal_reason);
  const candidates = [
    row.frozen_strategy_context,
    signalReason.frozenStrategyContext,
    signalReason.watchlistLifecycle?.frozenStrategyContext,
    asRecord(row.authorization_result).frozenStrategyContext,
    asRecord(
      asRecord(row.final_authorization).decisionContext,
    ).frozenStrategyContext,
  ];
  for (const candidate of candidates) {
    const context = asRecord(candidate);
    const confirmation = asRecord(context.confirmation);
    const scenarioZoneStory = asRecord(context.scenarioZoneStory);
    if (
      context.contractVersion === FROZEN_SETUP_POLICY_VERSION &&
      isResolvedStylePolicy(context.stylePolicy) &&
      typeof context.setupId === "string" &&
      typeof context.candidateId === "string" &&
      typeof context.symbol === "string" &&
      (context.direction === "long" || context.direction === "short") &&
      normalizeConfirmationMethod(confirmation.method) !== null &&
      typeof confirmation.timeframe === "string" &&
      typeof confirmation.refinementTimeframe === "string" &&
      scenarioZoneStory.contractVersion === SCENARIO_ZONE_STORY_VERSION &&
      scenarioZoneStory.enforcement === "observe_only"
    ) {
      return context as FrozenSetupStrategyContext;
    }
  }
  return null;
}

export function resolvePendingDealingRangeMode(
  pending: Record<string, unknown>,
  fallback: unknown,
): unknown {
  return readFrozenSetupStrategyContext(pending)?.runtimeConfig
    ?.effectiveConfig?.dealingRangeMode ?? fallback;
}

export function readFrozenCrossTimeframeAuthority(
  row: Record<string, unknown>,
): CrossTimeframeEntryAuthorityDecision | null {
  const frozen = readFrozenSetupStrategyContext(row);
  const authority = asRecord(
    asRecord(frozen?.crossTimeframeContext).authority,
  );
  if (
    authority.contractVersion === "cross-tf-entry-authority.v1" &&
    ["observe", "soft", "hard"].includes(String(authority.effectiveMode)) &&
    typeof authority.allowed === "boolean" &&
    Array.isArray(authority.reasonCodes)
  ) {
    return authority as unknown as CrossTimeframeEntryAuthorityDecision;
  }
  return null;
}

export function resolvePendingStylePolicy(
  pending: Record<string, unknown>,
  runtimePolicy: ResolvedStylePolicy,
): {
  policy: ResolvedStylePolicy;
  frozenContext: FrozenSetupStrategyContext | null;
  source: "frozen_setup" | "pending_snapshot" | "runtime_legacy";
} {
  const frozenContext = readFrozenSetupStrategyContext(pending);
  if (frozenContext) {
    return {
      policy: frozenContext.stylePolicy,
      frozenContext,
      source: "frozen_setup",
    };
  }
  const signalReason = parseSignalReason(pending.signal_reason);
  const savedPolicy = [
    pending.style_policy,
    asRecord(pending.decision_context).stylePolicy,
    signalReason.decisionContext?.stylePolicy,
  ].find(isResolvedStylePolicy);
  if (savedPolicy) {
    return {
      policy: savedPolicy,
      frozenContext: null,
      source: "pending_snapshot",
    };
  }
  return {
    policy: runtimePolicy,
    frozenContext: null,
    source: "runtime_legacy",
  };
}

export function validateFrozenSetupIdentity(
  pending: Record<string, unknown>,
  context: FrozenSetupStrategyContext | null,
): { valid: boolean; reason: string } {
  if (!context) {
    return {
      valid: true,
      reason: "Legacy setup has no frozen strategy context",
    };
  }
  const mismatches: string[] = [];
  if (
    pending.candidate_id &&
    String(pending.candidate_id) !== context.candidateId
  ) {
    mismatches.push("candidate ID");
  }
  if (pending.symbol && String(pending.symbol) !== context.symbol) {
    mismatches.push("symbol");
  }
  if (pending.direction && String(pending.direction) !== context.direction) {
    mismatches.push("direction");
  }
  if (mismatches.length > 0) {
    return {
      valid: false,
      reason: `Frozen setup identity mismatch: ${mismatches.join(", ")}`,
    };
  }
  return { valid: true, reason: "Frozen setup identity matches" };
}

export function resolvePendingMaxConfirmationAttempts(
  pending: Record<string, unknown>,
  runtimeConfig: { maxConfirmationAttempts?: unknown },
): number {
  const frozen = readFrozenSetupStrategyContext(pending);
  const confirmationConfig = asRecord(pending.confirmation_config);
  const candidates = [
    frozen?.confirmation.maxAttempts,
    confirmationConfig.maxConfirmationAttempts,
    frozen?.stylePolicy.lifecycle.maxConfirmationAttempts,
    runtimeConfig.maxConfirmationAttempts,
    3,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.trunc(parsed);
  }
  return 3;
}

/**
 * A waiting setup keeps the confirmation rule that was selected when it was
 * created. Runtime config is only the legacy fallback for rows created before
 * Phase 4.
 */
export function resolvePendingConfirmationMethod(
  pending: {
    confirmation_method?: unknown;
    signal_reason?: unknown;
  },
  runtimeConfig: { confirmationMethod?: unknown },
): ConfirmationMethod {
  const signalReason = parseSignalReason(pending.signal_reason);
  return normalizeConfirmationMethod(pending.confirmation_method) ||
    normalizeConfirmationMethod(
      signalReason?.watchlistLifecycle?.confirmationMethod,
    ) ||
    normalizeConfirmationMethod(signalReason?.confirmationMethod) ||
    normalizeConfirmationMethod(runtimeConfig.confirmationMethod) ||
    "choch";
}

export function resolvePendingIndicatorMinimum(
  pending: {
    confirmation_config?: unknown;
    signal_reason?: unknown;
  },
  runtimeConfig: { indicatorMinCount?: unknown },
): number {
  const signalReason = parseSignalReason(pending.signal_reason);
  const pendingConfig = pending.confirmation_config &&
      typeof pending.confirmation_config === "object"
    ? pending.confirmation_config as Record<string, unknown>
    : {};
  const candidates = [
    pendingConfig.indicatorMinCount,
    signalReason?.watchlistLifecycle?.confirmationConfig?.indicatorMinCount,
    signalReason?.indicatorMinCount,
    runtimeConfig.indicatorMinCount,
    3,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 4) {
      return Math.trunc(parsed);
    }
  }
  return 3;
}

export function buildSetupLifecycleEvidence(input: {
  identity: SetupLifecycleIdentity;
  symbol: string;
  gamePlan: SessionGamePlan | null;
  directionVerdict: DirectionVerdictDecision | null;
  confirmationMethod: unknown;
  originatingZone?: Record<string, unknown> | null;
  frozenStrategyContext?: FrozenSetupStrategyContext | null;
}): SetupLifecycleEvidence {
  const frozen = input.frozenStrategyContext || null;
  const pairPlan = input.gamePlan?.plans?.find((plan) =>
    plan.symbol === input.symbol
  );
  return {
    lifecycleVersion: SETUP_LIFECYCLE_VERSION,
    candidateId: input.identity.candidateId,
    setupId: input.identity.setupId,
    gamePlanId: frozen?.gamePlan.id ||
      pairPlan?.gamePlanId ||
      input.directionVerdict?.gamePlanId ||
      null,
    gamePlanVersion: frozen?.gamePlan.version ||
      pairPlan?.planVersion ||
      input.directionVerdict?.gamePlanVersion ||
      input.gamePlan?.planVersion ||
      null,
    directionVerdictId: frozen?.directionVerdict?.id ||
      input.directionVerdict?.id ||
      null,
    directionVerdictVersion: frozen?.directionVerdict?.verdictVersion ||
      input.directionVerdict?.verdictVersion ||
      null,
    thesisVersion: THESIS_VALIDATION_VERSION,
    decisionContractVersion: TRADE_DECISION_CONTRACT_VERSION,
    confirmationMethod: frozen?.confirmation.method ||
      normalizeConfirmationMethod(input.confirmationMethod) ||
      "choch",
    originatingZone: frozen?.scenarioZoneStory.originatingZone ||
      input.originatingZone ||
      null,
    frozenStrategyContext: frozen,
  };
}

export async function transitionStagedSetup(
  client: any,
  input: {
    setupId: string;
    userId: string;
    status: SetupLifecycleStatus;
    reason: string;
    reasonCode?: WatchlistLifecycleReasonCode;
    lifecycleEvidence?: WatchlistLifecycleEvidence | null;
    evidence?: Record<string, unknown> | null;
    pendingOrderId?: string | null;
    positionId?: string | null;
  },
): Promise<any> {
  const { data, error } = await client.rpc("transition_staged_setup", {
    p_setup_id: input.setupId,
    p_user_id: input.userId,
    p_to_status: input.status,
    p_reason: input.reason,
    p_evidence: {
      ...(input.evidence || {}),
      reasonCode: input.reasonCode || "legacy_transition",
      lifecycleEvidence: input.lifecycleEvidence || {
        version: WATCHLIST_LIFECYCLE_EVIDENCE_VERSION,
        reasonCode: input.reasonCode || "legacy_transition",
        observedAt: new Date().toISOString(),
      },
    },
    p_pending_order_id: input.pendingOrderId || null,
    p_position_id: input.positionId || null,
  });
  if (error) {
    throw new Error(
      `Could not transition staged setup to ${input.status}: ${error.message}`,
    );
  }
  if (data?.transitioned === false) {
    throw new Error(
      data.reason ||
        `Could not transition staged setup to ${input.status}`,
    );
  }
  return data?.row || data;
}
