export const LIQUIDITY_ACTIVATION_POLICY_VERSION = "liquidity-activation-policy.v1";

export type LiquidityActivationRole = "required" | "supporting" | "not_required";
export type NoQualifiedPoolBehavior = "not_applicable" | "wait_for_pool";

export interface LiquidityActivationPolicy {
  contractVersion: typeof LIQUIDITY_ACTIVATION_POLICY_VERSION;
  role: LiquidityActivationRole;
  triggerScope: "local_or_internal_bsl_ssl";
  requiredState: "swept_rejected";
  noQualifiedPoolBehavior: NoQualifiedPoolBehavior;
  absorbedBehavior: "require_fresh_trigger";
}

export function buildLiquidityActivationPolicy(input: {
  role?: unknown;
  noQualifiedPoolBehavior?: unknown;
}): LiquidityActivationPolicy {
  const role: LiquidityActivationRole = input.role === "required" || input.role === "not_required" ? input.role : "supporting";
  return {
    contractVersion: LIQUIDITY_ACTIVATION_POLICY_VERSION,
    role,
    triggerScope: "local_or_internal_bsl_ssl",
    requiredState: "swept_rejected",
    noQualifiedPoolBehavior: input.noQualifiedPoolBehavior === "wait_for_pool" ? "wait_for_pool" : "not_applicable",
    absorbedBehavior: "require_fresh_trigger",
  };
}

export function evaluateLiquidityActivation(input: {
  policy: LiquidityActivationPolicy;
  entryTriggerState: "none" | "unswept" | "swept_rejected" | "swept_absorbed" | "unavailable";
}) {
  if (input.policy.role === "not_required") return { ready: true, reasonCode: "liquidity_not_required" } as const;
  if (input.entryTriggerState === "none") return input.policy.role === "required" && input.policy.noQualifiedPoolBehavior === "wait_for_pool"
    ? { ready: false, reasonCode: "qualified_local_pool_pending" } as const
    : { ready: true, reasonCode: "no_qualified_local_pool_not_applicable" } as const;
  if (input.entryTriggerState === "swept_absorbed") return { ready: false, reasonCode: "liquidity_absorbed_fresh_trigger_required" } as const;
  if (input.policy.role === "supporting") return { ready: true, reasonCode: input.entryTriggerState === "swept_rejected" ? "supporting_sweep_present" : "supporting_sweep_absent" } as const;
  return input.entryTriggerState === "swept_rejected"
    ? { ready: true, reasonCode: "required_sweep_rejected" } as const
    : { ready: false, reasonCode: "required_sweep_pending" } as const;
}
