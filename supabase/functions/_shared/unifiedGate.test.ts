import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isUnifiedConfirmed, requireUnifiedSkips } from "./unifiedGate.ts";

Deno.test("isUnifiedConfirmed: needs a zone, triggered/confirmed, and entryReady", () => {
  assertEquals(isUnifiedConfirmed({ hasZone: true, state: "confirmed", confirmation: { entryReady: true } }), true);
  assertEquals(isUnifiedConfirmed({ hasZone: true, state: "triggered", confirmation: { entryReady: true } }), true);
  assertEquals(isUnifiedConfirmed({ hasZone: true, state: "at_zone", confirmation: { entryReady: false } }), false);
  assertEquals(isUnifiedConfirmed({ hasZone: true, state: "confirmed", confirmation: { entryReady: false } }), false);
  assertEquals(isUnifiedConfirmed({ hasZone: false, state: "confirmed", confirmation: { entryReady: true } }), false);
  assertEquals(isUnifiedConfirmed(null), false);
});

Deno.test("requireUnifiedSkips: the 10-28 bug — confirmed Unified with modifiers OFF must NOT be skipped", () => {
  // modifiers OFF: the gate is not "passed", but Unified did confirm
  assertEquals(requireUnifiedSkips({ requireUnifiedZone: true, unifiedGatePassed: false, unifiedConfirmed: true }), false);
});

Deno.test("requireUnifiedSkips: skips only when required and Unified did not confirm", () => {
  assertEquals(requireUnifiedSkips({ requireUnifiedZone: true, unifiedGatePassed: false, unifiedConfirmed: false }), true);
  assertEquals(requireUnifiedSkips({ requireUnifiedZone: true, unifiedGatePassed: true, unifiedConfirmed: true }), false);
  assertEquals(requireUnifiedSkips({ requireUnifiedZone: false, unifiedGatePassed: false, unifiedConfirmed: false }), false);
});
