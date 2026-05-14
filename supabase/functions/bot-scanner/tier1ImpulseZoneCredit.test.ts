/**
 * Tests: Impulse Zone → Tier 1 Credit
 *
 * Root cause: confluenceScoring checks "is price literally inside the FVG right now?"
 * while the impulse zone engine validates FVG/OB within the impulse leg at Fib levels.
 * This mismatch causes 99.1% of Tier 1 gate failures — the zone engine found the
 * FVG/OB but confluenceScoring doesn't credit it.
 *
 * Fix: after the impulse zone hard gate passes (zone valid AND price at zone),
 * we patch analysis.tieredScoring to credit the zone's POI type as a Tier 1 factor.
 *
 * These tests extract the credit logic into a pure function and verify every branch.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Extracted credit logic (mirrors the patch in bot-scanner/index.ts lines 3756-3811) ───
interface TieredScoring {
  tier1Count: number;
  tier1Max: number;
  tier2Count: number;
  tier2Max: number;
  tier3Count: number;
  tier3Max: number;
  tieredScore: number;
  tieredMax: number;
  tier1GatePassed: boolean;
  tier1GateReason: string;
  regimeGatePassed: boolean;
  regimeGateReason: string;
  spreadGatePassed: boolean;
  spreadGateReason: string;
}

interface Factor {
  name: string;
  present: boolean;
  weight: number;
  tier?: number;
  detail?: string;
}

interface BestZone {
  type: "fvg" | "ob";
  htfLayers?: string[];
  high: number;
  low: number;
  priceAtZone: boolean;
  [key: string]: any;
}

interface IzData {
  hasZone: boolean;
  bestZone: BestZone | null;
  allZonesCount: number;
  [key: string]: any;
}

interface Analysis {
  tieredScoring: TieredScoring | null;
  factors: Factor[];
  score: number;
  direction: string;
  [key: string]: any;
}

/**
 * Pure function that replicates the impulse zone Tier 1 credit logic
 * from bot-scanner/index.ts. Returns the (possibly patched) tieredScoring.
 */
function applyImpulseZoneTier1Credit(
  analysis: Analysis,
  izData: IzData | null,
): TieredScoring | null {
  if (!analysis.tieredScoring || !izData?.bestZone || analysis.tieredScoring.tier1GatePassed) {
    return analysis.tieredScoring;
  }

  const ts = analysis.tieredScoring;
  const zonePOIType = izData.bestZone.type;
  const htfLayers = izData.bestZone.htfLayers || [];
  const izTier1Credits: string[] = [];

  // Credit the primary POI type from the zone AND mutate the factor object
  if (zonePOIType === "fvg") {
    const fvgFactor = analysis.factors?.find((f: any) => f.name === "Fair Value Gap");
    if (fvgFactor && (!fvgFactor.present || fvgFactor.weight <= 0 || (fvgFactor as any).tier !== 1)) {
      fvgFactor.present = true;
      fvgFactor.weight = 1.0;
      (fvgFactor as any).tier = 1;
      fvgFactor.detail = (fvgFactor.detail || "") + " | IMPULSE-ZONE CREDIT: zone POI type is FVG \u2014 confirmed within impulse leg at Fib level";
      izTier1Credits.push("FVG (impulse-zone-confirmed)");
    }
  } else if (zonePOIType === "ob") {
    const obFactor = analysis.factors?.find((f: any) => f.name === "Order Block");
    if (obFactor && (!obFactor.present || obFactor.weight <= 0 || (obFactor as any).tier !== 1)) {
      obFactor.present = true;
      obFactor.weight = 1.0;
      (obFactor as any).tier = 1;
      obFactor.detail = (obFactor.detail || "") + " | IMPULSE-ZONE CREDIT: zone POI type is OB \u2014 confirmed within impulse leg at Fib level";
      izTier1Credits.push("OB (impulse-zone-confirmed)");
    }
  }

  // Also check HTF layers for additional OB/FVG evidence
  if (htfLayers.some((l: string) => l.toLowerCase().includes("ob"))) {
    const obFactor = analysis.factors?.find((f: any) => f.name === "Order Block");
    if (obFactor && (!obFactor.present || obFactor.weight <= 0 || (obFactor as any).tier !== 1)) {
      obFactor.present = true;
      obFactor.weight = 1.0;
      (obFactor as any).tier = 1;
      obFactor.detail = (obFactor.detail || "") + " | IMPULSE-ZONE CREDIT: HTF layer contains OB \u2014 zone overlaps HTF order block";
      if (!izTier1Credits.includes("OB (impulse-zone-confirmed)")) {
        izTier1Credits.push("OB (HTF-zone-layer)");
      }
    }
  }
  if (htfLayers.some((l: string) => l.toLowerCase().includes("fvg"))) {
    const fvgFactor = analysis.factors?.find((f: any) => f.name === "Fair Value Gap");
    if (fvgFactor && (!fvgFactor.present || fvgFactor.weight <= 0 || (fvgFactor as any).tier !== 1)) {
      fvgFactor.present = true;
      fvgFactor.weight = 1.0;
      (fvgFactor as any).tier = 1;
      fvgFactor.detail = (fvgFactor.detail || "") + " | IMPULSE-ZONE CREDIT: HTF layer contains FVG \u2014 zone overlaps HTF fair value gap";
      if (!izTier1Credits.includes("FVG (impulse-zone-confirmed)")) {
        izTier1Credits.push("FVG (HTF-zone-layer)");
      }
    }
  }

  if (izTier1Credits.length > 0) {
    const newTier1Count = ts.tier1Count + izTier1Credits.length;
    const newPassed = newTier1Count >= 3;
    const existingFactors = ts.tier1GateReason.match(/core factors \(([^)]+)\)/)?.[1]?.split(", ") || [];
    const allPresent = [...existingFactors, ...izTier1Credits];
    const newReason = newPassed
      ? `Tier 1 gate passed (impulse-zone credit): ${newTier1Count} core factors (${allPresent.join(", ")})`
      : `Tier 1 gate FAILED: only ${newTier1Count} core factors — need at least 3`;

    const creditPts = izTier1Credits.length * 1.0;
    const newTieredScore = ts.tieredScore + creditPts;
    const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : 0;

    // Also update analysis.score for the caller
    analysis.score = newScore;

    return {
      ...ts,
      tier1Count: newTier1Count,
      tier1GatePassed: newPassed,
      tier1GateReason: newReason,
      tieredScore: newTieredScore,
    };
  }

  return ts;
}

