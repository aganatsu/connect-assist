/**
 * pairGateOverrides.test.ts — Per-Pair Gate Override Tests
 * ─────────────────────────────────────────────────────────
 * Proves that:
 *   1. applyPairOverrides() correctly overrides specified fields
 *   2. Non-overridden fields retain their global values
 *   3. Non-overridden pairs are completely unaffected
 *   4. Empty/missing pairGateOverrides produces identical behavior to before
 *   5. mapNestedToFlat passes through pairGateOverrides from raw config
 *   6. Partial overrides only affect specified fields
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/pairGateOverrides.test.ts
 */

import { mapNestedToFlat, applyPairOverrides, RUNTIME_DEFAULTS } from "./configMapper.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Test 1: No overrides → config unchanged ──────────────────────────

Deno.test("applyPairOverrides: no overrides configured → config unchanged", () => {
  const config = { ...RUNTIME_DEFAULTS };
  const original = { ...config };
  applyPairOverrides(config, "EUR/JPY");
  assertEquals(config.minRiskReward, original.minRiskReward);
  assertEquals(config.maxPerSymbol, original.maxPerSymbol);
  assertEquals(config.allowSameDirectionStacking, original.allowSameDirectionStacking);
});

// ─── Test 2: Override minRiskReward for specific pair ──────────────────

Deno.test("applyPairOverrides: overrides minRiskReward for EUR/JPY only", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "EUR/JPY": { minRiskReward: 0.8 },
  }};
  applyPairOverrides(config, "EUR/JPY");
  assertEquals(config.minRiskReward, 0.8);
});

// ─── Test 3: Non-targeted pair unaffected ──────────────────────────────

Deno.test("applyPairOverrides: non-targeted pair retains global values", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "EUR/JPY": { minRiskReward: 0.8 },
  }};
  applyPairOverrides(config, "BTC/USD");
  assertEquals(config.minRiskReward, RUNTIME_DEFAULTS.minRiskReward);
});

// ─── Test 4: Multiple fields overridden ────────────────────────────────

Deno.test("applyPairOverrides: multiple fields overridden for one pair", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "EUR/JPY": {
      minRiskReward: 0.8,
      allowSameDirectionStacking: true,
      maxPerSymbol: 3,
      minStopPips: 12,
    },
  }};
  applyPairOverrides(config, "EUR/JPY");
  assertEquals(config.minRiskReward, 0.8);
  assertEquals(config.allowSameDirectionStacking, true);
  assertEquals(config.maxPerSymbol, 3);
  assertEquals((config as any).minStopPips, 12);
});

// ─── Test 5: Partial override only affects specified fields ────────────

Deno.test("applyPairOverrides: partial override leaves other fields at global", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "XAU/USD": { minStopPips: 35 },
  }};
  const originalMinRR = config.minRiskReward;
  const originalMaxPerSymbol = config.maxPerSymbol;
  applyPairOverrides(config, "XAU/USD");
  assertEquals((config as any).minStopPips, 35);
  assertEquals(config.minRiskReward, originalMinRR); // unchanged
  assertEquals(config.maxPerSymbol, originalMaxPerSymbol); // unchanged
});

// ─── Test 6: mapNestedToFlat passes through pairGateOverrides ──────────

Deno.test("mapNestedToFlat: pairGateOverrides passed through from raw config", () => {
  const overrides = {
    "EUR/JPY": { minRiskReward: 0.8, allowSameDirectionStacking: true },
    "BTC/USD": { maxPerSymbol: 1 },
  };
  const result = mapNestedToFlat({
    strategy: {},
    risk: { minRR: 1.5 },
    entry: {},
    instruments: {},
    sessions: {},
    pairGateOverrides: overrides,
  });
  assertEquals(result.pairGateOverrides, overrides);
});

// ─── Test 7: mapNestedToFlat with no pairGateOverrides → empty object ──

Deno.test("mapNestedToFlat: missing pairGateOverrides → empty object", () => {
  const result = mapNestedToFlat({
    strategy: {},
    risk: {},
    entry: {},
    instruments: {},
    sessions: {},
  });
  assertEquals(result.pairGateOverrides, {});
});

// ─── Test 8: Protection fields override correctly ──────────────────────

Deno.test("applyPairOverrides: protectionMaxDailyLossDollar and maxConsecutiveLosses", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "GBP/USD": {
      protectionMaxDailyLossDollar: 5000,
      maxConsecutiveLosses: 8,
    },
  }};
  applyPairOverrides(config, "GBP/USD");
  assertEquals((config as any).protectionMaxDailyLossDollar, 5000);
  assertEquals((config as any).maxConsecutiveLosses, 8);
});

