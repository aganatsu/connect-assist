/**
 * Tests for the Cascade Zone Gate logic.
 * Verifies that the cascade gate correctly blocks/allows trades based on cascade state
 * and that the "prefer" vs "only" modes behave as expected.
 */
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// We test the gate logic in isolation by simulating the decision tree
// that exists in bot-scanner/index.ts (lines 4467-4515).

type CascadeState =
  | "no_daily_impulse"
  | "no_daily_zone"
  | "waiting_for_price"
  | "at_daily_zone"
  | "no_confirmation"
  | "confirmed"
  | "no_entry_zone"
  | "ready"
  | "triggered";

interface CascadeResult {
  state: CascadeState;
  reason: string;
  dailyZoneDistance?: number;
  entry?: number;
  sl?: number;
}

interface GateDecision {
  passed: boolean;
  status?: string;
  skipReason?: string;
  action: "proceed" | "skip" | "fallthrough";
}

/**
 * Simulates the cascade gate decision logic from bot-scanner.
 * This mirrors the exact if/else structure in the scanner.
 */
function runCascadeGate(
  cascadeResult: CascadeResult | null,
  cascadeZoneMode: "prefer" | "only" | "off",
): GateDecision {
  if (!cascadeResult || cascadeZoneMode === "off") {
    return { passed: false, action: "fallthrough" };
  }

  const cascadeState = cascadeResult.state;
  const isTradeReady = cascadeState === "triggered" || cascadeState === "ready";

  if (cascadeZoneMode === "only") {
    if (!isTradeReady) {
      if (cascadeState === "waiting_for_price") {
        return {
          passed: false,
          status: "watching_zone",
          skipReason: `Cascade Gate (only): Daily zone found but price is ${cascadeResult.dailyZoneDistance?.toFixed(1) ?? "?"} pips away.`,
          action: "skip",
        };
      } else if (cascadeState === "at_daily_zone" || cascadeState === "no_confirmation") {
        return {
          passed: false,
          status: "watching_zone",
          skipReason: `Cascade Gate (only): Price at Daily zone but no 4H displacement or 1H CHoCH yet.`,
          action: "skip",
        };
      } else if (cascadeState === "confirmed" || cascadeState === "no_entry_zone") {
        return {
          passed: false,
          status: "watching_zone",
          skipReason: `Cascade Gate (only): 4H/1H confirmed but no entry zone found yet.`,
          action: "skip",
        };
      } else {
        // no_daily_impulse, no_daily_zone
        return {
          passed: false,
          status: "skipped_no_impulse_zone",
          skipReason: `Cascade Gate (only): ${cascadeResult.reason}. No Daily story.`,
          action: "skip",
        };
      }
    }
    return { passed: true, action: "proceed" };
  } else {
    // "prefer" mode
    if (isTradeReady) {
      return { passed: true, action: "proceed" };
    }
    return { passed: false, action: "fallthrough" };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MODE: "only" — strict cascade gate
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Cascade Gate (only): triggered state → PASSES", () => {
  const result = runCascadeGate(
    { state: "triggered", reason: "Price at 1H entry zone within Daily zone", entry: 1.1234, sl: 1.1180 },
    "only",
  );
  assertEquals(result.passed, true);
  assertEquals(result.action, "proceed");
});

Deno.test("Cascade Gate (only): ready state → PASSES", () => {
  const result = runCascadeGate(
    { state: "ready", reason: "Entry zone found, price approaching", entry: 1.1234, sl: 1.1180 },
    "only",
  );
  assertEquals(result.passed, true);
  assertEquals(result.action, "proceed");
});

Deno.test("Cascade Gate (only): waiting_for_price → BLOCKS with watching_zone", () => {
  const result = runCascadeGate(
    { state: "waiting_for_price", reason: "Daily zone found but price 181 pips away", dailyZoneDistance: 181.5 },
    "only",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "skip");
  assertEquals(result.status, "watching_zone");
});

Deno.test("Cascade Gate (only): no_confirmation → BLOCKS with watching_zone", () => {
  const result = runCascadeGate(
    { state: "no_confirmation", reason: "Price at Daily zone but no 4H displacement" },
    "only",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "skip");
  assertEquals(result.status, "watching_zone");
});

Deno.test("Cascade Gate (only): at_daily_zone → BLOCKS with watching_zone", () => {
  const result = runCascadeGate(
    { state: "at_daily_zone", reason: "Price at Daily zone" },
    "only",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "skip");
  assertEquals(result.status, "watching_zone");
});

