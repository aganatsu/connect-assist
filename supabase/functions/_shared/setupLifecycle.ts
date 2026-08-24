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
import {
  buildICTConfirmationPolicy,
  type ICTConfirmationPolicy,
} from "./ictConfirmationPolicy.ts";
import {
  buildLiquidityActivationPolicy,
  type LiquidityActivationPolicy,
} from "./liquidityActivationPolicy.ts";
import type {
  CrossTimeframeEntryAuthorityDecision,
} from "./crossTimeframeEntryAuthority.ts";
import {
  type FrozenCrossTimeframeContext,
  validateImpulseLifecycleExecutableZone,
} from "./frozenCrossTimeframeContext.ts";
import {
  WATCHLIST_LIFECYCLE_EVIDENCE_VERSION,
  type WatchlistLifecycleEvidence,
  type WatchlistLifecycleReasonCode,
} from "./watchlistLifecycleEvidence.ts";
import {
  NESTED_POI_ENTRY_VERSION,
  type NestedPoiEntryPlan as NestedPoiSelectionPlan,
  type NestedPoiTriggerCandidate,
} from "./impulseZoneEngine.ts";
import {
  isNestedPoiMarketRouteCompatible,
  type NestedPoiMarketMode,
  type NestedPoiMarketRoute,
  normalizeNestedPoiMarketMode,
  normalizeNestedPoiMarketRoute,
} from "./botConfigBehavior.ts";
import { normalizeAnalysisTimeframeOrNull } from "./timeframeAuthority.ts";

export const SETUP_LIFECYCLE_VERSION = "phase4.v1";
export const THESIS_VALIDATION_VERSION = "thesis.v1";
export const FROZEN_SETUP_POLICY_VERSION = "setup-policy-freeze.v1";
export const SCENARIO_ZONE_STORY_VERSION = "scenario-zone-story.v1";
export const NESTED_POI_ENTRY_CONTRACT_VERSION = NESTED_POI_ENTRY_VERSION;

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

