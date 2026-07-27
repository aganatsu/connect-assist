/**
 * gateTier1Minimum.ts — Shared Tier 1 Minimum gate
 *
 * Ensures a trade has at least the minimum required "core" (Tier 1) confluence
 * factors before being allowed through. Can be disabled via config.
 *
 * Used by:
 *   - bot-scanner (Gate 19): passes tier1GatePassed/tier1GateReason from analysis.tieredScoring
 *   - backtest-engine (Gate 16): same source, with ?? true fallback for missing data
 *
 * Divergence (intentional, documented):
 *   - bot-scanner treats undefined tier1GatePassed as FAIL (falsy)
 *   - backtest-engine treats undefined tier1GatePassed as PASS (?? true)
 *   The shared function accepts a boolean (caller resolves undefined upstream),
 *   preserving each engine's existing default behavior.
 *
 * Reason string format: "Tier 1 gate: ..." — satisfies:
 *   - gatePerformanceEngine.ts pattern: includes("Tier 1") ✅
 *   - backtest diagnostics: split(":")[0] → "Tier 1 gate" ✅
 */

export interface Tier1MinimumInput {
  /** Whether the tier-1 gate is enabled in config (false = always pass) */
  tier1GateEnabled: boolean;
  /** Pre-computed pass/fail from confluenceScoring's tier1 check */
  tier1GatePassed: boolean;
  /** Reason string from confluenceScoring (may be empty/undefined) */
  tier1GateReason?: string;
  /** Number of tier-1 core factors present (for informational display) */
  tier1Count: number;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

export function checkTier1Minimum(input: Tier1MinimumInput): GateResult {
  const { tier1GateEnabled, tier1GatePassed, tier1GateReason, tier1Count } = input;

  // Gate disabled by config — always pass
  if (tier1GateEnabled === false) {
    return {
      passed: true,
      reason: `Tier 1 gate: DISABLED by config (${tier1Count} core factors present)`,
    };
  }

  // Gate enabled — use pre-computed result
  if (tier1GatePassed) {
    return {
      passed: true,
      reason: tier1GateReason || `Tier 1 gate: passed (${tier1Count} core factors)`,
    };
  }

  return {
    passed: false,
    reason: tier1GateReason || `Tier 1 gate: failed (${tier1Count} core factors, minimum not met)`,
  };
}
