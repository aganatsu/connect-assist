/**
 * Tests: Impulse Zone → Extended Credits (P/D & Fib, Confluence Stack, HTF POI Alignment)
 *
 * These tests cover three additional credit patches applied in bot-scanner/index.ts
 * AFTER the impulse zone hard gate passes and BEFORE gates are evaluated:
 *
 * 1. P/D & Fib Credit (Tier 1): When the impulse zone validates a POI at fibDepth >= 0.5,
 *    credit the Premium/Discount & Fib factor even if the entry-TF zigzag disagrees.
 *
 * 2. Confluence Stack Credit (Tier 2): When the impulse zone has srConfirmed + HTF layers
 *    totaling >= 2 layers, credit the Confluence Stack factor.
 *
 * 3. HTF POI Alignment Credit (Tier 2): When priceAtZone is true and the zone has HTF
 *    OB/FVG layers, credit the HTF POI Alignment factor.
 *
 * Each credit is extracted as a pure function mirroring the bot-scanner logic.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Shared types ───────────────────────────────────────────────────────────
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
  detail: string;
  tier?: number;
}

interface BestZone {
  type: "fvg" | "ob";
  htfLayers?: string[];
  high: number;
  low: number;
  priceAtZone: boolean;
  fibDepth?: number;
  srConfirmed?: boolean;
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

// ─── Extracted credit logic #1: P/D & Fib Credit ────────────────────────────
function applyPDFibCredit(analysis: Analysis, izData: IzData | null): void {
  if (!analysis.tieredScoring || !izData?.bestZone) return;

  const pdFactor = analysis.factors?.find((f: any) => f.name === "Premium/Discount & Fib");
  const fibDepth = izData.bestZone.fibDepth ?? 0;
  if (pdFactor && (!pdFactor.present || pdFactor.weight <= 0) && fibDepth >= 0.5) {
    const fibPct = (fibDepth * 100).toFixed(1);
    const izFibLabel = fibDepth >= 0.618 ? "OTE zone" : "discount/premium zone";
    pdFactor.present = true;
    pdFactor.weight = fibDepth >= 0.71 ? 2.0 : fibDepth >= 0.618 ? 1.5 : 1.0;
    (pdFactor as any).tier = 1;
    pdFactor.detail += ` | IMPULSE-ZONE CREDIT: zone POI at ${fibPct}% Fib depth (${izFibLabel}) — 1H impulse leg confirms P/D alignment`;
    // Update tieredScoring
    const ts = analysis.tieredScoring;
    if (ts && (ts as any).tier1Count !== undefined) {
      const newCount = ts.tier1Count + 1;
      const newPassed = newCount >= 3;
      const existingFactors = ts.tier1GateReason.match(/core factors \(([^)]+)\)/)?.[1]?.split(", ") || [];
      existingFactors.push(`P/D (impulse-zone-fib ${fibPct}%)`);
      analysis.tieredScoring = {
        ...ts,
        tier1Count: newCount,
        tier1GatePassed: newPassed,
        tier1GateReason: newPassed
          ? `Tier 1 gate passed (impulse-zone credit): ${newCount} core factors (${existingFactors.join(", ")})`
          : `Tier 1 gate FAILED: only ${newCount} core factors — need at least 3`,
      };
    }
  }
}

// ─── Extracted credit logic #2: Confluence Stack Credit ─────────────────────
function applyConfluenceStackCredit(analysis: Analysis, izData: IzData | null): void {
  if (!analysis.tieredScoring || !izData?.bestZone) return;

  const stackFactor = analysis.factors?.find((f: any) => f.name === "Confluence Stack");
  const srConfirmed = izData.bestZone.srConfirmed ?? false;
  const htfLayers = izData.bestZone.htfLayers || [];
  const stackLayers = (srConfirmed ? 1 : 0) + htfLayers.length;
  if (stackFactor && (!stackFactor.present || stackFactor.weight <= 0) && stackLayers >= 2) {
    const layerLabels: string[] = [];
    if (srConfirmed) layerLabels.push("S/R");
    layerLabels.push(...htfLayers);
    stackFactor.present = true;
    stackFactor.weight = stackLayers >= 3 ? 1.5 : 1.0;
    stackFactor.detail += ` | IMPULSE-ZONE CREDIT: zone has ${stackLayers}-layer confluence (${layerLabels.join(" + ")}) — stacking confirmed from impulse leg`;
    // Update tier2Count
    const ts = analysis.tieredScoring;
    if (ts && (ts as any).tier2Count !== undefined) {
      analysis.tieredScoring = {
        ...ts,
        tier2Count: ts.tier2Count + 1,
      };
    }
  }
}

// ─── Extracted credit logic #3: HTF POI Alignment Credit ────────────────────
function applyHTFPOIAlignmentCredit(analysis: Analysis, izData: IzData | null): void {
  if (!analysis.tieredScoring || !izData?.bestZone || !izData.bestZone.priceAtZone) return;

  const htfPoiFactor = analysis.factors?.find((f: any) => f.name === "HTF POI Alignment");
  const htfLayers = izData.bestZone.htfLayers || [];
  const hasHTFOBorFVG = htfLayers.some((l: string) => l.toLowerCase().includes("ob") || l.toLowerCase().includes("fvg"));
  if (htfPoiFactor && (!htfPoiFactor.present || htfPoiFactor.weight <= 0) && hasHTFOBorFVG) {
    const obLayers = htfLayers.filter((l: string) => l.toLowerCase().includes("ob"));
    const fvgLayers = htfLayers.filter((l: string) => l.toLowerCase().includes("fvg"));
    let boost = 0;
    if (fvgLayers.length > 0) boost += 0.8;
    if (obLayers.length > 0) boost += 0.7;
    boost = Math.min(2.0, boost);
    htfPoiFactor.present = true;
    htfPoiFactor.weight = boost;
    htfPoiFactor.detail += ` | IMPULSE-ZONE CREDIT: zone overlaps ${htfLayers.join(", ")} — price at zone confirms HTF POI alignment`;
    // Update tier2Count
    const ts = analysis.tieredScoring;
    if (ts && (ts as any).tier2Count !== undefined) {
      analysis.tieredScoring = {
        ...ts,
        tier2Count: ts.tier2Count + 1,
      };
    }
  }
}

// ─── Helper: build a baseline analysis ──────────────────────────────────────
function makeAnalysis(overrides?: {
  tier1Count?: number;
  tier2Count?: number;
  tier1GatePassed?: boolean;
  tier1GateReason?: string;
  factors?: Factor[];
}): Analysis {
  const tier1Count = overrides?.tier1Count ?? 2;
  const tier2Count = overrides?.tier2Count ?? 3;
  const tier1GatePassed = overrides?.tier1GatePassed ?? false;
  const tier1GateReason = overrides?.tier1GateReason ??
    `Tier 1 gate FAILED: only ${tier1Count} core factors (Market Structure, Order Block) — need at least 3`;
  return {
    tieredScoring: {
      tier1Count,
      tier1Max: 5,
      tier2Count,
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
    factors: overrides?.factors ?? [
      { name: "Market Structure", present: true, weight: 1.5, detail: "Bullish BOS confirmed", tier: 1 },
      { name: "Order Block", present: true, weight: 1.0, detail: "Bullish OB at 1.3550", tier: 1 },
      { name: "Fair Value Gap", present: false, weight: 0, detail: "No FVG at price", tier: 1 },
      { name: "Premium/Discount & Fib", present: false, weight: 0, detail: "Retrace 35% — below threshold", tier: 1 },
      { name: "Confluence Stack", present: false, weight: 0, detail: "No stacking detected", tier: 2 },
      { name: "HTF POI Alignment", present: false, weight: 0, detail: "Price not inside HTF POI", tier: 2 },
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
      fibDepth: 0.618,
      srConfirmed: false,
      ...overrides,
    },
    allZonesCount: 1,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// P/D & FIB CREDIT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("PDCredit: fibDepth=0.618 → credits P/D factor with weight 1.5 (OTE zone)", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ fibDepth: 0.618 });

  applyPDFibCredit(analysis, izData);

  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  assertEquals(pdFactor.present, true);
  assertEquals(pdFactor.weight, 1.5);
  assert(pdFactor.detail.includes("IMPULSE-ZONE CREDIT"));
  assert(pdFactor.detail.includes("61.8%"));
  assert(pdFactor.detail.includes("OTE zone"));
  assertEquals(analysis.tieredScoring!.tier1Count, 3);
  assertEquals(analysis.tieredScoring!.tier1GatePassed, true);
});

Deno.test("PDCredit: fibDepth=0.71 → credits P/D factor with weight 2.0 (deep OTE)", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ fibDepth: 0.71 });

  applyPDFibCredit(analysis, izData);

  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  assertEquals(pdFactor.present, true);
  assertEquals(pdFactor.weight, 2.0);
  assert(pdFactor.detail.includes("71.0%"));
});

Deno.test("PDCredit: fibDepth=0.5 → credits P/D factor with weight 1.0 (discount/premium zone)", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ fibDepth: 0.5 });

  applyPDFibCredit(analysis, izData);

  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  assertEquals(pdFactor.present, true);
  assertEquals(pdFactor.weight, 1.0);
  assert(pdFactor.detail.includes("50.0%"));
  assert(pdFactor.detail.includes("discount/premium zone"));
});

Deno.test("PDCredit: fibDepth=0.786 → credits P/D factor with weight 2.0", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ fibDepth: 0.786 });

  applyPDFibCredit(analysis, izData);

  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  assertEquals(pdFactor.present, true);
  assertEquals(pdFactor.weight, 2.0);
  assert(pdFactor.detail.includes("78.6%"));
});

Deno.test("PDCredit: fibDepth=0.45 (below 0.5) → NO credit applied", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData = makeIzData({ fibDepth: 0.45 });

  applyPDFibCredit(analysis, izData);

  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  assertEquals(pdFactor.present, false);
  assertEquals(pdFactor.weight, 0);
  assertEquals(analysis.tieredScoring!.tier1Count, 2);
});

Deno.test("PDCredit: P/D factor already present → NO duplicate credit", () => {
  const analysis = makeAnalysis({
    tier1Count: 3,
    tier1GatePassed: true,
    tier1GateReason: "Tier 1 gate passed: 3 core factors (MS, OB, P/D)",
    factors: [
      { name: "Market Structure", present: true, weight: 1.5, detail: "BOS", tier: 1 },
      { name: "Order Block", present: true, weight: 1.0, detail: "OB", tier: 1 },
      { name: "Premium/Discount & Fib", present: true, weight: 1.5, detail: "Already scored", tier: 1 },
      { name: "Confluence Stack", present: false, weight: 0, detail: "None", tier: 2 },
      { name: "HTF POI Alignment", present: false, weight: 0, detail: "None", tier: 2 },
    ],
  });
  const izData = makeIzData({ fibDepth: 0.618 });

  applyPDFibCredit(analysis, izData);

  // Should remain unchanged
  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  assertEquals(pdFactor.weight, 1.5); // Original weight preserved
  assert(!pdFactor.detail.includes("IMPULSE-ZONE CREDIT"));
});

Deno.test("PDCredit: no bestZone → NO credit applied", () => {
  const analysis = makeAnalysis({ tier1Count: 2 });
  const izData: IzData = { hasZone: false, bestZone: null, allZonesCount: 0 };

  applyPDFibCredit(analysis, izData);

  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  assertEquals(pdFactor.present, false);
  assertEquals(analysis.tieredScoring!.tier1Count, 2);
});

Deno.test("PDCredit: null tieredScoring → no crash, no credit", () => {
  const analysis: Analysis = { tieredScoring: null, factors: [], score: 50, direction: "long" };
  const izData = makeIzData({ fibDepth: 0.618 });

  applyPDFibCredit(analysis, izData);

  assertEquals(analysis.tieredScoring, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFLUENCE STACK CREDIT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("StackCredit: srConfirmed + 1 HTF layer (2 total) → credits Confluence Stack with weight 1.0", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ srConfirmed: true, htfLayers: ["4H_OB"] });

  applyConfluenceStackCredit(analysis, izData);

  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  assertEquals(stackFactor.present, true);
  assertEquals(stackFactor.weight, 1.0);
  assert(stackFactor.detail.includes("IMPULSE-ZONE CREDIT"));
  assert(stackFactor.detail.includes("2-layer confluence"));
  assert(stackFactor.detail.includes("S/R"));
  assert(stackFactor.detail.includes("4H_OB"));
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("StackCredit: srConfirmed + 2 HTF layers (3 total) → credits with weight 1.5", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ srConfirmed: true, htfLayers: ["4H_OB", "HTF_FIB_61.8"] });

  applyConfluenceStackCredit(analysis, izData);

  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  assertEquals(stackFactor.present, true);
  assertEquals(stackFactor.weight, 1.5);
  assert(stackFactor.detail.includes("3-layer confluence"));
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("StackCredit: only 1 layer (srConfirmed only, no HTF) → NO credit (need >= 2)", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ srConfirmed: true, htfLayers: [] });

  applyConfluenceStackCredit(analysis, izData);

  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  assertEquals(stackFactor.present, false);
  assertEquals(stackFactor.weight, 0);
  assertEquals(analysis.tieredScoring!.tier2Count, 2);
});

Deno.test("StackCredit: no srConfirmed + 1 HTF layer → NO credit (only 1 layer)", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ srConfirmed: false, htfLayers: ["4H_FVG"] });

  applyConfluenceStackCredit(analysis, izData);

  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  assertEquals(stackFactor.present, false);
  assertEquals(analysis.tieredScoring!.tier2Count, 2);
});

Deno.test("StackCredit: no srConfirmed + 2 HTF layers → credits (2 layers from HTF alone)", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ srConfirmed: false, htfLayers: ["4H_OB", "4H_FVG"] });

  applyConfluenceStackCredit(analysis, izData);

  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  assertEquals(stackFactor.present, true);
  assertEquals(stackFactor.weight, 1.0);
  assert(stackFactor.detail.includes("2-layer confluence"));
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("StackCredit: Confluence Stack already present → NO duplicate credit", () => {
  const analysis = makeAnalysis({
    tier2Count: 3,
    factors: [
      { name: "Market Structure", present: true, weight: 1.5, detail: "BOS", tier: 1 },
      { name: "Order Block", present: true, weight: 1.0, detail: "OB", tier: 1 },
      { name: "Premium/Discount & Fib", present: false, weight: 0, detail: "None", tier: 1 },
      { name: "Confluence Stack", present: true, weight: 1.5, detail: "Already stacked", tier: 2 },
      { name: "HTF POI Alignment", present: false, weight: 0, detail: "None", tier: 2 },
    ],
  });
  const izData = makeIzData({ srConfirmed: true, htfLayers: ["4H_OB", "4H_FVG"] });

  applyConfluenceStackCredit(analysis, izData);

  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  assertEquals(stackFactor.weight, 1.5); // Original weight preserved
  assert(!stackFactor.detail.includes("IMPULSE-ZONE CREDIT"));
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("StackCredit: null tieredScoring → no crash", () => {
  const analysis: Analysis = { tieredScoring: null, factors: [], score: 50, direction: "long" };
  const izData = makeIzData({ srConfirmed: true, htfLayers: ["4H_OB"] });

  applyConfluenceStackCredit(analysis, izData);

  assertEquals(analysis.tieredScoring, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTF POI ALIGNMENT CREDIT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("HTFPOICredit: priceAtZone + HTF FVG layer → credits with boost 0.8", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ priceAtZone: true, htfLayers: ["4H_FVG"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, true);
  assertEquals(htfFactor.weight, 0.8);
  assert(htfFactor.detail.includes("IMPULSE-ZONE CREDIT"));
  assert(htfFactor.detail.includes("4H_FVG"));
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("HTFPOICredit: priceAtZone + HTF OB layer → credits with boost 0.7", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ priceAtZone: true, htfLayers: ["4H_OB"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, true);
  assertEquals(htfFactor.weight, 0.7);
  assert(htfFactor.detail.includes("4H_OB"));
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("HTFPOICredit: priceAtZone + both FVG and OB layers → boost 1.5 (0.8+0.7)", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ priceAtZone: true, htfLayers: ["4H_FVG", "4H_OB"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, true);
  assertEquals(htfFactor.weight, 1.5);
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("HTFPOICredit: boost capped at 2.0 even with many layers", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  // Multiple FVG and OB layers — boost should still cap at 2.0
  const izData = makeIzData({ priceAtZone: true, htfLayers: ["4H_FVG", "4H_OB", "1H_FVG", "1H_OB"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, true);
  // 0.8 (fvg) + 0.7 (ob) = 1.5, capped at 2.0 — still 1.5 since it's under cap
  assertEquals(htfFactor.weight, 1.5);
});

Deno.test("HTFPOICredit: priceAtZone=false → NO credit (price not at zone)", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ priceAtZone: false, htfLayers: ["4H_FVG"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, false);
  assertEquals(htfFactor.weight, 0);
  assertEquals(analysis.tieredScoring!.tier2Count, 2);
});

Deno.test("HTFPOICredit: no OB/FVG in HTF layers (only breaker/fib) → NO credit", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData = makeIzData({ priceAtZone: true, htfLayers: ["4H_BREAKER", "HTF_FIB_61.8", "PD_ALIGNED"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, false);
  assertEquals(htfFactor.weight, 0);
  assertEquals(analysis.tieredScoring!.tier2Count, 2);
});

Deno.test("HTFPOICredit: HTF POI Alignment already present → NO duplicate credit", () => {
  const analysis = makeAnalysis({
    tier2Count: 3,
    factors: [
      { name: "Market Structure", present: true, weight: 1.5, detail: "BOS", tier: 1 },
      { name: "Order Block", present: true, weight: 1.0, detail: "OB", tier: 1 },
      { name: "Premium/Discount & Fib", present: false, weight: 0, detail: "None", tier: 1 },
      { name: "Confluence Stack", present: false, weight: 0, detail: "None", tier: 2 },
      { name: "HTF POI Alignment", present: true, weight: 1.2, detail: "Already aligned", tier: 2 },
    ],
  });
  const izData = makeIzData({ priceAtZone: true, htfLayers: ["4H_FVG"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.weight, 1.2); // Original weight preserved
  assert(!htfFactor.detail.includes("IMPULSE-ZONE CREDIT"));
  assertEquals(analysis.tieredScoring!.tier2Count, 3);
});

Deno.test("HTFPOICredit: null bestZone → no crash, no credit", () => {
  const analysis = makeAnalysis({ tier2Count: 2 });
  const izData: IzData = { hasZone: false, bestZone: null, allZonesCount: 0 };

  applyHTFPOIAlignmentCredit(analysis, izData);

  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, false);
  assertEquals(analysis.tieredScoring!.tier2Count, 2);
});

Deno.test("HTFPOICredit: null tieredScoring → no crash", () => {
  const analysis: Analysis = { tieredScoring: null, factors: [], score: 50, direction: "long" };
  const izData = makeIzData({ priceAtZone: true, htfLayers: ["4H_FVG"] });

  applyHTFPOIAlignmentCredit(analysis, izData);

  assertEquals(analysis.tieredScoring, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION / COMBINED TESTS
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Combined: all 3 credits fire together on a rich zone", () => {
  const analysis = makeAnalysis({ tier1Count: 2, tier2Count: 2 });
  const izData = makeIzData({
    fibDepth: 0.618,
    srConfirmed: true,
    htfLayers: ["4H_OB", "4H_FVG"],
    priceAtZone: true,
  });

  applyPDFibCredit(analysis, izData);
  applyConfluenceStackCredit(analysis, izData);
  applyHTFPOIAlignmentCredit(analysis, izData);

  // P/D credited → tier1Count goes 2→3
  assertEquals(analysis.tieredScoring!.tier1Count, 3);
  assertEquals(analysis.tieredScoring!.tier1GatePassed, true);

  // Confluence Stack credited → tier2Count goes 2→3
  // HTF POI Alignment credited → tier2Count goes 3→4
  assertEquals(analysis.tieredScoring!.tier2Count, 4);

  // Verify all factors are now present
  const pdFactor = analysis.factors.find(f => f.name === "Premium/Discount & Fib")!;
  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(pdFactor.present, true);
  assertEquals(stackFactor.present, true);
  assertEquals(htfFactor.present, true);
});

Deno.test("Combined: P/D fires but Stack doesn't (only 1 layer)", () => {
  const analysis = makeAnalysis({ tier1Count: 2, tier2Count: 2 });
  const izData = makeIzData({
    fibDepth: 0.618,
    srConfirmed: false,
    htfLayers: ["4H_OB"],
    priceAtZone: true,
  });

  applyPDFibCredit(analysis, izData);
  applyConfluenceStackCredit(analysis, izData);
  applyHTFPOIAlignmentCredit(analysis, izData);

  // P/D credited
  assertEquals(analysis.tieredScoring!.tier1Count, 3);
  assertEquals(analysis.tieredScoring!.tier1GatePassed, true);

  // Stack NOT credited (only 1 layer: 4H_OB without srConfirmed)
  const stackFactor = analysis.factors.find(f => f.name === "Confluence Stack")!;
  assertEquals(stackFactor.present, false);

  // HTF POI credited (has OB layer + priceAtZone)
  const htfFactor = analysis.factors.find(f => f.name === "HTF POI Alignment")!;
  assertEquals(htfFactor.present, true);
  assertEquals(analysis.tieredScoring!.tier2Count, 3); // Only +1 from HTF POI
});

Deno.test("Regression: identical inputs produce identical outputs across runs", () => {
  const makeScenario = () => {
    const analysis = makeAnalysis({ tier1Count: 2, tier2Count: 2 });
    const izData = makeIzData({
      fibDepth: 0.618,
      srConfirmed: true,
      htfLayers: ["4H_OB", "4H_FVG"],
      priceAtZone: true,
    });
    applyPDFibCredit(analysis, izData);
    applyConfluenceStackCredit(analysis, izData);
    applyHTFPOIAlignmentCredit(analysis, izData);
    return analysis;
  };

  const run1 = makeScenario();
  const run2 = makeScenario();

  assertEquals(run1.tieredScoring!.tier1Count, run2.tieredScoring!.tier1Count);
  assertEquals(run1.tieredScoring!.tier2Count, run2.tieredScoring!.tier2Count);
  assertEquals(run1.tieredScoring!.tier1GatePassed, run2.tieredScoring!.tier1GatePassed);
  assertEquals(run1.tieredScoring!.tier1GateReason, run2.tieredScoring!.tier1GateReason);
});
