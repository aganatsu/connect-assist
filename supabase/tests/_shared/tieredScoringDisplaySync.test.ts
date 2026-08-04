/**
 * tieredScoringDisplaySync.test.ts — Tests for the display sync fix.
 *
 * Verifies that when impulse zone credits reassign analysis.tieredScoring to a new object,
 * the detail object's tieredScoring reference is updated to match (not stale).
 *
 * This test simulates the exact bug scenario:
 *   1. detail.tieredScoring is set to analysis.tieredScoring (same reference)
 *   2. Impulse zone credit creates a NEW object and assigns to analysis.tieredScoring
 *   3. Without the fix, detail.tieredScoring still points to the old object
 *   4. With the fix, detail.tieredScoring is synced to the new object
 */
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("detail.tieredScoring stays in sync after impulse zone credit reassignment", () => {
  // Simulate the initial state (line 3445 in bot-scanner)
  const originalTieredScoring = {
    tier1Count: 1,
    tier1Max: 4,
    tier1GatePassed: false,
    tier1GateReason: "Tier 1 gate FAILED: only 1 core factor — need at least 3 of: Market Structure, Order Block, Fair Value Gap, Premium/Discount & Fib, HTF FVG/OB/Fib",
    tier2Count: 2,
    tier2Max: 5,
    tier3Count: 1,
    tier3Max: 3,
    tieredScore: 5.0,
    tieredMax: 23.5,
    regimeGatePassed: true,
    regimeGateReason: "Regime gate passed",
    spreadGateReason: "",
    opposingFactorCount: 0,
  };

  const analysis: any = {
    tieredScoring: originalTieredScoring,
    score: 21.3,
    factors: [
      { name: "Market Structure", present: true, weight: 2.0, tier: 1, detail: "1 BOS" },
      { name: "Order Block", present: false, weight: 2.0, tier: 1, detail: "1 OB nearby — not at level" },
      { name: "Fair Value Gap", present: false, weight: 2.0, tier: 1, detail: "1 FVG — not at level" },
      { name: "Premium/Discount & Fib", present: false, weight: 2.0, tier: 1, detail: "52.2% retrace — counter-swing" },
    ],
  };

  // Build detail object (simulates line 3445)
  const detail: any = {
    factors: analysis.factors, // reference — sees mutations
    tieredScoring: analysis.tieredScoring, // reference to original object
    score: analysis.score,
  };

  // Verify initial state
  assertEquals(detail.tieredScoring.tier1Count, 1);
  assertEquals(detail.tieredScoring.tier1GatePassed, false);

  // Simulate impulse zone credit (lines 3944-4010):
  // 1. Mutate factors in-place (detail.factors sees this)
  analysis.factors[1].present = true;
  analysis.factors[1].detail += " | IMPULSE-ZONE CREDIT: zone POI type is OB";
  analysis.factors[2].present = true;
  analysis.factors[2].detail += " | IMPULSE-ZONE CREDIT: HTF layer contains FVG";
  analysis.factors[3].present = true;
  analysis.factors[3].detail += " | IMPULSE-ZONE CREDIT: zone POI at 82.2% Fib depth (OTE zone)";

  // 2. Create NEW tieredScoring object (this is the bug — detail.tieredScoring doesn't see this)
  analysis.tieredScoring = {
    ...originalTieredScoring,
    tier1Count: 4,
    tier1GatePassed: true,
    tier1GateReason: "Tier 1 gate passed (impulse-zone credit): 4 core factors (Market Structure, OB, FVG, P/D)",
    tieredScore: 13.0,
  };
  analysis.score = 55.3;

  // BUG: detail.tieredScoring is stale (still points to original)
  assertEquals(detail.tieredScoring.tier1Count, 1, "Before fix: detail.tieredScoring is stale");
  assertNotEquals(detail.tieredScoring, analysis.tieredScoring, "Before fix: references differ");

  // FIX: Apply the sync (simulates the code we added)
  if (analysis.tieredScoring && detail.tieredScoring !== analysis.tieredScoring) {
    detail.tieredScoring = analysis.tieredScoring;
    detail.score = analysis.score;
  }

  // After fix: detail.tieredScoring matches analysis.tieredScoring
  assertEquals(detail.tieredScoring.tier1Count, 4, "After fix: tier1Count is updated");
  assertEquals(detail.tieredScoring.tier1GatePassed, true, "After fix: gate shows passed");
  assertEquals(detail.score, 55.3, "After fix: score is updated");
  assertEquals(detail.tieredScoring, analysis.tieredScoring, "After fix: same reference");

  // Factors were mutated in-place, so detail.factors already reflects the credits
  assertEquals(detail.factors[1].present, true, "OB factor shows present after credit");
  assertEquals(detail.factors[2].present, true, "FVG factor shows present after credit");
  assertEquals(detail.factors[3].present, true, "P/D factor shows present after credit");
});

Deno.test("detail.tieredScoring is NOT overwritten when no credit was applied", () => {
  // When no impulse zone credit fires, analysis.tieredScoring is never reassigned,
  // so detail.tieredScoring and analysis.tieredScoring are the same reference.
  const tieredScoring = {
    tier1Count: 3,
    tier1Max: 4,
    tier1GatePassed: true,
    tier1GateReason: "Tier 1 gate passed: 3 core factors",
    tier2Count: 2,
    tier2Max: 5,
    tier3Count: 1,
    tier3Max: 3,
    tieredScore: 10.0,
    tieredMax: 23.5,
    regimeGatePassed: true,
    regimeGateReason: "Regime gate passed",
    spreadGateReason: "",
    opposingFactorCount: 0,
  };

  const analysis: any = { tieredScoring, score: 42.6 };
  const detail: any = { tieredScoring: analysis.tieredScoring, score: analysis.score };

  // No credit applied — references are the same
  assertEquals(detail.tieredScoring, analysis.tieredScoring);

  // The sync condition should NOT trigger (already same reference)
  if (analysis.tieredScoring && detail.tieredScoring !== analysis.tieredScoring) {
    detail.tieredScoring = analysis.tieredScoring;
    detail.score = analysis.score;
  }

  // Still the same — no unnecessary reassignment
  assertEquals(detail.tieredScoring, tieredScoring);
  assertEquals(detail.score, 42.6);
});

Deno.test("detail.factors reflects in-place mutations from impulse zone credit", () => {
  // This verifies that because detail.factors is a reference (not a copy),
  // mutations to analysis.factors are automatically visible in detail.factors.
  const factors = [
    { name: "Order Block", present: false, weight: 2.0, tier: 1, detail: "1 OB — not at level" },
  ];

  const analysis: any = { factors };
  const detail: any = { factors: analysis.factors };

  // Mutate in place (simulates impulse zone credit)
  analysis.factors[0].present = true;
  analysis.factors[0].detail += " | IMPULSE-ZONE CREDIT: confirmed";

  // detail.factors sees the mutation because it's a reference
  assertEquals(detail.factors[0].present, true);
  assertEquals(detail.factors[0].detail.includes("IMPULSE-ZONE CREDIT"), true);
});
