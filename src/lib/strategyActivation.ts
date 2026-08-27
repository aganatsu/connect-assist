export type StrategyAuthorityStage =
  | "shadow"
  | "log_only"
  | "soft_adjustment"
  | "hard_block";

export type StrategyRuntimeScope =
  | "observation"
  | "paper"
  | "live_canary"
  | "live";

export interface StrategyActivationRecord {
  feature_key: string;
  variant_key: string;
  authority_stage: StrategyAuthorityStage;
  runtime_scope: StrategyRuntimeScope;
  runtime_enforced: boolean;
  revision: number;
  transition_reason: string | null;
  evidence_hash: string;
  updated_at: string;
}

export interface StrategyActivationDisplay {
  authorityLabel: string;
  scopeLabel: string;
  runtimeLabel: string;
  description: string;
}

const AUTHORITY_LABELS: Record<StrategyAuthorityStage, string> = {
  shadow: "SHADOW",
  log_only: "LOG ONLY",
  soft_adjustment: "SOFT ADJUSTMENT",
  hard_block: "HARD BLOCK",
};

const SCOPE_LABELS: Record<StrategyRuntimeScope, string> = {
  observation: "OBSERVATION",
  paper: "PAPER",
  live_canary: "LIVE CANARY",
  live: "LIVE",
};

export function getStrategyActivationDisplay(
  record?: StrategyActivationRecord | null,
): StrategyActivationDisplay {
  if (!record) {
    return {
      authorityLabel: AUTHORITY_LABELS.shadow,
      scopeLabel: SCOPE_LABELS.observation,
      runtimeLabel: "NOT ENFORCED",
      description:
        "No activation record exists, so the safe default is Shadow / Observation with no trade impact.",
    };
  }

  return {
    authorityLabel: AUTHORITY_LABELS[record.authority_stage],
    scopeLabel: SCOPE_LABELS[record.runtime_scope],
    runtimeLabel: record.runtime_enforced ? "ENFORCED" : "NOT ENFORCED",
    description: record.runtime_enforced
      ? record.transition_reason ||
        "This registered policy is enforced by the runtime."
      : "The rollout state is recorded, but runtime enforcement is currently disabled.",
  };
}
