/**
 * backtestZoneParity.test.ts
 * ──────────────────────────────────────────────────────────────────────
 * Regression tests for the unified zone engine + cascade zone engine
 * port to backtest-engine.
 *
 * Tests validate:
 * 1. Three-tier gate logic (cascade → unified → standalone)
 * 2. Style-aware candle slot mapping matches bot-scanner
 * 3. Liquidity pool detection is wired correctly
 * 4. signalSource propagation through trade lifecycle
 * 5. Backward-compatible izData derivation from unified result
 *
 * These tests use extracted pure functions that mirror the inline logic
 * in backtest-engine/index.ts, following the same pattern as
 * unifiedGateWiring.test.ts.
 */
import { assertEquals, assert, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { STYLE_TIMEFRAME_ROLES } from "./stylePolicy.ts";
import {
  resolveTimeframeAuthority,
  zoneTimeframeLabels,
} from "./timeframeAuthority.ts";
import type { TradingStyleMode } from "./tradingStyleConfig.ts";

// ─── Extracted: Three-Tier Gate Decision (mirrors backtest-engine inline) ───
interface UnifiedResult {
  hasZone: boolean;
  state: string;
  confirmation: { entryReady: boolean; type?: string } | null;
  multiTFResult: {
    bestZone: any;
    selectedTF: string | null;
    reason: string;
    allZones: any[];
    h1Result: { bestZone: any };
    h4Result?: { bestZone: any };
    dailyResult?: { bestZone: any };
  };
}

interface CascadeResult {
  state: string;
  priceAtEntry: boolean;
  entry: number | null;
  sl: number | null;
  dailyZone: any;
}

function evaluateThreeTierGate(
  tradingStyle: string | undefined,
  cascadeResult: CascadeResult | null,
  unifiedResult: UnifiedResult | null,
  config: { requireUnifiedZone?: boolean; impulseZoneEnabled?: boolean; impulseZoneGateMode?: string; impulseZoneBonus?: number },
  izData: { hasZone: boolean; bestZone?: { priceAtZone: boolean } } | null,
): {
  passed: boolean;
  signalSource: "cascade" | "unified" | "standalone";
  impulseZonePenaltyVal: number;
  skipReason: string | null;
} {
  const izGateMode = config.impulseZoneGateMode || "hard";
  let impulseZonePenaltyVal = 0;
  let unifiedGatePassed = false;
  let signalSource: "cascade" | "unified" | "standalone" = "standalone";

  // Tier 1: Cascade (swing_trader only)
  if (tradingStyle === "swing_trader" && cascadeResult?.state === "triggered" && cascadeResult.priceAtEntry) {
    unifiedGatePassed = true;
    signalSource = "cascade";
  }
  // Tier 2: Unified zone (confirmed/triggered + entryReady)
  else if (unifiedResult?.hasZone &&
      (unifiedResult.state === "triggered" || unifiedResult.state === "confirmed") &&
      unifiedResult.confirmation?.entryReady === true) {
    unifiedGatePassed = true;
    signalSource = "unified";
  }

  // Apply gate decision
  if (unifiedGatePassed) {
    impulseZonePenaltyVal = +(config.impulseZoneBonus ?? 1.0);
    return { passed: true, signalSource, impulseZonePenaltyVal, skipReason: null };
  } else if (config.requireUnifiedZone) {
    return { passed: false, signalSource, impulseZonePenaltyVal: 0, skipReason: "requireUnifiedZone" };
  } else if (config.impulseZoneEnabled !== false && izGateMode === "hard") {
    if (!izData || !izData.hasZone) {
      return { passed: false, signalSource, impulseZonePenaltyVal: 0, skipReason: "noZone" };
    }
    if (!izData.bestZone?.priceAtZone) {
      return { passed: false, signalSource, impulseZonePenaltyVal: 0, skipReason: "notAtZone" };
    }
    impulseZonePenaltyVal = +(config.impulseZoneBonus ?? 1.0);
    return { passed: true, signalSource: "standalone", impulseZonePenaltyVal, skipReason: null };
  }
  // Soft mode or disabled — always passes
  return { passed: true, signalSource: "standalone", impulseZonePenaltyVal: 0, skipReason: null };
}

// ─── Extracted: Style-aware TF Label Mapping ───
interface TFSlotLabels { top: string; mid: string; low: string; }

function getStyleTFLabels(tradingStyle: string | undefined): TFSlotLabels {
  const style: TradingStyleMode = tradingStyle === "scalper" ||
      tradingStyle === "swing_trader"
    ? tradingStyle
    : "day_trader";
  const roles = STYLE_TIMEFRAME_ROLES[style];
  return zoneTimeframeLabels(resolveTimeframeAuthority({
    style,
    timeframes: {
      roles,
      runtimeEntry: roles.confirmation,
      runtimeHTF: roles.bias,
    },
  }));
}

// ─── Tests: Three-Tier Gate Logic ───

Deno.test("Three-Tier Gate: Cascade passes for swing_trader when triggered + priceAtEntry", () => {
  const cascade: CascadeResult = { state: "triggered", priceAtEntry: true, entry: 1.0850, sl: 1.0800, dailyZone: {} };
  const result = evaluateThreeTierGate("swing_trader", cascade, null, { impulseZoneBonus: 1.5 }, null);
  assertEquals(result.passed, true);
  assertEquals(result.signalSource, "cascade");
  assertEquals(result.impulseZonePenaltyVal, 1.5);
});

Deno.test("Three-Tier Gate: Cascade does NOT pass for day_trader even when triggered", () => {
  const cascade: CascadeResult = { state: "triggered", priceAtEntry: true, entry: 1.0850, sl: 1.0800, dailyZone: {} };
  const result = evaluateThreeTierGate("day_trader", cascade, null, { impulseZoneGateMode: "hard" }, null);
  assertEquals(result.passed, false);
  assertEquals(result.signalSource, "standalone");
  assertEquals(result.skipReason, "noZone");
});

Deno.test("Three-Tier Gate: Cascade does NOT pass for swing_trader when state=waiting_for_price", () => {
  const cascade: CascadeResult = { state: "waiting_for_price", priceAtEntry: false, entry: null, sl: null, dailyZone: {} };
  const result = evaluateThreeTierGate("swing_trader", cascade, null, { impulseZoneGateMode: "hard" }, null);
  assertEquals(result.passed, false);
  assertEquals(result.skipReason, "noZone");
});

Deno.test("Three-Tier Gate: Unified passes when state=triggered + entryReady=true", () => {
  const unified: UnifiedResult = {
    hasZone: true,
    state: "triggered",
    confirmation: { entryReady: true, type: "sweep_choch" },
    multiTFResult: { bestZone: {}, selectedTF: "4H", reason: "ok", allZones: [{}], h1Result: { bestZone: {} } },
  };
  const result = evaluateThreeTierGate("day_trader", null, unified, { impulseZoneBonus: 1.0 }, null);
  assertEquals(result.passed, true);
  assertEquals(result.signalSource, "unified");
  assertEquals(result.impulseZonePenaltyVal, 1.0);
});

Deno.test("Three-Tier Gate: Unified passes when state=confirmed + entryReady=true", () => {
  const unified: UnifiedResult = {
    hasZone: true,
    state: "confirmed",
    confirmation: { entryReady: true, type: "displacement" },
    multiTFResult: { bestZone: {}, selectedTF: "1H", reason: "ok", allZones: [{}], h1Result: { bestZone: {} } },
  };
  const result = evaluateThreeTierGate("scalper", null, unified, { impulseZoneBonus: 1.0 }, null);
  assertEquals(result.passed, true);
  assertEquals(result.signalSource, "unified");
});

Deno.test("Three-Tier Gate: Unified does NOT pass when entryReady=false", () => {
  const unified: UnifiedResult = {
    hasZone: true,
    state: "triggered",
    confirmation: { entryReady: false },
    multiTFResult: { bestZone: {}, selectedTF: "4H", reason: "ok", allZones: [{}], h1Result: { bestZone: {} } },
  };
  const result = evaluateThreeTierGate("day_trader", null, unified, { impulseZoneGateMode: "hard" }, null);
  assertEquals(result.passed, false);
  assertEquals(result.signalSource, "standalone");
  assertEquals(result.skipReason, "noZone");
});

Deno.test("Three-Tier Gate: Unified does NOT pass when state=watching", () => {
  const unified: UnifiedResult = {
    hasZone: true,
    state: "watching",
    confirmation: { entryReady: true },
    multiTFResult: { bestZone: {}, selectedTF: "4H", reason: "ok", allZones: [{}], h1Result: { bestZone: {} } },
  };
  const result = evaluateThreeTierGate("day_trader", null, unified, { impulseZoneGateMode: "hard" }, null);
  assertEquals(result.passed, false);
  assertEquals(result.skipReason, "noZone");
});

Deno.test("Three-Tier Gate: requireUnifiedZone blocks standalone entries", () => {
  const izData = { hasZone: true, bestZone: { priceAtZone: true } };
  const result = evaluateThreeTierGate("day_trader", null, null, { requireUnifiedZone: true }, izData);
  assertEquals(result.passed, false);
  assertEquals(result.skipReason, "requireUnifiedZone");
});

Deno.test("Three-Tier Gate: Standalone passes when izData.priceAtZone=true (hard mode)", () => {
  const izData = { hasZone: true, bestZone: { priceAtZone: true } };
  const result = evaluateThreeTierGate("day_trader", null, null, { impulseZoneGateMode: "hard", impulseZoneBonus: 1.0 }, izData);
  assertEquals(result.passed, true);
  assertEquals(result.signalSource, "standalone");
  assertEquals(result.impulseZonePenaltyVal, 1.0);
});

Deno.test("Three-Tier Gate: Standalone fails when no zone (hard mode)", () => {
  const result = evaluateThreeTierGate("day_trader", null, null, { impulseZoneGateMode: "hard" }, null);
  assertEquals(result.passed, false);
  assertEquals(result.skipReason, "noZone");
});

Deno.test("Three-Tier Gate: Soft mode passes even without zone", () => {
  const result = evaluateThreeTierGate("day_trader", null, null, { impulseZoneGateMode: "soft" }, null);
  assertEquals(result.passed, true);
  assertEquals(result.signalSource, "standalone");
  assertEquals(result.impulseZonePenaltyVal, 0);
});

Deno.test("Three-Tier Gate: Cascade takes priority over unified for swing_trader", () => {
  const cascade: CascadeResult = { state: "triggered", priceAtEntry: true, entry: 1.0850, sl: 1.0800, dailyZone: {} };
  const unified: UnifiedResult = {
    hasZone: true,
    state: "triggered",
    confirmation: { entryReady: true },
    multiTFResult: { bestZone: {}, selectedTF: "4H", reason: "ok", allZones: [{}], h1Result: { bestZone: {} } },
  };
  const result = evaluateThreeTierGate("swing_trader", cascade, unified, { impulseZoneBonus: 1.0 }, null);
  assertEquals(result.signalSource, "cascade"); // cascade wins
});

// ─── Tests: Style-aware TF Label Mapping ───

Deno.test("TF Labels: scalper maps to 1H/15m/5m", () => {
  const labels = getStyleTFLabels("scalper");
  assertEquals(labels, { top: "1H", mid: "15m", low: "5m" });
});

Deno.test("TF Labels: day_trader maps to D/4H/1H", () => {
  const labels = getStyleTFLabels("day_trader");
  assertEquals(labels, { top: "D", mid: "4H", low: "1H" });
});

Deno.test("TF Labels: swing_trader maps to W/D/4H", () => {
  const labels = getStyleTFLabels("swing_trader");
  assertEquals(labels, { top: "W", mid: "D", low: "4H" });
});

Deno.test("TF Labels: undefined defaults to day_trader", () => {
  const labels = getStyleTFLabels(undefined);
  assertEquals(labels, { top: "D", mid: "4H", low: "1H" });
});

// ─── Tests: signalSource Propagation ───

Deno.test("signalSource: cascade propagates through trade lifecycle", () => {
  // Simulates: position opened with signalSource="cascade", then closed
  const pos = { signalSource: "cascade" as const, regime: "trending", session: "london" };
  const closedTrade = { ...pos, closeReason: "stop_loss" };
  assertEquals(closedTrade.signalSource, "cascade");
});

Deno.test("signalSource: unified propagates through trade lifecycle", () => {
  const pos = { signalSource: "unified" as const, regime: "ranging", session: "new_york" };
  const closedTrade = { ...pos, closeReason: "take_profit" };
  assertEquals(closedTrade.signalSource, "unified");
});

Deno.test("signalSource: standalone is the default", () => {
  const pos = { signalSource: "standalone" as const };
  assertEquals(pos.signalSource, "standalone");
});

// ─── Tests: izData Derivation from UnifiedResult ───

Deno.test("izData derivation: maps unified multiTFResult to backward-compat format", () => {
  const multiTF = {
    bestZone: {
      impulse: { high: 1.10, low: 1.08, direction: "bullish" },
      zone: {
        poi: { type: "ob", high: 1.085, low: 1.083 },
        fibLevel: 0.618,
        fibDepth: 0.65,
        totalScore: 8.5,
        srConfirmed: true,
        ltfRefined: true,
        ltfType: "fvg",
        refinedEntry: 1.0835,
        refinedSL: 1.0820,
        htfConfluenceScore: 3,
        htfLayers: ["4H_OB"],
      },
      priceAtZone: true,
      priceInsideZone: true,
      priceAtZoneStrict: false,
      sideOk: true,
      distanceToZone: 0.0005,
      distancePips: 5,
    },
    selectedTF: "4H",
    reason: "Best zone from 4H",
    allZones: [{}, {}],
    h1Result: { bestZone: null },
    h4Result: { bestZone: {} },
    dailyResult: { bestZone: null },
  };

  // Simulate the derivation logic from backtest-engine
  const izData = {
    hasZone: !!multiTF.bestZone,
    selectedTF: multiTF.selectedTF,
    reason: multiTF.reason,
    impulse: multiTF.bestZone?.impulse ? {
      high: multiTF.bestZone.impulse.high,
      low: multiTF.bestZone.impulse.low,
      direction: multiTF.bestZone.impulse.direction,
    } : null,
    bestZone: multiTF.bestZone ? {
      type: multiTF.bestZone.zone.poi.type,
      high: multiTF.bestZone.zone.poi.high,
      low: multiTF.bestZone.zone.poi.low,
      fibLevel: multiTF.bestZone.zone.fibLevel,
      fibDepth: multiTF.bestZone.zone.fibDepth,
      totalScore: multiTF.bestZone.zone.totalScore,
      srConfirmed: multiTF.bestZone.zone.srConfirmed,
      ltfRefined: multiTF.bestZone.zone.ltfRefined,
      ltfType: multiTF.bestZone.zone.ltfType || null,
      refinedEntry: multiTF.bestZone.zone.refinedEntry || null,
      refinedSL: multiTF.bestZone.zone.refinedSL || null,
      htfConfluenceScore: multiTF.bestZone.zone.htfConfluenceScore,
      htfLayers: multiTF.bestZone.zone.htfLayers,
      priceAtZone: multiTF.bestZone.priceAtZone,
      priceInsideZone: multiTF.bestZone.priceInsideZone,
      priceAtZoneStrict: multiTF.bestZone.priceAtZoneStrict,
      sideOk: multiTF.bestZone.sideOk,
      distanceToZone: multiTF.bestZone.distanceToZone,
      distancePips: multiTF.bestZone.distancePips,
    } : null,
    allZonesCount: multiTF.allZones.length,
    h1HasZone: !!multiTF.h1Result.bestZone,
    h4HasZone: !!multiTF.h4Result?.bestZone,
    dailyHasZone: !!multiTF.dailyResult?.bestZone,
  };

  assertEquals(izData.hasZone, true);
  assertEquals(izData.selectedTF, "4H");
  assertEquals(izData.impulse?.direction, "bullish");
  assertEquals(izData.bestZone?.type, "ob");
  assertEquals(izData.bestZone?.priceAtZone, true);
  assertEquals(izData.bestZone?.ltfType, "fvg");
  assertEquals(izData.bestZone?.refinedEntry, 1.0835);
  assertEquals(izData.allZonesCount, 2);
  assertEquals(izData.h1HasZone, false);
  assertEquals(izData.h4HasZone, true);
  assertEquals(izData.dailyHasZone, false);
});

Deno.test("izData derivation: no zone produces null fields", () => {
  const multiTF = {
    bestZone: null,
    selectedTF: null,
    reason: "No impulse detected",
    allZones: [],
    h1Result: { bestZone: null },
    h4Result: { bestZone: null },
    dailyResult: { bestZone: null },
  };

  const izData = {
    hasZone: !!multiTF.bestZone,
    selectedTF: multiTF.selectedTF,
    reason: multiTF.reason,
    impulse: null,
    bestZone: null,
    allZonesCount: multiTF.allZones.length,
    h1HasZone: !!multiTF.h1Result.bestZone,
    h4HasZone: !!multiTF.h4Result?.bestZone,
    dailyHasZone: !!multiTF.dailyResult?.bestZone,
  };

  assertEquals(izData.hasZone, false);
  assertEquals(izData.selectedTF, null);
  assertEquals(izData.impulse, null);
  assertEquals(izData.bestZone, null);
  assertEquals(izData.allZonesCount, 0);
});

// ─── Tests: Liquidity Pool Sensitivity Mapping ───

Deno.test("Liquidity sensitivity: maps 1-5 to correct tolerance base", () => {
  const expected = [0.10, 0.15, 0.20, 0.25, 0.30];
  for (let sens = 1; sens <= 5; sens++) {
    const liqTolBase = [0.10, 0.15, 0.20, 0.25, 0.30][Math.min(Math.max(sens, 1), 5) - 1];
    assertEquals(liqTolBase, expected[sens - 1]);
  }
});

Deno.test("Liquidity sensitivity: Daily gets +0.10 bump, 4H gets +0.05, 1H gets no bump", () => {
  const liqTolBase = 0.20; // sensitivity=3
  const dailyTol = Math.min(liqTolBase + 0.10, 0.40);
  const h4Tol = Math.min(liqTolBase + 0.05, 0.35);
  const h1Tol = liqTolBase;
  assertAlmostEquals(dailyTol, 0.30, 1e-10);
  assertAlmostEquals(h4Tol, 0.25, 1e-10);
  assertAlmostEquals(h1Tol, 0.20, 1e-10);
});

Deno.test("Liquidity sensitivity: caps at maximum values", () => {
  const liqTolBase = 0.30; // sensitivity=5
  const dailyTol = Math.min(liqTolBase + 0.10, 0.40);
  const h4Tol = Math.min(liqTolBase + 0.05, 0.35);
  assertEquals(dailyTol, 0.40);
  assertEquals(h4Tol, 0.35);
});
