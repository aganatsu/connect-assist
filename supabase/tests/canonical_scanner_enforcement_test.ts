import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateCanonicalScannerEnforcement, compareCanonicalScannerDecisions, canonicalScannerDisposition } from "../functions/_shared/canonicalScannerEnforcement.ts";
import { projectCanonicalScannerState } from "../functions/_shared/canonicalScannerState.ts";

const state = projectCanonicalScannerState({ evaluatedAt: "2026-08-07T12:00:00Z", identity: { candidateId: "c", symbol: "EUR/USD", direction: "long" }, direction: { available: true, allowed: true }, zone: { available: true, valid: true, atPoi: true }, location: { required: false, available: true, allowed: true }, liquidity: { policy: "not_required", state: "none" }, confirmation: { required: true, passed: true }, thesis: { required: false, valid: true }, safety: { complete: true, passed: true }, execution: { authorized: true } });

Deno.test("canonical enforcement requires explicit single ownership", () => {
  assertEquals(evaluateCanonicalScannerEnforcement({ requestedMode: "enforce", singleOwnershipEffectiveMode: "observe", state }).effectiveMode, "observe");
  assertEquals(evaluateCanonicalScannerEnforcement({ requestedMode: "enforce", singleOwnershipEffectiveMode: "enforce", state }).authorized, true);
});

Deno.test("comparison reports winner and poor-entry effects", () => {
  const report = compareCanonicalScannerDecisions([{ legacyAllowed: true, canonicalStage: "authorized", outcome: "won" }, { legacyAllowed: true, canonicalStage: "blocked", outcome: "lost" }]);
  assertEquals(report.winnersPreserved, 1);
  assertEquals(report.poorEntriesRejected, 1);
});

Deno.test("canonical lifecycle distinguishes waiting from terminal rejection", () => {
  assertEquals(canonicalScannerDisposition("awaiting_liquidity"), "wait");
  assertEquals(canonicalScannerDisposition("awaiting_confirmation"), "wait");
  assertEquals(canonicalScannerDisposition("blocked"), "terminal");
  assertEquals(canonicalScannerDisposition("invalidated"), "terminal");
  assertEquals(canonicalScannerDisposition("authorized"), "allow");
  const waiting = projectCanonicalScannerState({ ...state, liquidity: { policy: "required", state: "unswept" } });
  const enforced = evaluateCanonicalScannerEnforcement({ requestedMode: "enforce", singleOwnershipEffectiveMode: "enforce", state: waiting });
  assertEquals(enforced.authorized, false);
  assertEquals(enforced.disposition, "wait");
});