// ─── Test 9: Regression — default behavior identical without overrides ──

Deno.test("regression: mapNestedToFlat + applyPairOverrides with empty overrides = pure RUNTIME_DEFAULTS behavior", () => {
  const configWithOverrides = mapNestedToFlat({
    strategy: {},
    risk: {},
    entry: {},
    instruments: {},
    sessions: {},
    pairGateOverrides: {},
  });
  const configWithout = mapNestedToFlat({
    strategy: {},
    risk: {},
    entry: {},
    instruments: {},
    sessions: {},
  });

  // Apply overrides to a non-configured pair — should be no-op
  applyPairOverrides(configWithOverrides, "EUR/USD");

  assertEquals(configWithOverrides.minRiskReward, configWithout.minRiskReward);
  assertEquals(configWithOverrides.maxPerSymbol, configWithout.maxPerSymbol);
  assertEquals(configWithOverrides.allowSameDirectionStacking, configWithout.allowSameDirectionStacking);
});

// ─── Test 10: applyPairOverrides returns same reference ────────────────

Deno.test("applyPairOverrides: returns same config reference (mutation, not copy)", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "EUR/JPY": { minRiskReward: 0.5 },
  }};
  const returned = applyPairOverrides(config, "EUR/JPY");
  assert(returned === config, "Should return the same object reference");
});

// ─── Test 11: Multiple pairs configured, each gets own values ──────────

Deno.test("applyPairOverrides: different pairs get different override values", () => {
  const overrides = {
    "EUR/JPY": { minRiskReward: 0.8, maxPerSymbol: 1 },
    "BTC/USD": { minRiskReward: 2.0, maxPerSymbol: 4 },
    "XAU/USD": { minStopPips: 35 },
  };

  // EUR/JPY
  const config1 = { ...RUNTIME_DEFAULTS, pairGateOverrides: overrides };
  applyPairOverrides(config1, "EUR/JPY");
  assertEquals(config1.minRiskReward, 0.8);
  assertEquals(config1.maxPerSymbol, 1);

  // BTC/USD
  const config2 = { ...RUNTIME_DEFAULTS, pairGateOverrides: overrides };
  applyPairOverrides(config2, "BTC/USD");
  assertEquals(config2.minRiskReward, 2.0);
  assertEquals(config2.maxPerSymbol, 4);

  // XAU/USD
  const config3 = { ...RUNTIME_DEFAULTS, pairGateOverrides: overrides };
  applyPairOverrides(config3, "XAU/USD");
  assertEquals((config3 as any).minStopPips, 35);
  assertEquals(config3.minRiskReward, RUNTIME_DEFAULTS.minRiskReward); // not overridden
});

// ─── Test 12: Override with value 0 is valid (not treated as falsy) ────

Deno.test("applyPairOverrides: value of 0 is applied (not skipped as falsy)", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "EUR/USD": { maxConsecutiveLosses: 0 },
  }};
  // Set a non-zero value first to prove it changes
  (config as any).maxConsecutiveLosses = 6;
  applyPairOverrides(config, "EUR/USD");
  assertEquals((config as any).maxConsecutiveLosses, 0);
});

// ─── Test 13: Override with false is valid ──────────────────────────────

Deno.test("applyPairOverrides: allowSameDirectionStacking=false is applied", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "BTC/USD": { allowSameDirectionStacking: false },
  }};
  config.allowSameDirectionStacking = true; // set to true first
  applyPairOverrides(config, "BTC/USD");
  assertEquals(config.allowSameDirectionStacking, false);
});

// ─── Test 14: removed overrides are ignored ──────────────────────────
// minTier1Factors and minConfluence were per-pair overrides of the confluence score / Tier 1
// gate. Both were removed; an override still stored in a config must change nothing.

Deno.test("applyPairOverrides: stored minTier1Factors / minConfluence overrides are ignored", () => {
  const config = { ...RUNTIME_DEFAULTS, pairGateOverrides: {
    "EUR/JPY": { minTier1Factors: 1, minConfluence: 35 } as any,
  }} as any;
  applyPairOverrides(config, "EUR/JPY");
  assertEquals("minTier1Factors" in config, false);
  assertEquals("minConfluence" in config, false);
  assertEquals("tier1GateEnabled" in RUNTIME_DEFAULTS, false);
});