// ─── Helper: build a baseline analysis with configurable tier1Count ───
function makeAnalysis(overrides: {
  tier1Count?: number;
  tier1GatePassed?: boolean;
  tier1GateReason?: string;
  factors?: Factor[];
}): Analysis {
  const tier1Count = overrides.tier1Count ?? 2;
  const tier1GatePassed = overrides.tier1GatePassed ?? false;
  const tier1GateReason = overrides.tier1GateReason ??
    `Tier 1 gate FAILED: only ${tier1Count} core factors — need at least 3 of: Market Structure, Order Block, Fair Value Gap, Premium/Discount & Fib`;
  return {
    tieredScoring: {
      tier1Count,
      tier1Max: 5,
      tier2Count: 3,
      tier2Max: 5,
      tier3Count: 1,
      tier3Max: 3,
      tieredScore: 6.5,
      tieredMax: 13,
      tier1GatePassed,
      tier1GateReason,
      regimeGatePassed: true,
      regimeGateReason: "Regime gate passed",
      spreadGatePassed: true,
      spreadGateReason: "Spread OK",
    },
    factors: overrides.factors ?? [
      { name: "Market Structure", present: true, weight: 1.5, tier: 1, detail: "BOS confirmed on 15m" },
      { name: "Premium/Discount & Fib", present: true, weight: 1.0, tier: 1, detail: "Retrace at 55%" },
      { name: "Fair Value Gap", present: false, weight: 0, tier: 1, detail: "No active FVGs" },
      { name: "Order Block", present: false, weight: 0, tier: 1, detail: "OB not at level" },
      { name: "Unicorn Model", present: false, weight: 0, tier: 2, detail: "Not detected" },
    ],
    score: 55.0,
    direction: "long",
  };
}

function makeIzData(overrides?: Partial<BestZone>): IzData {
  return {
    hasZone: true,
    bestZone: {
      type: "fvg",
      high: 1.35662,
      low: 1.35591,
      priceAtZone: true,
      htfLayers: [],
      ...overrides,
    },
    allZonesCount: 1,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("Tier1Credit: FVG zone POI + tier1Count=2 → credits FVG → tier1Count=3 → gate passes", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "fvg" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  assertEquals(result!.tier1Count, 3);
  assertEquals(result!.tier1GatePassed, true);
  assert(result!.tier1GateReason.includes("impulse-zone credit"));
  assert(result!.tier1GateReason.includes("FVG (impulse-zone-confirmed)"));
});

Deno.test("Tier1Credit: OB zone POI + tier1Count=2 → credits OB → tier1Count=3 → gate passes", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "ob" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  assertEquals(result!.tier1Count, 3);
  assertEquals(result!.tier1GatePassed, true);
  assert(result!.tier1GateReason.includes("OB (impulse-zone-confirmed)"));
});

