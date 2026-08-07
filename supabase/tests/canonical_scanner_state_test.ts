import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { projectCanonicalScannerState } from "../functions/_shared/canonicalScannerState.ts";

const base = () => ({
  evaluatedAt: "2026-08-07T12:00:00.000Z",
  identity: { candidateId: "c1", symbol: "EUR/USD", direction: "long" as const },
  direction: { available: true, allowed: true, evidenceId: "dv1" },
  zone: { available: true, valid: true, atPoi: true, evidenceId: "z1" },
  location: { required: true, available: true, allowed: true, evidenceId: "r1" },
  liquidity: { policy: "required" as const, state: "swept_rejected" as const },
  confirmation: { required: true, passed: true },
  thesis: { required: true, valid: true },
  safety: { complete: true, passed: true },
  execution: { authorized: true },
});

Deno.test("canonical scanner state projects the ordered authority stages", () => {
  assertEquals(projectCanonicalScannerState(base()).stage, "authorized");
  assertEquals(projectCanonicalScannerState({ ...base(), zone: { ...base().zone, available: false } }).stage, "discovery");
  assertEquals(projectCanonicalScannerState({ ...base(), zone: { ...base().zone, atPoi: false } }).stage, "watching");
  assertEquals(projectCanonicalScannerState({ ...base(), liquidity: { policy: "required", state: "unswept" } }).stage, "awaiting_liquidity");
  assertEquals(projectCanonicalScannerState({ ...base(), confirmation: { required: true, passed: false } }).stage, "awaiting_confirmation");
  assertEquals(projectCanonicalScannerState({ ...base(), confirmation: { required: true, passed: true, awaitingRetracement: true } }).stage, "awaiting_retracement");
});

Deno.test("canonical scanner state is observation only and preserves authority trace", () => {
  const result = projectCanonicalScannerState(base());
  assertEquals(result.observationOnly, true);
  assertEquals(result.affectsAuthorization, false);
  assertEquals(result.authorities.map((item) => item.role), ["direction", "impulse_zone", "location", "liquidity", "confirmation", "thesis", "safety", "execution"]);
});

Deno.test("terminal lifecycle state takes precedence", () => {
  assertEquals(projectCanonicalScannerState({ ...base(), lifecycle: { status: "invalidated" } }).stage, "invalidated");
  assertEquals(projectCanonicalScannerState({ ...base(), lifecycle: { positionOpen: true } }).stage, "managing");
  assertEquals(projectCanonicalScannerState({ ...base(), lifecycle: { positionClosed: true } }).stage, "closed");
});
