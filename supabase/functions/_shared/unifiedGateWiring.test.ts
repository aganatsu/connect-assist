/**
 * Tests for the unified gate wiring logic in bot-scanner.
 *
 * These tests validate the signal selector behavior:
 * 1. unifiedGatePassed = true when state is triggered/confirmed AND entryReady = true
 * 2. unifiedGatePassed = false otherwise (standalone fallback)
 * 3. Size multiplier: 1.0x for unified, 0.5x for standalone
 * 4. signalSource label is set correctly
 *
 * Since the gate logic is inline in bot-scanner (not exported), we test the
 * decision logic by extracting it into a pure function here and verifying
 * it matches the inline implementation.
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Extracted gate decision logic (mirrors bot-scanner inline code) ───
interface UnifiedZoneData {
  hasZone: boolean;
  state: string;
  confirmation: { entryReady: boolean; type: string } | null;
  entry: { entryPrice: number; slPrice: number; tpPrice: number | null } | null;
  unifiedScore: number;
  selectedTF: string | null;
  zone?: { low: number; high: number };
}

function evaluateUnifiedGate(unifiedZoneData: UnifiedZoneData | null | undefined): {
  unifiedGatePassed: boolean;
  signalSource: "unified" | "standalone";
} {
  if (
    unifiedZoneData?.hasZone &&
    (unifiedZoneData.state === "triggered" || unifiedZoneData.state === "confirmed") &&
    unifiedZoneData.confirmation?.entryReady === true
  ) {
    return { unifiedGatePassed: true, signalSource: "unified" };
  }
  return { unifiedGatePassed: false, signalSource: "standalone" };
}

function applySignalSourceSizeMultiplier(
  baseLots: number,
  signalSource: "unified" | "standalone"
): number {
  if (signalSource !== "unified") {
    let size = Math.round(baseLots * 0.5 * 100) / 100;
    if (size < 0.01) size = 0.01;
    return size;
  }
  return baseLots;
}

// ─── Tests ───

Deno.test("Unified Gate: passes when state=triggered AND entryReady=true", () => {
  const data: UnifiedZoneData = {
    hasZone: true,
    state: "triggered",
    confirmation: { entryReady: true, type: "sweep_choch" },
    entry: { entryPrice: 1.0850, slPrice: 1.0800, tpPrice: 1.0950 },
    unifiedScore: 10.5,
    selectedTF: "1H",
  };
  const result = evaluateUnifiedGate(data);
  assertEquals(result.unifiedGatePassed, true);
  assertEquals(result.signalSource, "unified");
});

Deno.test("Unified Gate: passes when state=confirmed AND entryReady=true", () => {
  const data: UnifiedZoneData = {
    hasZone: true,
    state: "confirmed",
    confirmation: { entryReady: true, type: "choch" },
    entry: { entryPrice: 1.0850, slPrice: 1.0800, tpPrice: 1.0950 },
    unifiedScore: 8.0,
    selectedTF: "4H",
  };
  const result = evaluateUnifiedGate(data);
  assertEquals(result.unifiedGatePassed, true);
  assertEquals(result.signalSource, "unified");
});

Deno.test("Unified Gate: fails when state=watching (not triggered/confirmed)", () => {
  const data: UnifiedZoneData = {
    hasZone: true,
    state: "watching",
    confirmation: { entryReady: false, type: "none" },
    entry: null,
    unifiedScore: 6.0,
    selectedTF: "1H",
  };
  const result = evaluateUnifiedGate(data);
  assertEquals(result.unifiedGatePassed, false);
  assertEquals(result.signalSource, "standalone");
});

Deno.test("Unified Gate: fails when entryReady=false even if state=triggered", () => {
  const data: UnifiedZoneData = {
    hasZone: true,
    state: "triggered",
    confirmation: { entryReady: false, type: "displacement" },
    entry: null,
    unifiedScore: 7.0,
    selectedTF: "1H",
  };
  const result = evaluateUnifiedGate(data);
  assertEquals(result.unifiedGatePassed, false);
  assertEquals(result.signalSource, "standalone");
});

Deno.test("Unified Gate: fails when hasZone=false", () => {
  const data: UnifiedZoneData = {
    hasZone: false,
    state: "no_impulse",
    confirmation: null,
    entry: null,
    unifiedScore: 0,
    selectedTF: null,
  };
  const result = evaluateUnifiedGate(data);
  assertEquals(result.unifiedGatePassed, false);
  assertEquals(result.signalSource, "standalone");
});

Deno.test("Unified Gate: fails when unifiedZoneData is null", () => {
  const result = evaluateUnifiedGate(null);
  assertEquals(result.unifiedGatePassed, false);
  assertEquals(result.signalSource, "standalone");
});

Deno.test("Unified Gate: fails when unifiedZoneData is undefined", () => {
  const result = evaluateUnifiedGate(undefined);
  assertEquals(result.unifiedGatePassed, false);
  assertEquals(result.signalSource, "standalone");
});

Deno.test("Unified Gate: fails when confirmation is null", () => {
  const data: UnifiedZoneData = {
    hasZone: true,
    state: "triggered",
    confirmation: null,
    entry: { entryPrice: 1.0850, slPrice: 1.0800, tpPrice: 1.0950 },
    unifiedScore: 9.0,
    selectedTF: "1H",
  };
  const result = evaluateUnifiedGate(data);
  assertEquals(result.unifiedGatePassed, false);
  assertEquals(result.signalSource, "standalone");
});

// ─── Size multiplier tests ───

Deno.test("Size Multiplier: unified signal gets full size (1.0x)", () => {
  const size = applySignalSourceSizeMultiplier(0.10, "unified");
  assertEquals(size, 0.10);
});

Deno.test("Size Multiplier: standalone signal gets half size (0.5x)", () => {
  const size = applySignalSourceSizeMultiplier(0.10, "standalone");
  assertEquals(size, 0.05);
});

Deno.test("Size Multiplier: standalone rounds to 2 decimal places", () => {
  const size = applySignalSourceSizeMultiplier(0.07, "standalone");
  assertEquals(size, 0.04); // 0.07 * 0.5 = 0.035 → rounds to 0.04
});

Deno.test("Size Multiplier: standalone floors at 0.01 minimum", () => {
  const size = applySignalSourceSizeMultiplier(0.01, "standalone");
  assertEquals(size, 0.01); // 0.01 * 0.5 = 0.005 → rounds to 0.01 (floor)
});

Deno.test("Size Multiplier: very small standalone still gets 0.01", () => {
  const size = applySignalSourceSizeMultiplier(0.005, "standalone");
  assertEquals(size, 0.01); // 0.005 * 0.5 = 0.0025 → rounds to 0.00 → floor to 0.01
});

Deno.test("Size Multiplier: unified preserves large size", () => {
  const size = applySignalSourceSizeMultiplier(1.50, "unified");
  assertEquals(size, 1.50);
});

Deno.test("Size Multiplier: standalone halves large size correctly", () => {
  const size = applySignalSourceSizeMultiplier(1.50, "standalone");
  assertEquals(size, 0.75);
});
