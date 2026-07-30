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
