/**
 * gateTier1Minimum.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkTier1Minimum produces the same pass/fail result as
 * both engines' old inline logic for identical inputs.
 *
 * Key divergence tested: bot-scanner treats undefined tier1GatePassed as FAIL (falsy),
 * backtest-engine treats it as PASS (?? true). The shared function accepts a boolean,
 * so each engine resolves this upstream — tested here to prove the divergence is
 * preserved correctly.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkTier1Minimum, type Tier1MinimumInput } from "./gateTier1Minimum.ts";

// ─── Old inline logic replicas ─────────────────────────────────────────────

/** Replicates bot-scanner Gate 19 inline logic (pre-extraction) */
function oldBotScannerTier1(
  config: { tier1GateEnabled?: boolean },
  ts: { tier1GatePassed?: boolean; tier1GateReason: string; tier1Count: number },
): { passed: boolean; reason: string } {
  if (config.tier1GateEnabled === false) {
    return { passed: true, reason: `Tier 1 gate DISABLED by config (${ts.tier1Count} core factors present)` };
  } else if (!ts.tier1GatePassed) {
    return { passed: false, reason: ts.tier1GateReason };
  } else {
    return { passed: true, reason: ts.tier1GateReason };
  }
}

/** Replicates backtest-engine Gate 16 inline logic (pre-extraction) */
function oldBacktestTier1(
  config: { tier1GateEnabled?: boolean },
  ts: { tier1GatePassed?: boolean; tier1GateReason?: string; tier1Count: number },
): { passed: boolean; reason: string } {
  if (config.tier1GateEnabled === false) {
    return { passed: true, reason: `Tier 1 gate DISABLED by config (${ts.tier1Count} core factors present)` };
  } else {
    const tier1Passed = ts.tier1GatePassed ?? true;
    return {
      passed: tier1Passed,
      reason: ts.tier1GateReason || (tier1Passed ? "Tier 1 gate passed" : "Tier 1 gate failed"),
    };
  }
}

// ─── Test cases ─────────────────────────────────────────────────────────────

const testCases = [
  { tier1GateEnabled: true, tier1GatePassed: true, tier1GateReason: "2/2 core factors (OB, FVG)", tier1Count: 2 },
  { tier1GateEnabled: true, tier1GatePassed: false, tier1GateReason: "1/2 core factors (OB)", tier1Count: 1 },
  { tier1GateEnabled: false, tier1GatePassed: false, tier1GateReason: "1/2 core factors (OB)", tier1Count: 1 },
  { tier1GateEnabled: false, tier1GatePassed: true, tier1GateReason: "3/2 core factors (OB, FVG, BOS)", tier1Count: 3 },
  { tier1GateEnabled: true, tier1GatePassed: true, tier1GateReason: "2/2 core factors (BOS, OB)", tier1Count: 2 },
  { tier1GateEnabled: true, tier1GatePassed: false, tier1GateReason: "0/2 core factors (none)", tier1Count: 0 },
];

Deno.test("cross-engine: shared matches bot-scanner inline pass/fail for all test cases", () => {
  for (const tc of testCases) {
    const config = { tier1GateEnabled: tc.tier1GateEnabled ? undefined : false };
    const ts = { tier1GatePassed: tc.tier1GatePassed, tier1GateReason: tc.tier1GateReason, tier1Count: tc.tier1Count };

    const oldResult = oldBotScannerTier1(config, ts);
    const newResult = checkTier1Minimum({
      tier1GateEnabled: config.tier1GateEnabled !== false,
      tier1GatePassed: !!ts.tier1GatePassed, // bot-scanner uses !! (falsy = false)
      tier1GateReason: ts.tier1GateReason,
      tier1Count: ts.tier1Count,
    });

    assertEquals(newResult.passed, oldResult.passed,
      `Bot-scanner mismatch: tier1GatePassed=${tc.tier1GatePassed}, enabled=${tc.tier1GateEnabled}`);
  }
});

Deno.test("cross-engine: shared matches backtest-engine inline pass/fail for all test cases", () => {
  for (const tc of testCases) {
    const config = { tier1GateEnabled: tc.tier1GateEnabled ? undefined : false };
    const ts = { tier1GatePassed: tc.tier1GatePassed, tier1GateReason: tc.tier1GateReason, tier1Count: tc.tier1Count };

    const oldResult = oldBacktestTier1(config, ts);
    const newResult = checkTier1Minimum({
      tier1GateEnabled: config.tier1GateEnabled !== false,
      tier1GatePassed: ts.tier1GatePassed ?? true, // backtest uses ?? true
      tier1GateReason: ts.tier1GateReason,
      tier1Count: ts.tier1Count,
    });

    assertEquals(newResult.passed, oldResult.passed,
      `Backtest mismatch: tier1GatePassed=${tc.tier1GatePassed}, enabled=${tc.tier1GateEnabled}`);
  }
});

