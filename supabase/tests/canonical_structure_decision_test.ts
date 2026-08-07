import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateCanonicalStructureDecision, evaluateCanonicalStructureEnforcement } from "../functions/_shared/canonicalStructureDecision.ts";
import { projectCanonicalScannerState } from "../functions/_shared/canonicalScannerState.ts";

const structure = (external: string) => ({ contractVersion: "canonical-structure.v1", observationOnly: true, affectsAuthorization: false, internalLookback: 3, externalLookback: 7, levels: [{ id: "x" }], events: [], trend: { internal: "bullish", external } }) as any;
const liquidity = (ready: boolean) => ({ contractVersion: "canonical-liquidity-sequence.v1", observationOnly: true, affectsAuthorization: false, sequences: ready ? [{ id: "s", direction: "bullish", entryReady: true, sweep: { id: "sweep" }, shift: { id: "mss", type: "mss" } }] : [] }) as any;

Deno.test("external opposition blocks before entry sequence", () => {
  assertEquals(evaluateCanonicalStructureDecision({ direction: "long", structure: structure("bearish"), liquidity: liquidity(true), requireLiquiditySweep: true }).decision, "block");
});
Deno.test("matching sweep and MSS allows structure authority", () => {
  assertEquals(evaluateCanonicalStructureDecision({ direction: "long", structure: structure("bullish"), liquidity: liquidity(true), requireLiquiditySweep: true }).decision, "allow");
});
Deno.test("enforcement is fail-closed and requires single ownership", () => {
  const decision = evaluateCanonicalStructureDecision({ direction: "long", structure: structure("bullish"), liquidity: liquidity(false), requireLiquiditySweep: true });
  assertEquals(evaluateCanonicalStructureEnforcement({ requestedMode: "enforce", singleOwnershipEffectiveMode: "observe", decision }).effectiveMode, "observe");
  assertEquals(evaluateCanonicalStructureEnforcement({ requestedMode: "enforce", singleOwnershipEffectiveMode: "enforce", decision }).authorized, false);
});

Deno.test("scanner state preserves enforced structure waiting", () => {
  const state = projectCanonicalScannerState({ evaluatedAt: "x", identity: { candidateId: "c", symbol: "EUR/USD", direction: "long" }, direction: { available: true, allowed: true }, structure: { required: true, decision: "watch", reasonCode: "sweep_and_shift_pending" }, zone: { available: true, valid: true, atPoi: true }, location: { required: false, available: true, allowed: true }, liquidity: { policy: "not_required", state: "none" }, confirmation: { required: false, passed: true }, thesis: { required: false, valid: true }, safety: { complete: true, passed: true }, execution: { authorized: true } });
  assertEquals(state.stage, "awaiting_liquidity");
  assertEquals(state.authorities.some((item) => item.role === "structure"), true);
});