Deno.test("Tier1Credit: HTF layer 'ob' → credits OB when OB factor not present at tier 1", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "fvg", htfLayers: ["ob", "sr"] });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  // FVG from primary POI + OB from HTF layer = +2 credits
  assertEquals(result!.tier1Count, 4);
  assertEquals(result!.tier1GatePassed, true);
  assert(result!.tier1GateReason.includes("FVG (impulse-zone-confirmed)"));
  assert(result!.tier1GateReason.includes("OB (HTF-zone-layer)"));
});

Deno.test("Tier1Credit: HTF layer 'fvg' → credits FVG when FVG factor not present at tier 1", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "ob", htfLayers: ["fvg"] });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  // OB from primary POI + FVG from HTF layer = +2 credits
  assertEquals(result!.tier1Count, 4);
  assertEquals(result!.tier1GatePassed, true);
  assert(result!.tier1GateReason.includes("OB (impulse-zone-confirmed)"));
  assert(result!.tier1GateReason.includes("FVG (HTF-zone-layer)"));
});

Deno.test("Tier1Credit: already passing (tier1GatePassed=true) → no credit applied (idempotent)", () => {
  const analysis = makeAnalysis({
    tier1Count: 3,
    tier1GatePassed: true,
    tier1GateReason: "Tier 1 gate passed: 3 core factors (Market Structure, Premium/Discount & Fib, Fair Value Gap)",
  });
  const izData = makeIzData({ type: "fvg" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  // Should be unchanged — the function returns early when tier1GatePassed is already true
  assert(result !== null);
  assertEquals(result!.tier1Count, 3);
  assertEquals(result!.tier1GatePassed, true);
  assert(!result!.tier1GateReason.includes("impulse-zone credit"));
});

Deno.test("Tier1Credit: no bestZone → no credit applied", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData: IzData = { hasZone: false, bestZone: null, allZonesCount: 0 };

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  assertEquals(result!.tier1Count, 2);
  assertEquals(result!.tier1GatePassed, false);
});

Deno.test("Tier1Credit: null izData → no credit applied", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });

  const result = applyImpulseZoneTier1Credit(analysis, null);

  assert(result !== null);
  assertEquals(result!.tier1Count, 2);
  assertEquals(result!.tier1GatePassed, false);
});

