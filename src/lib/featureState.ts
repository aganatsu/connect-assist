import type { StagedSetup } from "@/lib/api";

export type FeatureState =
  | "active"
  | "shadow"
  | "log-only"
  | "monitoring"
  | "inactive"
  | "disabled"
  | "unavailable";

export const FEATURE_STATE_LABELS: Record<FeatureState, string> = {
  active: "ACTIVE",
  shadow: "SHADOW",
  "log-only": "LOG ONLY",
  monitoring: "MONITORING",
  inactive: "INACTIVE",
  disabled: "DISABLED",
  unavailable: "UNAVAILABLE",
};

export interface FeatureDisplayState {
  state: FeatureState;
  description: string;
}

/**
 * The live scanner currently records Thesis Conviction evidence and the
 * adjustment it would make, but does not apply that adjustment to live entry
 * scoring. Keep the UI truthful even when an older saved config requests
 * "active" mode.
 */
export function getLiveThesisConvictionDisplay(
  enabled: boolean,
  requestedMode: "shadow" | "active" = "shadow",
): FeatureDisplayState {
  if (!enabled) {
    return {
      state: "inactive",
      description: "Thesis Conviction is disabled and does not collect new evidence.",
    };
  }

  if (requestedMode === "active") {
    return {
      state: "shadow",
      description:
        "The saved mode requests active, but the live scanner currently records evidence only and does not change entry scoring.",
    };
  }

  return {
    state: "shadow",
    description:
      "Records thesis conviction and the adjustment it would propose without changing live entry scoring.",
  };
}

export function getWatchlistDisplay(executionEligible: boolean | null | undefined) {
  if (executionEligible === false) {
    return {
      state: "monitoring" as const,
      label: "WATCHING · NO VALID ZONE",
      description:
        "Directional evidence is present, but no valid unified zone exists. This candidate is monitored and cannot execute.",
    };
  }

  return {
    state: "active" as const,
    label: null,
    description: null,
  };
}

const STAGED_LIFECYCLE_PHASE_LABELS: Record<string, string> = {
  monitoring_pre_zone: "MONITORING",
  zone_discovered: "ZONE DISCOVERED",
  approaching_zone: "APPROACHING",
  at_zone: "AT ZONE",
  local_trigger_active: "LOCAL TRIGGER ACTIVE",
  local_trigger_swept: "LOCAL TRIGGER SWEPT",
  sweep_rejected: "SWEEP REJECTED",
  confirmation_ready: "CONFIRMATION READY",
  entry_authorized: "ENTRY AUTHORIZED",
  position_managing: "POSITION MANAGING",
};

export function getStagedLifecyclePhaseLabel(
  phase: string | null | undefined,
): string {
  if (!phase) return "PHASE UNAVAILABLE";
  return STAGED_LIFECYCLE_PHASE_LABELS[phase] ||
    phase.replace(/_/g, " ").toUpperCase();
}

export function getStagedLifecycleStatusText(
  setup: Pick<
    StagedSetup,
    "lifecycle_phase" | "lifecycle_evidence" | "lifecycle_reason"
  >,
): string {
  const phase = setup.lifecycle_phase || setup.lifecycle_evidence?.phase;
  const labels: Record<string, string> = {
    monitoring_pre_zone: "Searching for a complete executable zone.",
    zone_discovered: "Frozen zone is valid; price is still outside the approach area.",
    approaching_zone: "Price is approaching the frozen zone; deeper monitoring is active.",
    at_zone: "Price is inside the frozen zone; waiting for liquidity and confirmation.",
    local_trigger_active: "A local BSL/SSL trigger is active inside the frozen setup.",
    local_trigger_swept: "Liquidity has been swept; waiting for rejection and confirmation.",
    sweep_rejected: "The liquidity sweep rejected; confirmation is developing.",
    confirmation_ready: "Entry confirmation is ready for final authorization.",
    entry_authorized: "Entry was authorized and handed to order execution.",
    position_managing: "The resulting position is under trade management.",
  };
  return labels[phase || ""] || setup.lifecycle_reason ||
    "Lifecycle status is awaiting its next monitor update.";
}
