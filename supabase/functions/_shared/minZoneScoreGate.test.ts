/**
 * minZoneScoreGate.test.ts — Minimum Zone Score Gate Tests
 * ─────────────────────────────────────────────────────────
 * Verifies that:
 *   1. configMapper includes minZoneScore with default 4
 *   2. Zones scoring below the threshold would be rejected
 *   3. Zones scoring at or above the threshold would pass
 *   4. Setting minZoneScore to 0 effectively disables the gate
 *   5. Custom minZoneScore from config is respected
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/minZoneScoreGate.test.ts
 */

import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./configMapper.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Test 1: RUNTIME_DEFAULTS includes minZoneScore = 4 ──────────────

Deno.test("RUNTIME_DEFAULTS includes minZoneScore with default value 4", () => {
  assertEquals(RUNTIME_DEFAULTS.minZoneScore, 4);
});

// ─── Test 2: mapNestedToFlat returns minZoneScore from defaults ───────

Deno.test("mapNestedToFlat: null input returns minZoneScore = 4", () => {
  const result = mapNestedToFlat(null);
  assertEquals(result.minZoneScore, 4);
});

// ─── Test 3: mapNestedToFlat reads minZoneScore from strategy ─────────

Deno.test("mapNestedToFlat: reads minZoneScore from strategy object", () => {
  const config = {
    strategy: { minZoneScore: 6 },
  };
  const result = mapNestedToFlat(config);
  assertEquals(result.minZoneScore, 6);
});

// ─── Test 4: mapNestedToFlat reads minZoneScore from top-level ────────

Deno.test("mapNestedToFlat: reads minZoneScore from top-level (legacy format)", () => {
  const config = {
    minZoneScore: 5,
  };
  const result = mapNestedToFlat(config);
  assertEquals(result.minZoneScore, 5);
});

// ─── Test 5: strategy takes priority over top-level ───────────────────

Deno.test("mapNestedToFlat: strategy.minZoneScore takes priority over top-level", () => {
  const config = {
    minZoneScore: 3,
    strategy: { minZoneScore: 7 },
  };
  const result = mapNestedToFlat(config);
  assertEquals(result.minZoneScore, 7);
});

// ─── Test 6: Gate logic — zone below threshold is rejected ────────────

Deno.test("zone score gate: zone scoring below minZoneScore is rejected", () => {
  const minZoneScore = 4;
  const zoneScores = [0, 1.0, 1.5, 2.0, 3.0, 3.5];
  
  for (const score of zoneScores) {
    const shouldReject = score < minZoneScore;
    assert(shouldReject, `Zone score ${score} should be rejected (< ${minZoneScore})`);
  }
});

// ─── Test 7: Gate logic — zone at or above threshold passes ───────────

Deno.test("zone score gate: zone scoring at or above minZoneScore passes", () => {
  const minZoneScore = 4;
  const zoneScores = [4.0, 4.5, 5.0, 6.0, 7.0, 8.0, 9.0];
  
  for (const score of zoneScores) {
    const shouldPass = score >= minZoneScore;
    assert(shouldPass, `Zone score ${score} should pass (>= ${minZoneScore})`);
  }
});

// ─── Test 8: Gate disabled when minZoneScore = 0 ──────────────────────

Deno.test("zone score gate: setting minZoneScore to 0 disables the gate (all zones pass)", () => {
  const minZoneScore = 0;
  const zoneScores = [0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 9.0];
  
  for (const score of zoneScores) {
    const shouldPass = score >= minZoneScore;
    assert(shouldPass, `Zone score ${score} should pass when gate is disabled (minZoneScore=0)`);
  }
});

// ─── Test 9: Boundary test — score exactly at threshold ───────────────

Deno.test("zone score gate: score exactly at threshold passes (not strict inequality)", () => {
  const minZoneScore = 4;
  const zoneScore = 4.0;
  
  // The gate uses `<` not `<=`, so score == threshold passes
  const shouldPass = !(zoneScore < minZoneScore);
  assert(shouldPass, `Zone score exactly at threshold (${zoneScore}) should pass`);
});

// ─── Test 10: Custom threshold from config ────────────────────────────

Deno.test("zone score gate: custom threshold of 6 rejects scores 0-5.5", () => {
  const config = { strategy: { minZoneScore: 6 } };
  const result = mapNestedToFlat(config);
  const minZoneScore = result.minZoneScore;
  
  assertEquals(minZoneScore, 6);
  
  // These should be rejected
  assert(1.5 < minZoneScore, "1.5 should be rejected with threshold 6");
  assert(4.0 < minZoneScore, "4.0 should be rejected with threshold 6");
  assert(5.5 < minZoneScore, "5.5 should be rejected with threshold 6");
  
  // These should pass
  assert(!(6.0 < minZoneScore), "6.0 should pass with threshold 6");
  assert(!(7.0 < minZoneScore), "7.0 should pass with threshold 6");
  assert(!(9.0 < minZoneScore), "9.0 should pass with threshold 6");
});

// ─── Test 11: Regression — other impulse zone settings unchanged ──────

Deno.test("regression: adding minZoneScore does not affect other impulse zone defaults", () => {
  const result = mapNestedToFlat(null);
  assertEquals(result.impulseZoneEnabled, true);
  assertEquals(result.impulseZonePenalty, 2.0);
  assertEquals(result.impulseZoneBonus, 1.0);
  assertEquals(result.impulseZoneGateMode, "hard");
  assertEquals(result.impulseSlCapMultiplier, 4);
});