/** Immutable entry geometry selected from already-detected evidence. */
export interface FrozenNestedPoiEntryPlan extends NestedPoiSelectionPlan {
  mode: NestedPoiMarketMode;
  route: NestedPoiMarketRoute;
  monitoringTimeframe: string;
  direction: "long" | "short";
  frozenAt: string;
}

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
  /** Optional market-entry trigger frozen independently from the parent zone. */
  nestedPoiEntry?: FrozenNestedPoiEntryPlan | null;
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
  liquidityActivation: LiquidityActivationPolicy;
  confirmation: {
    method: ConfirmationMethod;
    indicatorMinCount: number;
    maxAttempts: number;
    timeframe: string;
    refinementTimeframe: string;
    policy: ICTConfirmationPolicy;
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

export const normalizeNestedPoiEntryMode = normalizeNestedPoiMarketMode;
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

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function nestedTriggerType(
  value: unknown,
): NestedPoiTriggerCandidate["type"] | null {
  return value === "ob" || value === "fvg" || value === "breaker" ||
      value === "support_resistance" || value === "fib"
    ? value
    : null;
}

function nestedTriggerSource(
  value: unknown,
): NestedPoiTriggerCandidate["source"] | null {
  return value === "impulse_fib" || value === "historical_sr" ||
      value === "htf_order_block" || value === "htf_fvg" ||
      value === "htf_breaker" || value === "htf_fib" ||
      value === "ltf_refinement" || value === "premium_discount" ||
      value === "liquidity_pool"
    ? value
    : null;
}

function normalizeNestedPoiTriggerCandidate(
  value: unknown,
  outerZone: { low: number; high: number; direction: "bullish" | "bearish" },
): NestedPoiTriggerCandidate | null {
  const candidate = asRecord(value);
  const id = nonEmptyString(candidate.id);
  const type = nestedTriggerType(candidate.type);
  const geometry =
    candidate.geometry === "range" || candidate.geometry === "level"
      ? candidate.geometry
      : null;
  const source = nestedTriggerSource(candidate.source);
  const direction = candidate.direction === "bullish" ||
      candidate.direction === "bearish"
    ? candidate.direction
    : null;
  const low = finiteNumber(candidate.low);
  const high = finiteNumber(candidate.high);
  const entryPrice = finiteNumber(candidate.entryPrice);
  const timeframe = nonEmptyString(candidate.timeframe);
  const evidenceId = nonEmptyString(candidate.evidenceId);
  const entityId = nonEmptyString(candidate.entityId);
  const independentEvidenceCount = finiteNumber(
    candidate.independentEvidenceCount,
  );
  const localScore = finiteNumber(candidate.localScore);
  const lifecycleRank = finiteNumber(candidate.lifecycleRank);
  const depth = finiteNumber(candidate.depth);
  const widthRatio = finiteNumber(candidate.widthRatio);
  const rank = finiteNumber(candidate.rank);
  if (
    !id || !type || !geometry || !source || !direction ||
    low === null || high === null || entryPrice === null || !timeframe ||
    !evidenceId || !entityId || independentEvidenceCount === null ||
    localScore === null || lifecycleRank === null || depth === null ||
    widthRatio === null || rank === null ||
    !Number.isInteger(independentEvidenceCount) ||
    independentEvidenceCount < 1 || localScore < 0 || lifecycleRank < 0 ||
    depth < 0 || depth > 1 || widthRatio < 0 || widthRatio > 1 ||
    !Number.isInteger(rank) || rank < 1 || direction !== outerZone.direction ||
    low <= outerZone.low || high >= outerZone.high || entryPrice < low ||
    entryPrice > high
  ) return null;
  if (
    geometry === "level"
      ? low !== high || entryPrice !== low ||
        (type !== "support_resistance" && type !== "fib")
      : !(high > low) || type === "support_resistance" || type === "fib"
  ) return null;

  const supportingEvidenceIds = Array.isArray(candidate.supportingEvidenceIds)
    ? candidate.supportingEvidenceIds.map(nonEmptyString).filter(
      (item): item is string => item !== null,
    )
    : [];
  const supportingFamilies = Array.isArray(candidate.supportingFamilies)
    ? candidate.supportingFamilies.map(nestedTriggerType).filter(
      (item): item is NestedPoiTriggerCandidate["type"] => item !== null,
    )
    : [];
  if (
    supportingEvidenceIds.length === 0 || supportingFamilies.length === 0 ||
    supportingEvidenceIds.length !== supportingFamilies.length ||
    independentEvidenceCount !== supportingFamilies.length
  ) return null;

  return {
    id,
    type,
    geometry,
    source,
    direction,
    low,
    high,
    entryPrice,
    timeframe,
    lifecycle: nonEmptyString(candidate.lifecycle),
    evidenceId,
    entityId,
    supportingEvidenceIds: Array.from(new Set(supportingEvidenceIds)),
    supportingFamilies: Array.from(new Set(supportingFamilies)),
    independentEvidenceCount,
    localScore,
    lifecycleRank,
    depth,
    widthRatio,
    rank,
  };
}

/**
 * Parses the shared nested-POI selection plan without repairing its geometry.
 * Invalid plans fail closed so callers never substitute a midpoint.
 */
export function normalizeNestedPoiEntryPlan(
  value: unknown,
): FrozenNestedPoiEntryPlan | null {
  const plan = asRecord(value);
  if (plan.contractVersion !== NESTED_POI_ENTRY_CONTRACT_VERSION) return null;
  if (plan.enforcement !== "observe_only") return null;
  if (
    plan.mode !== "off" && plan.mode !== "observe" &&
    plan.mode !== "enforce_paper" && plan.mode !== "enforce_live"
  ) return null;
  const route = normalizeNestedPoiMarketRoute(plan.route);
  if (!route || !isNestedPoiMarketRouteCompatible({ mode: plan.mode, route })) {
    return null;
  }
  const monitoringTimeframe = normalizeAnalysisTimeframeOrNull(
    plan.monitoringTimeframe,
  );
  if (!monitoringTimeframe) return null;
  if (plan.direction !== "long" && plan.direction !== "short") return null;

  const frozenAt = nonEmptyString(plan.frozenAt);
  const outer = asRecord(plan.outerZone);
  const outerLow = finiteNumber(outer.low);
  const outerHigh = finiteNumber(outer.high);
  const outerDirection = outer.direction === "bullish" ||
      outer.direction === "bearish"
    ? outer.direction
    : null;
  if (
    !frozenAt || outerLow === null || outerHigh === null ||
    !(outerHigh > outerLow) || !outerDirection ||
    (plan.direction === "long"
      ? outerDirection !== "bullish"
      : outerDirection !== "bearish")
  ) return null;

  const outerCandidateId = plan.outerCandidateId == null
    ? null
    : nonEmptyString(plan.outerCandidateId);
  if (plan.outerCandidateId != null && !outerCandidateId) return null;
  const outerZone = {
    low: outerLow,
    high: outerHigh,
    direction: outerDirection,
  };
  const rawCandidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const candidates = rawCandidates.map((candidate) =>
    normalizeNestedPoiTriggerCandidate(candidate, outerZone)
  );
  if (candidates.some((candidate) => candidate === null)) return null;
  const normalizedCandidates = candidates as NestedPoiTriggerCandidate[];
  const candidateIds = normalizedCandidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length) return null;

  const selected = plan.selected == null
    ? null
    : normalizeNestedPoiTriggerCandidate(plan.selected, outerZone);
  if (plan.selected != null && !selected) return null;
  if (
    selected &&
    !normalizedCandidates.some((candidate) =>
      candidate.id === selected.id &&
      JSON.stringify(candidate) === JSON.stringify(selected)
    )
  ) return null;
  const reason = plan.reason === "selected" ||
      plan.reason === "local_evidence_unavailable" ||
      plan.reason === "no_contained_trigger"
    ? plan.reason
    : null;
  if (!reason || (reason === "selected") !== (selected !== null)) return null;
  if (!selected && normalizedCandidates.length > 0) return null;

  return {
    contractVersion: NESTED_POI_ENTRY_CONTRACT_VERSION,
    enforcement: "observe_only",
    mode: plan.mode,
    route,
    monitoringTimeframe,
    direction: plan.direction,
    frozenAt,
    outerCandidateId,
    outerZone,
    selected,
    candidates: normalizedCandidates,
    reason,
  };
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
  nestedPoiEntry?: unknown;
  originatingZone?: Record<string, unknown> | null;
  confirmationMethod: unknown;
  indicatorMinCount?: unknown;
  liquiditySweepRole?: unknown;
  noQualifiedLiquidityPoolBehavior?: unknown;
  displacementRole?: unknown;
  reversalPatternRole?: unknown;
  afterChochEntryMode?: unknown;
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
  const indicatorMinimum = normalizeIndicatorMinimum(input.indicatorMinCount);
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
    nestedPoiEntry: normalizeNestedPoiEntryPlan(input.nestedPoiEntry),
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
    liquidityActivation: buildLiquidityActivationPolicy({
      role: input.liquiditySweepRole,
      noQualifiedPoolBehavior: input.noQualifiedLiquidityPoolBehavior,
    }),
    confirmation: {
      method: confirmationMethod,
      indicatorMinCount: indicatorMinimum,
      maxAttempts: normalizeMaxConfirmationAttempts(
        input.stylePolicy.lifecycle.maxConfirmationAttempts,
      ),
      timeframe: input.stylePolicy.timeframes.roles.confirmation,
      refinementTimeframe: input.stylePolicy.timeframes.roles.refinement,
      policy: buildICTConfirmationPolicy({
        method: confirmationMethod,
        confirmationTimeframe: input.stylePolicy.timeframes.roles.confirmation,
        refinementTimeframe: input.stylePolicy.timeframes.roles.refinement,
        indicatorMinimum,
        maxAttempts: input.stylePolicy.lifecycle.maxConfirmationAttempts,
        liquiditySweep: input.liquiditySweepRole,
        displacement: input.displacementRole,
        reversalPattern: input.reversalPatternRole,
        entryMode: input.afterChochEntryMode,
      }),
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
      return {
        ...(context as FrozenSetupStrategyContext),
        nestedPoiEntry: normalizeNestedPoiEntryPlan(context.nestedPoiEntry),
      };
    }
  }
  return null;
}

