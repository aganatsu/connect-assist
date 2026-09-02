/**
 * simulateOutcome.test.ts — Regression tests for the outcome-tracker simulation logic.
 *
 * Tests the 4 fixes:
 *   1. SL hit → loop breaks immediately (no phantom TP after SL)
 *   2. Both TP and SL in same candle → "inconclusive" (not "would_have_won")
 *   3. Neither TP nor SL hit → "inconclusive" (no MFE>MAE guessing)
 *   4. TP hit first → "would_have_won" with MFE capped at TP distance
 *
 * Run: deno test --allow-all supabase/functions/outcome-tracker/simulateOutcome.test.ts
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { simulateOutcome } from "./index.ts";

// ── Helper: generate candle data ──
function makeCandle(datetime: string, open: number, high: number, low: number, close: number) {
  return { datetime, open, high, low, close };
}

// ─── Test 1: SL hit first, TP hit later — should be "would_have_lost" ───
// This is the EXACT bug scenario: price hits SL on candle 2, then hits TP on candle 5.
// Old code: would_have_won (because both hit, and tp_hit_time_minutes was always set)
// New code: would_have_lost (loop breaks at SL)
Deno.test("BUG FIX: SL hit before TP → would_have_lost (not would_have_won)", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.0998), // Entry reached (long at 1.1000)
    makeCandle("2024-01-01T02:00:00Z", 1.0998, 1.1002, 1.0940, 1.0945), // SL hit (SL=1.0950)
    makeCandle("2024-01-01T03:00:00Z", 1.0945, 1.0960, 1.0930, 1.0955), // After SL — irrelevant
    makeCandle("2024-01-01T04:00:00Z", 1.0955, 1.1000, 1.0950, 1.0990), // After SL — irrelevant
    makeCandle("2024-01-01T05:00:00Z", 1.0990, 1.1100, 1.0985, 1.1080), // TP would be hit here — but trade is DEAD
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,  // entry
    1.0950,  // SL (50 pips below)
    1.1100,  // TP (100 pips above)
    "2024-01-01T00:30:00Z", // rejected at
  );

  assertEquals(result.outcome_status, "would_have_lost");
  assertEquals(result.sl_hit, true);
  assertEquals(result.tp_hit, false); // TP should NOT be marked as hit
  assertEquals(result.price_reached_entry, true);
  // MAE should be capped at SL distance (50 pips worth = 0.0050)
  assertAlmostEquals(result.mae_pips, 0.0050, 1e-10);
});

// ─── Test 2: Both TP and SL hit in same candle → "inconclusive" ───
// Old code: would_have_won (because tp_hit_time_minutes was always non-null when tp_hit=true)
// New code: inconclusive (can't determine intra-bar order)
Deno.test("BUG FIX: TP and SL both hit in same candle → inconclusive", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.1000), // Entry reached
    makeCandle("2024-01-01T02:00:00Z", 1.1000, 1.1110, 1.0940, 1.1050), // BOTH TP (1.1100) and SL (1.0950) hit
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,  // entry
    1.0950,  // SL
    1.1100,  // TP
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "inconclusive");
  assertEquals(result.tp_hit, true);
  assertEquals(result.sl_hit, true);
  assertEquals(result.tp_hit_time_minutes, result.sl_hit_time_minutes); // Same candle
});

// ─── Test 3: Neither TP nor SL hit within window → "inconclusive" (no MFE>MAE guess) ───
// Old code: would_have_won if MFE > MAE
// New code: inconclusive always
Deno.test("BUG FIX: Neither TP nor SL hit → inconclusive (no MFE>MAE guessing)", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.1000), // Entry reached
    makeCandle("2024-01-01T02:00:00Z", 1.1000, 1.1040, 1.0960, 1.1020), // MFE=+40, MAE=-40 (neither TP nor SL)
    makeCandle("2024-01-01T03:00:00Z", 1.1020, 1.1060, 1.0970, 1.1030), // MFE=+60, MAE=-30 (still neither)
    makeCandle("2024-01-01T04:00:00Z", 1.1030, 1.1070, 1.0980, 1.1050), // MFE=+70, MAE=-20 (MFE > MAE)
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,  // entry
    1.0900,  // SL (100 pips — never hit)
    1.1200,  // TP (200 pips — never hit)
    "2024-01-01T00:30:00Z",
  );

  // Even though MFE > MAE, outcome should be inconclusive
  assertEquals(result.outcome_status, "inconclusive");
  assertEquals(result.tp_hit, false);
  assertEquals(result.sl_hit, false);
  assertEquals(result.price_reached_entry, true);
});

// ─── Test 4: TP hit cleanly before SL → "would_have_won" ───
Deno.test("Clean TP hit before SL → would_have_won", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.1000), // Entry reached
    makeCandle("2024-01-01T02:00:00Z", 1.1000, 1.1030, 1.0970, 1.1025), // Price moves favorably
    makeCandle("2024-01-01T03:00:00Z", 1.1025, 1.1060, 1.1010, 1.1055), // Continues up
    makeCandle("2024-01-01T04:00:00Z", 1.1055, 1.1110, 1.1040, 1.1100), // TP hit (1.1100)
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,  // entry
    1.0950,  // SL (50 pips)
    1.1100,  // TP (100 pips)
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "would_have_won");
  assertEquals(result.tp_hit, true);
  assertEquals(result.sl_hit, false);
  assertEquals(result.price_reached_entry, true);
  // MFE should be capped at TP distance (0.0100)
  assertAlmostEquals(result.mfe_pips, 0.0100, 1e-10);
});

// ─── Test 5: Short trade — SL hit first ───
Deno.test("Short trade: SL hit first → would_have_lost", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.1002), // Entry reached (short at 1.1000)
    makeCandle("2024-01-01T02:00:00Z", 1.1002, 1.1060, 1.0998, 1.1055), // SL hit (SL=1.1050)
  ];

  const result = simulateOutcome(
    candles,
    "short",
    1.1000,  // entry
    1.1050,  // SL (50 pips above for short)
    1.0900,  // TP (100 pips below for short)
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "would_have_lost");
  assertEquals(result.sl_hit, true);
  assertEquals(result.tp_hit, false);
  // MAE capped at SL distance
  assertAlmostEquals(result.mae_pips, 0.0050, 1e-10);
});

// ─── Test 6: Short trade — TP hit cleanly ───
Deno.test("Short trade: TP hit cleanly → would_have_won", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.0998), // Entry reached
    makeCandle("2024-01-01T02:00:00Z", 1.0998, 1.1010, 1.0950, 1.0960), // Price drops
    makeCandle("2024-01-01T03:00:00Z", 1.0960, 1.0970, 1.0890, 1.0895), // TP hit (1.0900)
  ];

  const result = simulateOutcome(
    candles,
    "short",
    1.1000,  // entry
    1.1050,  // SL
    1.0900,  // TP
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "would_have_won");
  assertEquals(result.tp_hit, true);
  assertEquals(result.sl_hit, false);
  // MFE capped at TP distance (entry - TP = 0.0100)
  assertAlmostEquals(result.mfe_pips, 0.0100, 1e-10);
});

// ─── Test 7: Entry never reached → "inconclusive" ───
Deno.test("Entry never reached → inconclusive", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1020, 1.1005, 1.1015), // Price above entry (long at 1.0950)
    makeCandle("2024-01-01T02:00:00Z", 1.1015, 1.1030, 1.1000, 1.1025), // Still above
    makeCandle("2024-01-01T03:00:00Z", 1.1025, 1.1040, 1.1010, 1.1035), // Still above
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.0950,  // entry — never reached (price stays above 1.1000)
    1.0900,  // SL
    1.1100,  // TP
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "inconclusive");
  assertEquals(result.price_reached_entry, false);
  assertEquals(result.tp_hit, false);
  assertEquals(result.sl_hit, false);
  assertEquals(result.mfe_pips, 0);
  assertEquals(result.mae_pips, 0);
});

// ─── Test 8: The exact user-reported scenario — massive MFE/MAE both ~220 pips ───
// Simulates the case where price whipsaws 220 pips both ways over 24h.
// Old code: would_have_won (MFE slightly > MAE)
// New code: SL hit first → would_have_lost
Deno.test("USER REPORTED BUG: 220-pip whipsaw — SL hit first, not a win", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.3000, 1.3010, 1.2990, 1.3000), // Before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.3000, 1.3005, 1.2995, 1.3000), // Entry reached (short at 1.3000)
    // Price goes AGAINST the short (up) — hits SL
    makeCandle("2024-01-01T02:00:00Z", 1.3000, 1.3080, 1.2990, 1.3070), // Rising
    makeCandle("2024-01-01T03:00:00Z", 1.3070, 1.3150, 1.3060, 1.3140), // Rising more
    makeCandle("2024-01-01T04:00:00Z", 1.3140, 1.3230, 1.3130, 1.3220), // SL hit at 1.3200 (200 pips)
    // After SL — trade is DEAD. These candles should be IGNORED:
    makeCandle("2024-01-01T05:00:00Z", 1.3220, 1.3230, 1.3100, 1.3110), // Reversal starts
    makeCandle("2024-01-01T06:00:00Z", 1.3110, 1.3120, 1.2950, 1.2960), // Drops hard
    makeCandle("2024-01-01T07:00:00Z", 1.2960, 1.2970, 1.2780, 1.2800), // TP would be hit (1.2800) — BUT TRADE IS DEAD
  ];

  const result = simulateOutcome(
    candles,
    "short",
    1.3000,  // entry
    1.3200,  // SL (200 pips above)
    1.2800,  // TP (200 pips below)
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "would_have_lost");
  assertEquals(result.sl_hit, true);
  assertEquals(result.tp_hit, false); // Must NOT be true — trade was dead before TP
  // MAE capped at SL distance
  assertAlmostEquals(result.mae_pips, 0.0200, 1e-10); // 200 pips = 0.0200 for a non-JPY pair
  // sl_hit_time_minutes should be set
  assertEquals(typeof result.sl_hit_time_minutes, "number");
});

// ─── Test 9: No SL provided (null) — only TP matters ───
Deno.test("No SL provided → can only win or be inconclusive", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000),
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.1000), // Entry reached
    makeCandle("2024-01-01T02:00:00Z", 1.1000, 1.1030, 1.0950, 1.1020), // Big adverse move but no SL
    makeCandle("2024-01-01T03:00:00Z", 1.1020, 1.1110, 1.1010, 1.1100), // TP hit
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,
    null,    // No SL
    1.1100,  // TP
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "would_have_won");
  assertEquals(result.tp_hit, true);
  assertEquals(result.sl_hit, false);
});

// ─── Test 10: No TP provided (null) — only SL matters ───
Deno.test("No TP provided → can only lose or be inconclusive", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000),
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.1000), // Entry reached
    makeCandle("2024-01-01T02:00:00Z", 1.1000, 1.1010, 1.0940, 1.0945), // SL hit
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,
    1.0950,  // SL
    null,    // No TP
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "would_have_lost");
  assertEquals(result.sl_hit, true);
  assertEquals(result.tp_hit, false);
});

// ─── Test 11: Candles before rejection time are ignored ───
Deno.test("Candles before rejection time are skipped", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1200, 1.0800, 1.1000), // Would hit both — but before rejection
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1200, 1.0800, 1.1000), // Would hit both — but before rejection
    makeCandle("2024-01-01T03:00:00Z", 1.1000, 1.1005, 1.0995, 1.1000), // After rejection — entry reached
    makeCandle("2024-01-01T04:00:00Z", 1.1000, 1.1020, 1.0980, 1.1010), // Neither TP nor SL
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,
    1.0900,  // SL
    1.1100,  // TP
    "2024-01-01T02:00:00Z", // Rejected at 02:00 — only candles after this count
  );

  assertEquals(result.outcome_status, "inconclusive");
  assertEquals(result.price_reached_entry, true);
  assertEquals(result.tp_hit, false);
  assertEquals(result.sl_hit, false);
});

// ─── Test 12: sl_hit_time_minutes is correctly recorded ───
Deno.test("sl_hit_time_minutes is correctly calculated", () => {
  const candles = [
    makeCandle("2024-01-01T00:00:00Z", 1.1000, 1.1010, 1.0990, 1.1000),
    makeCandle("2024-01-01T01:00:00Z", 1.1000, 1.1005, 1.0995, 1.1000), // Entry reached at T+01:00
    makeCandle("2024-01-01T02:00:00Z", 1.1000, 1.1010, 1.0980, 1.0990), // No SL yet
    makeCandle("2024-01-01T03:00:00Z", 1.0990, 1.1000, 1.0940, 1.0945), // SL hit at T+03:00
  ];

  const result = simulateOutcome(
    candles,
    "long",
    1.1000,
    1.0950,  // SL
    1.1100,  // TP
    "2024-01-01T00:30:00Z",
  );

  assertEquals(result.outcome_status, "would_have_lost");
  // Entry at 01:00, SL at 03:00 → 120 minutes
  assertEquals(result.sl_hit_time_minutes, 120);
});