Deno.test("Cascade Gate (only): confirmed but no_entry_zone → BLOCKS with watching_zone", () => {
  const result = runCascadeGate(
    { state: "no_entry_zone", reason: "Confirmed but no 1H entry zone found" },
    "only",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "skip");
  assertEquals(result.status, "watching_zone");
});

Deno.test("Cascade Gate (only): no_daily_impulse → BLOCKS with skipped_no_impulse_zone", () => {
  const result = runCascadeGate(
    { state: "no_daily_impulse", reason: "No valid Daily impulse found" },
    "only",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "skip");
  assertEquals(result.status, "skipped_no_impulse_zone");
});

Deno.test("Cascade Gate (only): no_daily_zone → BLOCKS with skipped_no_impulse_zone", () => {
  const result = runCascadeGate(
    { state: "no_daily_zone", reason: "Daily impulse exists but no POIs at Fib levels" },
    "only",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "skip");
  assertEquals(result.status, "skipped_no_impulse_zone");
});

// ═══════════════════════════════════════════════════════════════════════
// MODE: "prefer" — use cascade if ready, otherwise fall through
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Cascade Gate (prefer): triggered state → PASSES (uses cascade)", () => {
  const result = runCascadeGate(
    { state: "triggered", reason: "Price at entry", entry: 1.1234, sl: 1.1180 },
    "prefer",
  );
  assertEquals(result.passed, true);
  assertEquals(result.action, "proceed");
});

Deno.test("Cascade Gate (prefer): ready state → PASSES (uses cascade)", () => {
  const result = runCascadeGate(
    { state: "ready", reason: "Entry zone found", entry: 1.1234, sl: 1.1180 },
    "prefer",
  );
  assertEquals(result.passed, true);
  assertEquals(result.action, "proceed");
});

Deno.test("Cascade Gate (prefer): waiting_for_price → FALLS THROUGH to impulse zone gate", () => {
  const result = runCascadeGate(
    { state: "waiting_for_price", reason: "Price 181 pips away", dailyZoneDistance: 181.5 },
    "prefer",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "fallthrough");
  assertEquals(result.status, undefined); // No status set — falls through
});

Deno.test("Cascade Gate (prefer): no_daily_impulse → FALLS THROUGH to impulse zone gate", () => {
  const result = runCascadeGate(
    { state: "no_daily_impulse", reason: "No Daily impulse" },
    "prefer",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "fallthrough");
});

Deno.test("Cascade Gate (prefer): no_confirmation → FALLS THROUGH to impulse zone gate", () => {
  const result = runCascadeGate(
    { state: "no_confirmation", reason: "No 4H displacement" },
    "prefer",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "fallthrough");
});

// ═══════════════════════════════════════════════════════════════════════
// MODE: "off" — cascade disabled
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Cascade Gate (off): always falls through regardless of state", () => {
  const result = runCascadeGate(
    { state: "triggered", reason: "Price at entry", entry: 1.1234, sl: 1.1180 },
    "off",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "fallthrough");
});

Deno.test("Cascade Gate: null cascadeResult → falls through", () => {
  const result = runCascadeGate(null, "only");
  assertEquals(result.passed, false);
  assertEquals(result.action, "fallthrough");
});

// ═══════════════════════════════════════════════════════════════════════
// Cascade override behavior
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Cascade Gate: when passed, entry and SL are available for override", () => {
  const cascadeResult: CascadeResult = {
    state: "triggered",
    reason: "Price at 1H entry zone",
    entry: 1.12345,
    sl: 1.11800,
  };
  const decision = runCascadeGate(cascadeResult, "only");
  assertEquals(decision.passed, true);
  // When gate passes, the scanner uses cascadeResult.entry and cascadeResult.sl
  assertNotEquals(cascadeResult.entry, undefined);
  assertNotEquals(cascadeResult.sl, undefined);
  assertEquals(cascadeResult.entry, 1.12345);
  assertEquals(cascadeResult.sl, 1.11800);
});

Deno.test("Cascade Gate (only): confirmed state → BLOCKS (story not complete enough)", () => {
  // "confirmed" means 4H/1H confirmed but no entry zone found yet
  const result = runCascadeGate(
    { state: "confirmed", reason: "4H displacement confirmed inside Daily zone" },
    "only",
  );
  assertEquals(result.passed, false);
  assertEquals(result.action, "skip");
  assertEquals(result.status, "watching_zone");
});