/** Reads persisted setup data only; runtime settings never rewrite the plan. */
export function resolvePendingNestedPoiEntryPlan(
  pending: Record<string, unknown>,
): FrozenNestedPoiEntryPlan | null {
  const frozen = readFrozenSetupStrategyContext(pending);
  if (frozen) return frozen.nestedPoiEntry || null;

  const signalReason = parseSignalReason(pending.signal_reason);
  const confirmationConfig = asRecord(pending.confirmation_config);
  const candidates = [
    pending.nested_poi_entry,
    signalReason.nestedPoiEntry,
    confirmationConfig.nestedPoiEntry,
  ];
  for (const candidate of candidates) {
    const plan = normalizeNestedPoiEntryPlan(candidate);
    if (plan) return plan;
  }
  return null;
}

export type PendingNestedPoiEntryPlanState =
  | {
    declared: false;
    valid: true;
    plan: FrozenNestedPoiEntryPlan | null;
    reason: "nested_poi_not_declared";
  }
  | {
    declared: true;
    valid: true;
    plan: FrozenNestedPoiEntryPlan;
    reason: "nested_poi_frozen_plan_available";
  }
  | {
    declared: true;
    valid: false;
    plan: null;
    reason: "nested_poi_frozen_plan_unavailable";
  };

/**
 * A persisted nested route must retain its exact frozen plan. A missing or
 * malformed plan fails closed instead of falling through to legacy CHoCH.
 */