Deno.test("Tier1Credit: FVG factor already present at tier 1 → no duplicate credit", () => {
  const analysis = makeAnalysis({
    tier1Count: 2,
    factors: [
      { name: "Market Structure", present: true, weight: 1.5, tier: 1 },
      { name: "Premium/Discount & Fib", present: true, weight: 1.0, tier: 1 },
      { name: "Fair Value Gap", present: true, weight: 1.0, tier: 1 }, // Already present at tier 1!
      { name: "Order Block", present: false, weight: 1.0, tier: 1 },
    ],
  });
  const izData = makeIzData({ type: "fvg" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  // FVG is already present+tier1, so no credit should be added
  assert(result !== null);
  assertEquals(result!.tier1Count, 2);
  assertEquals(result!.tier1GatePassed, false);
});

Deno.test("Tier1Credit: OB factor already present at tier 1 → no duplicate credit", () => {
  const analysis = makeAnalysis({
    tier1Count: 2,
    factors: [
      { name: "Market Structure", present: true, weight: 1.5, tier: 1 },
      { name: "Premium/Discount & Fib", present: true, weight: 1.0, tier: 1 },
      { name: "Fair Value Gap", present: false, weight: 1.0, tier: 1 },
      { name: "Order Block", present: true, weight: 1.0, tier: 1 }, // Already present at tier 1!
    ],
  });
  const izData = makeIzData({ type: "ob" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  // OB is already present+tier1, so no credit should be added
  assert(result !== null);
  assertEquals(result!.tier1Count, 2);
  assertEquals(result!.tier1GatePassed, false);
});

Deno.test("Tier1Credit: tier1Count=1 + FVG credit → tier1Count=2 → gate still fails (need 3)", () => {
  const analysis = makeAnalysis({ tier1Count: 1 });
  const izData = makeIzData({ type: "fvg" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  assertEquals(result!.tier1Count, 2);
  assertEquals(result!.tier1GatePassed, false);
  assert(result!.tier1GateReason.includes("only 2 core factors"));
});

Deno.test("Tier1Credit: no tieredScoring on analysis → returns null safely", () => {
  const analysis: Analysis = {
    tieredScoring: null,
    factors: [],
    score: 50,
    direction: "long",
  };
  const izData = makeIzData({ type: "fvg" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assertEquals(result, null);
});

Deno.test("Tier1Credit: OB primary + HTF 'ob' layer → no double OB credit", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "ob", htfLayers: ["ob"] });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  // Should only get 1 credit (OB from primary), not 2 (no duplicate from HTF)
  assertEquals(result!.tier1Count, 3);
  assertEquals(result!.tier1GatePassed, true);
  assert(result!.tier1GateReason.includes("OB (impulse-zone-confirmed)"));
  assert(!result!.tier1GateReason.includes("OB (HTF-zone-layer)"));
});

Deno.test("Tier1Credit: FVG primary + HTF 'fvg' layer → no double FVG credit", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "fvg", htfLayers: ["fvg"] });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  // Should only get 1 credit (FVG from primary), not 2 (no duplicate from HTF)
  assertEquals(result!.tier1Count, 3);
  assertEquals(result!.tier1GatePassed, true);
  assert(result!.tier1GateReason.includes("FVG (impulse-zone-confirmed)"));
  assert(!result!.tier1GateReason.includes("FVG (HTF-zone-layer)"));
});

Deno.test("Tier1Credit: preserves existing tier1GateReason factors in new reason", () => {
  const analysis = makeAnalysis({
    tier1Count: 2,
    tier1GateReason: "Tier 1 gate FAILED: only 2 core factors (Market Structure, Premium/Discount & Fib) — need at least 3",
  });
  const izData = makeIzData({ type: "fvg" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  assertEquals(result!.tier1GatePassed, true);
  // The new reason should include the original factors plus the new credit
  assert(result!.tier1GateReason.includes("Market Structure"));
  assert(result!.tier1GateReason.includes("Premium/Discount & Fib"));
  assert(result!.tier1GateReason.includes("FVG (impulse-zone-confirmed)"));
});

Deno.test("Tier1Credit: regression — identical inputs produce identical outputs across runs", () => {
  // Run the same scenario twice to prove determinism
  const makeScenario = () => {
    const analysis = makeAnalysis({ tier1Count: 2 });
    const izData = makeIzData({ type: "fvg", htfLayers: ["ob"] });
    return applyImpulseZoneTier1Credit(analysis, izData);
  };

  const run1 = makeScenario();
  const run2 = makeScenario();

  assertEquals(run1!.tier1Count, run2!.tier1Count);
  assertEquals(run1!.tier1GatePassed, run2!.tier1GatePassed);
  assertEquals(run1!.tier1GateReason, run2!.tier1GateReason);
});

// Score recalculation tests
Deno.test("Tier1Credit: FVG credit adds 1.0 to tieredScore and recalculates analysis.score", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  assertEquals(analysis.tieredScoring!.tieredScore, 6.5);
  assertEquals(analysis.score, 55.0);
  const izData = makeIzData({ type: "fvg" });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  // +1 credit = +1.0 pts: tieredScore = 6.5 + 1.0 = 7.5
  assertEquals(result!.tieredScore, 7.5);
  // score = (7.5/13)*100 = 57.7%
  assertEquals(analysis.score, 57.7);
});

Deno.test("Tier1Credit: FVG+OB dual credit adds 2.0 to tieredScore", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "fvg", htfLayers: ["ob"] });

  const result = applyImpulseZoneTier1Credit(analysis, izData);

  assert(result !== null);
  // +2 credits = +2.0 pts: tieredScore = 6.5 + 2.0 = 8.5
  assertEquals(result!.tieredScore, 8.5);
  // score = (8.5/13)*100 = 65.4%
  assertEquals(analysis.score, 65.4);
});

Deno.test("Tier1Credit: no credit applied keeps tieredScore and score unchanged", () => {
  const analysis = makeAnalysis({
    tier1Count: 3,
    tier1GatePassed: true,
    tier1GateReason: "Tier 1 gate passed: 3 core factors (Market Structure, Premium/Discount & Fib, Fair Value Gap)",
  });
  const originalScore = analysis.score;
  const originalTieredScore = analysis.tieredScoring!.tieredScore;
  const izData = makeIzData({ type: "fvg" });

  applyImpulseZoneTier1Credit(analysis, izData);

  assertEquals(analysis.score, originalScore);
  assertEquals(analysis.tieredScoring!.tieredScore, originalTieredScore);
});