Deno.test("divergence documentation: undefined tier1GatePassed treated differently per engine", () => {
  // Bot-scanner: !!undefined = false → FAIL
  const botResult = checkTier1Minimum({
    tier1GateEnabled: true,
    tier1GatePassed: !!undefined, // false
    tier1GateReason: "test reason",
    tier1Count: 0,
  });
  assertEquals(botResult.passed, false, "Bot-scanner should FAIL when tier1GatePassed is undefined");

  // Backtest: undefined ?? true = true → PASS
  const backtestResult = checkTier1Minimum({
    tier1GateEnabled: true,
    tier1GatePassed: undefined ?? true, // true
    tier1GateReason: "test reason",
    tier1Count: 0,
  });
  assertEquals(backtestResult.passed, true, "Backtest should PASS when tier1GatePassed is undefined");
});

Deno.test("gate disabled always passes regardless of tier1GatePassed", () => {
  const failInput: Tier1MinimumInput = {
    tier1GateEnabled: false,
    tier1GatePassed: false,
    tier1GateReason: "would fail if enabled",
    tier1Count: 0,
  };
  const result = checkTier1Minimum(failInput);
  assertEquals(result.passed, true);
  assert(result.reason.includes("DISABLED"), "Reason should mention DISABLED");
});

Deno.test("fallback reason strings when tier1GateReason is empty", () => {
  // Pass case with no upstream reason
  const passResult = checkTier1Minimum({
    tier1GateEnabled: true,
    tier1GatePassed: true,
    tier1GateReason: undefined,
    tier1Count: 3,
  });
  assertEquals(passResult.passed, true);
  assert(passResult.reason.includes("passed"), "Should have fallback pass reason");
  assert(passResult.reason.includes("3"), "Should include tier1Count");

  // Fail case with no upstream reason
  const failResult = checkTier1Minimum({
    tier1GateEnabled: true,
    tier1GatePassed: false,
    tier1GateReason: undefined,
    tier1Count: 1,
  });
  assertEquals(failResult.passed, false);
  assert(failResult.reason.includes("failed"), "Should have fallback fail reason");
});

Deno.test("reason string satisfies gatePerformanceEngine pattern: includes 'Tier 1'", () => {
  const patterns = ["Tier 1", "tier1", "T1 "];

  const results = [
    checkTier1Minimum({ tier1GateEnabled: true, tier1GatePassed: true, tier1GateReason: undefined, tier1Count: 2 }),
    checkTier1Minimum({ tier1GateEnabled: true, tier1GatePassed: false, tier1GateReason: undefined, tier1Count: 1 }),
    checkTier1Minimum({ tier1GateEnabled: false, tier1GatePassed: false, tier1GateReason: undefined, tier1Count: 0 }),
  ];

  for (const r of results) {
    const matches = patterns.some(p => r.reason.includes(p));
    assert(matches, `Reason "${r.reason}" should match at least one pattern: ${patterns.join(", ")}`);
  }
});

Deno.test("reason string satisfies backtest diagnostics: split(':')[0] is consistent", () => {
  const results = [
    checkTier1Minimum({ tier1GateEnabled: true, tier1GatePassed: true, tier1GateReason: undefined, tier1Count: 2 }),
    checkTier1Minimum({ tier1GateEnabled: true, tier1GatePassed: false, tier1GateReason: undefined, tier1Count: 1 }),
    checkTier1Minimum({ tier1GateEnabled: false, tier1GatePassed: false, tier1GateReason: undefined, tier1Count: 0 }),
  ];

  for (const r of results) {
    const key = r.reason.split(":")[0];
    assertEquals(key, "Tier 1 gate", `Expected aggregation key "Tier 1 gate", got "${key}" from "${r.reason}"`);
  }
});

Deno.test("pass-through reason: when tier1GateReason is provided, it's used directly", () => {
  const customReason = "2/2 core factors (OB, FVG)";
  const result = checkTier1Minimum({
    tier1GateEnabled: true,
    tier1GatePassed: true,
    tier1GateReason: customReason,
    tier1Count: 2,
  });
  assertEquals(result.reason, customReason, "Should pass through the upstream reason directly");
});
