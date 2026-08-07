export const ICT_CONFIRMATION_POLICY_VERSION = "ict-confirmation-policy.v1";

export type RequirementRole = "required" | "supporting" | "not_required";
export type ConfirmationMethod = "choch" | "indicators" | "choch_and_indicators";

export interface ICTConfirmationPolicy {
  contractVersion: typeof ICT_CONFIRMATION_POLICY_VERSION;
  method: ConfirmationMethod;
  liquiditySweep: RequirementRole;
  displacement: RequirementRole;
  structureShift: RequirementRole;
  reversalPattern: RequirementRole;
  indicators: RequirementRole;
  indicatorMinimum: number;
  entryMode: "confirmation_close" | "observe_retracement" | "wait_retracement";
  confirmationTimeframe: string;
  refinementTimeframe: string;
  maxAttempts: number;
}

const role = (value: unknown, fallback: RequirementRole): RequirementRole =>
  value === "required" || value === "supporting" || value === "not_required" ? value : fallback;

export function buildICTConfirmationPolicy(input: {
  method: ConfirmationMethod;
  confirmationTimeframe: string;
  refinementTimeframe: string;
  indicatorMinimum?: number;
  maxAttempts?: number;
  liquiditySweep?: unknown;
  displacement?: unknown;
  reversalPattern?: unknown;
  entryMode?: unknown;
}): ICTConfirmationPolicy {
  const structural = input.method !== "indicators";
  const indicatorBased = input.method !== "choch";
  return {
    contractVersion: ICT_CONFIRMATION_POLICY_VERSION,
    method: input.method,
    liquiditySweep: role(input.liquiditySweep, "supporting"),
    displacement: role(input.displacement, "supporting"),
    structureShift: structural ? "required" : "not_required",
    reversalPattern: role(input.reversalPattern, "supporting"),
    indicators: indicatorBased ? "required" : "not_required",
    indicatorMinimum: Math.max(1, Math.min(4, Math.trunc(Number(input.indicatorMinimum) || 3))),
    entryMode: input.entryMode === "observe_retracement" || input.entryMode === "wait_retracement" ? input.entryMode : "confirmation_close",
    confirmationTimeframe: input.confirmationTimeframe,
    refinementTimeframe: input.refinementTimeframe,
    maxAttempts: Math.max(1, Math.trunc(Number(input.maxAttempts) || 3)),
  };
}