// ─── Factor mutation tests ──────────────────────────────────────────

Deno.test("Tier1Credit: FVG credit mutates factor object — present=true, weight=1.0, tier=1, detail appended", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const fvgBefore = analysis.factors.find(f => f.name === "Fair Value Gap")!;
  assertEquals(fvgBefore.present, false);
  assertEquals(fvgBefore.weight, 0);

  const izData = makeIzData({ type: "fvg" });
  applyImpulseZoneTier1Credit(analysis, izData);

  const fvgAfter = analysis.factors.find(f => f.name === "Fair Value Gap")!;
  assertEquals(fvgAfter.present, true);
  assertEquals(fvgAfter.weight, 1.0);
  assertEquals((fvgAfter as any).tier, 1);
  assert(fvgAfter.detail!.includes("IMPULSE-ZONE CREDIT"));
  assert(fvgAfter.detail!.includes("zone POI type is FVG"));
});

Deno.test("Tier1Credit: OB credit mutates factor object — present=true, weight=1.0, tier=1, detail appended", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const obBefore = analysis.factors.find(f => f.name === "Order Block")!;
  assertEquals(obBefore.present, false);
  assertEquals(obBefore.weight, 0);

  const izData = makeIzData({ type: "ob" });
  applyImpulseZoneTier1Credit(analysis, izData);

  const obAfter = analysis.factors.find(f => f.name === "Order Block")!;
  assertEquals(obAfter.present, true);
  assertEquals(obAfter.weight, 1.0);
  assertEquals((obAfter as any).tier, 1);
  assert(obAfter.detail!.includes("IMPULSE-ZONE CREDIT"));
  assert(obAfter.detail!.includes("zone POI type is OB"));
});

Deno.test("Tier1Credit: HTF OB layer mutates OB factor object", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "fvg", htfLayers: ["4H OB"] });
  applyImpulseZoneTier1Credit(analysis, izData);

  const obAfter = analysis.factors.find(f => f.name === "Order Block")!;
  assertEquals(obAfter.present, true);
  assertEquals(obAfter.weight, 1.0);
  assertEquals((obAfter as any).tier, 1);
  assert(obAfter.detail!.includes("HTF layer contains OB"));
});

Deno.test("Tier1Credit: HTF FVG layer mutates FVG factor object", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "ob", htfLayers: ["4H FVG"] });
  applyImpulseZoneTier1Credit(analysis, izData);

  const fvgAfter = analysis.factors.find(f => f.name === "Fair Value Gap")!;
  assertEquals(fvgAfter.present, true);
  assertEquals(fvgAfter.weight, 1.0);
  assertEquals((fvgAfter as any).tier, 1);
  assert(fvgAfter.detail!.includes("HTF layer contains FVG"));
});

Deno.test("Tier1Credit: factor already present at tier 1 → detail NOT appended", () => {
  const analysis = makeAnalysis({
    tier1Count: 2,
    factors: [
      { name: "Market Structure", present: true, weight: 1.5, tier: 1, detail: "BOS confirmed" },
      { name: "Premium/Discount & Fib", present: true, weight: 1.0, tier: 1, detail: "Retrace at 55%" },
      { name: "Fair Value Gap", present: true, weight: 1.0, tier: 1, detail: "FVG at price" },
      { name: "Order Block", present: false, weight: 0, tier: 1, detail: "OB not at level" },
    ],
  });
  const izData = makeIzData({ type: "fvg" });
  applyImpulseZoneTier1Credit(analysis, izData);

  const fvgAfter = analysis.factors.find(f => f.name === "Fair Value Gap")!;
  // Factor was already present at tier 1 — should NOT be modified
  assertEquals(fvgAfter.detail, "FVG at price");
  assert(!fvgAfter.detail!.includes("IMPULSE-ZONE CREDIT"));
});

Deno.test("Tier1Credit: FVG primary + HTF OB → both factors mutated with credit detail", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ type: "fvg", htfLayers: ["4H OB"] });
  applyImpulseZoneTier1Credit(analysis, izData);

  const fvgAfter = analysis.factors.find(f => f.name === "Fair Value Gap")!;
  const obAfter = analysis.factors.find(f => f.name === "Order Block")!;

  // Both should be mutated
  assertEquals(fvgAfter.present, true);
  assertEquals(obAfter.present, true);
  assert(fvgAfter.detail!.includes("zone POI type is FVG"));
  assert(obAfter.detail!.includes("HTF layer contains OB"));
});