export function resolvePendingNestedPoiEntryPlanState(
  pending: Record<string, unknown>,
): PendingNestedPoiEntryPlanState {
  const confirmationConfig = asRecord(pending.confirmation_config);
  const signalReason = parseSignalReason(pending.signal_reason);
  const frozen = readFrozenSetupStrategyContext(pending);
  const fallbackFrozenContexts = [
    pending.frozen_strategy_context,
    signalReason.frozenStrategyContext,
    signalReason.watchlistLifecycle?.frozenStrategyContext,
    asRecord(pending.authorization_result).frozenStrategyContext,
    asRecord(
      asRecord(pending.final_authorization).decisionContext,
    ).frozenStrategyContext,
  ];
  const crossTimeframeContexts = frozen ? [frozen.crossTimeframeContext] : [
    pending.cross_timeframe_context,
    pending.crossTimeframeContext,
    ...fallbackFrozenContexts.map((context) =>
      asRecord(context).crossTimeframeContext
    ),
  ];
  const declaredByEntryMode =
    confirmationConfig.entryMode === "nested_poi_market" ||
    crossTimeframeContexts.some((context) =>
      asRecord(asRecord(context).impulseEntryLifecycle).entryMode ===
        "nested_poi_market"
    );
  const plan = resolvePendingNestedPoiEntryPlan(pending);
  const planDeclaresNestedRoute = plan?.route === "nested_poi_market";
  const declared = declaredByEntryMode || planDeclaresNestedRoute;
  const lifecycleMatchesPlan = !!(planDeclaresNestedRoute && plan?.selected) &&
    crossTimeframeContexts.some((contextValue) => {
      const context = asRecord(contextValue);
      const lifecycle = asRecord(context.impulseEntryLifecycle);
      const impulse = asRecord(lifecycle.impulse);
      const confirmation = asRecord(lifecycle.confirmation);
      const lifecycleMonitoringTimeframe = normalizeAnalysisTimeframeOrNull(
        confirmation.timeframe,
      );
      if (
        lifecycle.mode !== "enforce" ||
        lifecycle.entryMode !== "nested_poi_market" ||
        impulse.direction !== plan!.direction ||
        lifecycleMonitoringTimeframe !== plan!.monitoringTimeframe
      ) return false;
      try {
        return validateImpulseLifecycleExecutableZone({
          mode: "enforce",
          context: context as FrozenCrossTimeframeContext,
          executableZone: {
            candidateId: plan!.selected!.id,
            type: plan!.selected!.type,
            low: plan!.selected!.low,
            high: plan!.selected!.high,
            triggerKind: plan!.selected!.geometry,
          },
        }).valid;
      } catch {
        return false;
      }
    });
  if (
    declared && planDeclaresNestedRoute && plan?.selected &&
    lifecycleMatchesPlan
  ) {
    return {
      declared: true,
      valid: true,
      plan,
      reason: "nested_poi_frozen_plan_available",
    };
  }
  return declared
    ? {
      declared: true,
      valid: false,
      plan: null,
      reason: "nested_poi_frozen_plan_unavailable",
    }
    : {
      declared: false,
      valid: true,
      plan,
      reason: "nested_poi_not_declared",
    };
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

// ── Lifecycle candidate identity ─────────────────────────────────────
//
// Step 3 of docs/PENDING_ORDER_PREARMING_PLAN.md.
//
// A setup's lifecycle ID identifies ONE TRADING OPPORTUNITY'S JOURNEY across
// staged_setups → pending_orders → paper_positions. It is deliberately a
// persisted UUID rather than a content hash: a derived key drifts as the candle
// window rolls, a persisted one cannot. Stability comes from REUSING the row.
//
// Do not confuse it with the zone evidence ID from zoneCandidateIdentity.ts,
// which deterministically identifies a market object (this FVG/OB). Both are
// called candidateId. See docs/CONCEPT_INVENTORY.md.
//
// Measured 2026-08-12: only 30 of 1,325 pending_orders rows carried a
// candidate_id. bot-scanner fell back to crypto.randomUUID() whenever an order
// was not promoted from staging, and the breaker path randomised
// unconditionally — even when a watchlist row for that symbol/direction
// existed. A fresh UUID is not a bug in itself; it is the birth of a lifecycle.
// Minting a fresh one when a durable source EXISTS is the bug, because it forks
// the identity and the two halves can never be reconciled.

export type LifecycleIdentitySource =
  | "promoted_evidence"
  | "staged_candidate"
  | "staged_row"
  | "generated";

export interface LifecycleIdentityInput {
  /** candidateId carried by promoted lifecycle evidence, when the order came from staging. */
  inheritedCandidateId?: string | null;
  /** candidate_id column on the staged_setups row for this symbol/direction. */
  stagedCandidateId?: string | null;
  /** staged_setups.id — durable even when candidate_id was never populated. */
  stagedRowId?: string | null;
}

export interface LifecycleIdentity {
  candidateId: string;
  source: LifecycleIdentitySource;
  /** True when a durable source existed, i.e. nothing was minted. */
  inherited: boolean;
}

function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the lifecycle candidate ID for a pending order.
 *
 * Preference order, most durable first. `generate` is injected rather than
 * calling crypto.randomUUID() directly so tests can assert that it is NOT
 * called when a durable source exists — the actual regression being guarded.
 */
export function resolveLifecycleCandidateId(
  input: LifecycleIdentityInput,
  generate: () => string,
): LifecycleIdentity {
  if (usable(input.inheritedCandidateId)) {
    return {
      candidateId: input.inheritedCandidateId,
      source: "promoted_evidence",
      inherited: true,
    };
  }
  if (usable(input.stagedCandidateId)) {
    return {
      candidateId: input.stagedCandidateId,
      source: "staged_candidate",
      inherited: true,
    };
  }
  // The watchlist row's own id is durable even when candidate_id predates the
  // column being populated. Better than minting: it still points at one row.
  if (usable(input.stagedRowId)) {
    return {
      candidateId: input.stagedRowId,
      source: "staged_row",
      inherited: true,
    };
  }
  return { candidateId: generate(), source: "generated", inherited: false };
}
