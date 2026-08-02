import type { EntryTriggerState } from "./zoneLiquidity.ts";

export interface StandaloneSweepLiquidity {
  summary?: string | null;
  gateReason?: string | null;
  entryTriggerState?: EntryTriggerState | null;
  hasUnsweptEntryTrigger?: boolean;
}

export interface StandaloneSweepGateInput {
  requireLiquiditySweep: boolean;
  unifiedGatePassed: boolean;
  liquidity: StandaloneSweepLiquidity | null;
}

export interface StandaloneSweepGateResult {
  blocked: boolean;
  status: "waiting_for_sweep" | "waiting_for_reconfirmation" | null;
  reason: string | null;
}

/**
 * Applies the same qualified local/internal sweep authority to standalone
 * entries that the unified zone path applies. Context-only pools never gate.
 */
export function evaluateStandaloneSweepGate(
  input: StandaloneSweepGateInput,
): StandaloneSweepGateResult {
  if (
    !input.requireLiquiditySweep ||
    input.unifiedGatePassed ||
    !input.liquidity
  ) {
    return { blocked: false, status: null, reason: null };
  }

  const liquidity = input.liquidity;
  if (
    liquidity.entryTriggerState === "unswept" &&
    liquidity.hasUnsweptEntryTrigger === true
  ) {
    return {
      blocked: true,
      status: "waiting_for_sweep",
      reason:
        `Standalone Sweep Gate: ${liquidity.gateReason || liquidity.summary || "qualified local/internal trigger is unswept"}`,
    };
  }

  if (liquidity.entryTriggerState === "swept_absorbed") {
    return {
      blocked: true,
      status: "waiting_for_reconfirmation",
      reason:
        `Standalone Sweep Gate: ${liquidity.gateReason || liquidity.summary || "sweep was not rejected"} — entry remains blocked`,
    };
  }

  return { blocked: false, status: null, reason: null };
}
