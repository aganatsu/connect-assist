import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTradeDecisionPresentation } from "../functions/_shared/tradeDecisionPresentation.ts";
import { projectCanonicalScannerState } from "../functions/_shared/canonicalScannerState.ts";

Deno.test("presentation exposes one primary reason and isolates diagnostics", () => {
  const state = projectCanonicalScannerState({ evaluatedAt: "2026-08-07T12:00:00Z", identity: { candidateId: "c", symbol: "EUR/USD", direction: "long" }, direction: { available: true, allowed: true }, zone: { available: true, valid: true, atPoi: true }, location: { required: false, available: true, allowed: true }, liquidity: { policy: "required", state: "unswept" }, confirmation: { required: true, passed: false }, thesis: { required: false, valid: true }, safety: { complete: true, passed: true } });
  const result = buildTradeDecisionPresentation({ state, legacyDiagnostics: [{ code: "minimum_score", passed: false, reason: "old score", owner: "legacy_diagnostic" }, { code: "news", passed: true, owner: "operational_safety" }] });
  assertEquals(result.primary.stage, "awaiting_liquidity");
  assertEquals(result.diagnostics.length, 1);
  assertEquals(result.diagnosticsAffectAuthorization, false);
});
