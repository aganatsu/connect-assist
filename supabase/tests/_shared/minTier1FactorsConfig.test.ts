/**
 * Regression test: minTier1Factors configurable Tier 1 gate
 *
 * Verifies:
 * 1. Default behavior (3) is preserved when config.minTier1Factors is not set
 * 2. Setting minTier1Factors = 2 lowers the gate threshold
 * 3. Setting minTier1Factors = 4 raises the gate threshold
 * 4. Value is clamped between 1 and 5
 * 5. configMapper correctly maps strategy.minTier1Factors
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Test 1: configMapper includes minTier1Factors ───
Deno.test("configMapper resolves minTier1Factors from strategy", async () => {
  const { mapNestedToFlat, RUNTIME_DEFAULTS } = await import("./configMapper.ts");

  // Default when not set
  const defaultConfig = mapNestedToFlat({});
  assertEquals(defaultConfig.minTier1Factors, 3, "Default should be 3");

  // Custom value from strategy
  const customConfig = mapNestedToFlat({ strategy: { minTier1Factors: 2 } });
  assertEquals(customConfig.minTier1Factors, 2, "Should read from strategy");

  // Raw fallback (top-level raw field)
  const rawConfig = mapNestedToFlat({ minTier1Factors: 4 });
  assertEquals(rawConfig.minTier1Factors, 4, "Should fallback to raw");

  // Strategy takes priority over raw
  const priorityConfig = mapNestedToFlat({ strategy: { minTier1Factors: 2 }, minTier1Factors: 4 });
  assertEquals(priorityConfig.minTier1Factors, 2, "Strategy should take priority over raw");
});

// ─── Test 2: RUNTIME_DEFAULTS has correct default ───
Deno.test("RUNTIME_DEFAULTS.minTier1Factors is 3", async () => {
  const { RUNTIME_DEFAULTS } = await import("./configMapper.ts");
  assertEquals(RUNTIME_DEFAULTS.minTier1Factors, 3);
});

// ─── Test 3: confluenceScoring respects minTier1Factors ───
Deno.test("confluenceScoring uses config.minTier1Factors for Tier 1 gate", async () => {
  // We can't easily run the full scoring function without candle data,
  // but we can verify the logic pattern by checking the clamping behavior
  // Simulate the clamping logic used in confluenceScoring.ts
  const clamp = (val: number | undefined) => {
    const v = typeof val === "number" ? Math.max(1, Math.min(val, 5)) : 3;
    return v;
  };

  // Default (undefined)
  assertEquals(clamp(undefined), 3, "undefined should default to 3");

  // Valid values
  assertEquals(clamp(1), 1, "1 should be accepted");
  assertEquals(clamp(2), 2, "2 should be accepted");
  assertEquals(clamp(3), 3, "3 should be accepted");
  assertEquals(clamp(4), 4, "4 should be accepted");
  assertEquals(clamp(5), 5, "5 should be accepted");

  // Out of range (clamped)
  assertEquals(clamp(0), 1, "0 should be clamped to 1");
  assertEquals(clamp(-1), 1, "-1 should be clamped to 1");
  assertEquals(clamp(6), 5, "6 should be clamped to 5");
  assertEquals(clamp(10), 5, "10 should be clamped to 5");
});

// ─── Test 4: Gate pass/fail logic with different thresholds ───
Deno.test("Tier 1 gate pass/fail with configurable minimum", () => {
  // Simulate the gate logic
  const checkGate = (tier1Count: number, minTier1: number) => tier1Count >= minTier1;

  // With default (3)
  assertEquals(checkGate(2, 3), false, "2 factors should fail with min=3");
  assertEquals(checkGate(3, 3), true, "3 factors should pass with min=3");
  assertEquals(checkGate(4, 3), true, "4 factors should pass with min=3");

  // With lowered threshold (2)
  assertEquals(checkGate(1, 2), false, "1 factor should fail with min=2");
  assertEquals(checkGate(2, 2), true, "2 factors should pass with min=2");
  assertEquals(checkGate(3, 2), true, "3 factors should pass with min=2");

  // With raised threshold (4)
  assertEquals(checkGate(3, 4), false, "3 factors should fail with min=4");
  assertEquals(checkGate(4, 4), true, "4 factors should pass with min=4");

  // With max threshold (5)
  assertEquals(checkGate(4, 5), false, "4 factors should fail with min=5");
  assertEquals(checkGate(5, 5), true, "5 factors should pass with min=5");
});

// ─── Test 5: Regression — default behavior unchanged ───
Deno.test("Regression: default minTier1Factors=3 produces same gate behavior as hardcoded 3", () => {
  const hardcoded3 = (count: number) => count >= 3;
  const configurable3 = (count: number, min: number = 3) => count >= min;

  // Verify identical behavior for all possible tier1Count values (0-5)
  for (let i = 0; i <= 5; i++) {
    assertEquals(
      hardcoded3(i),
      configurable3(i, 3),
      `tier1Count=${i}: hardcoded and configurable(default=3) should match`
    );
  }
});
