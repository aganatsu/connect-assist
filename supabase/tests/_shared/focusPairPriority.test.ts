/**
 * Focus Pair Priority — Phase 6 Tests
 *
 * Tests the scan order reordering logic that puts game plan focus pairs first.
 * This is a pure unit test of the reordering algorithm (extracted from bot-scanner).
 *
 * Verifies:
 * 1. Focus pairs are moved to the front of the scan order
 * 2. Non-focus pairs maintain their relative order
 * 3. No game plan → original order preserved
 * 4. Empty focus pairs → original order preserved
 * 5. Focus pairs not in instruments list → ignored gracefully
 * 6. All pairs are focus pairs → order unchanged (all are focus)
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Extract the reordering logic as a pure function for testing
function reorderByFocusPairs(instruments: string[], focusPairs: string[] | null | undefined): string[] {
  const scanOrder = [...instruments];
  if (!focusPairs || focusPairs.length === 0) return scanOrder;

  const focusSet = new Set(focusPairs);
  const focus = scanOrder.filter(p => focusSet.has(p));
  const nonFocus = scanOrder.filter(p => !focusSet.has(p));
  return [...focus, ...nonFocus];
}

Deno.test("Focus Pair Priority: focus pairs moved to front", () => {
  const instruments = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "NZD/USD"];
  const focusPairs = ["USD/JPY", "AUD/USD"];

  const result = reorderByFocusPairs(instruments, focusPairs);

  // Focus pairs should be first
  assertEquals(result[0], "USD/JPY");
  assertEquals(result[1], "AUD/USD");
  // Non-focus pairs maintain relative order
  assertEquals(result[2], "EUR/USD");
  assertEquals(result[3], "GBP/USD");
  assertEquals(result[4], "NZD/USD");
  // Total count unchanged
  assertEquals(result.length, 5);
});

Deno.test("Focus Pair Priority: non-focus pairs maintain relative order", () => {
  const instruments = ["A", "B", "C", "D", "E", "F"];
  const focusPairs = ["D", "B"];

  const result = reorderByFocusPairs(instruments, focusPairs);

  // Focus pairs first (in their original relative order)
  assertEquals(result[0], "B");
  assertEquals(result[1], "D");
  // Non-focus pairs in original relative order
  assertEquals(result[2], "A");
  assertEquals(result[3], "C");
  assertEquals(result[4], "E");
  assertEquals(result[5], "F");
});

Deno.test("Focus Pair Priority: no game plan → original order", () => {
  const instruments = ["EUR/USD", "GBP/USD", "USD/JPY"];

  const result1 = reorderByFocusPairs(instruments, null);
  assertEquals(result1, ["EUR/USD", "GBP/USD", "USD/JPY"]);

  const result2 = reorderByFocusPairs(instruments, undefined);
  assertEquals(result2, ["EUR/USD", "GBP/USD", "USD/JPY"]);
});

Deno.test("Focus Pair Priority: empty focus pairs → original order", () => {
  const instruments = ["EUR/USD", "GBP/USD", "USD/JPY"];

  const result = reorderByFocusPairs(instruments, []);
  assertEquals(result, ["EUR/USD", "GBP/USD", "USD/JPY"]);
});

Deno.test("Focus Pair Priority: focus pairs not in instruments → ignored", () => {
  const instruments = ["EUR/USD", "GBP/USD"];
  const focusPairs = ["USD/JPY", "AUD/USD"]; // Neither in instruments

  const result = reorderByFocusPairs(instruments, focusPairs);
  assertEquals(result, ["EUR/USD", "GBP/USD"]); // Unchanged
});

Deno.test("Focus Pair Priority: all pairs are focus → same order", () => {
  const instruments = ["EUR/USD", "GBP/USD", "USD/JPY"];
  const focusPairs = ["EUR/USD", "GBP/USD", "USD/JPY"];

  const result = reorderByFocusPairs(instruments, focusPairs);
  assertEquals(result, ["EUR/USD", "GBP/USD", "USD/JPY"]);
});

Deno.test("Focus Pair Priority: does not duplicate or lose pairs", () => {
  const instruments = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "NZD/USD", "USD/CAD"];
  const focusPairs = ["NZD/USD", "EUR/USD"];

  const result = reorderByFocusPairs(instruments, focusPairs);

  // Same length
  assertEquals(result.length, instruments.length);
  // Same elements (sorted for comparison)
  assertEquals([...result].sort(), [...instruments].sort());
});
