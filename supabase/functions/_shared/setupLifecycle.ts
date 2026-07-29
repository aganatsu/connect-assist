import {
  TRADE_DECISION_CONTRACT_VERSION,
  type DirectionVerdictDecision,
} from "./decisionContract.ts";
import type { SessionGamePlan } from "./gamePlan.ts";

export const SETUP_LIFECYCLE_VERSION = "phase4.v1";
export const THESIS_VALIDATION_VERSION = "thesis.v1";

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
}

const ALLOWED_TRANSITIONS: Record<SetupLifecycleStatus, SetupLifecycleStatus[]> =
  {
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

function normalizeConfirmationMethod(value: unknown): ConfirmationMethod | null {
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
}): SetupLifecycleEvidence {
  const pairPlan = input.gamePlan?.plans?.find((plan) =>
    plan.symbol === input.symbol
  );
  return {
    lifecycleVersion: SETUP_LIFECYCLE_VERSION,
    candidateId: input.identity.candidateId,
    setupId: input.identity.setupId,
    gamePlanId: pairPlan?.gamePlanId ||
      input.directionVerdict?.gamePlanId ||
      null,
    gamePlanVersion: pairPlan?.planVersion ||
      input.directionVerdict?.gamePlanVersion ||
      input.gamePlan?.planVersion ||
      null,
    directionVerdictId: input.directionVerdict?.id || null,
    directionVerdictVersion:
      input.directionVerdict?.verdictVersion || null,
    thesisVersion: THESIS_VALIDATION_VERSION,
    decisionContractVersion: TRADE_DECISION_CONTRACT_VERSION,
    confirmationMethod:
      normalizeConfirmationMethod(input.confirmationMethod) || "choch",
    originatingZone: input.originatingZone || null,
  };
}

export async function transitionStagedSetup(
  client: any,
  input: {
    setupId: string;
    userId: string;
    status: SetupLifecycleStatus;
    reason: string;
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
    p_evidence: input.evidence || {},
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
