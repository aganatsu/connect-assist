/**
 * standaloneSweepGate.test.ts — Regression tests for the standalone sweep gate.
 *
 * Verifies that when requireLiquiditySweep is ON and the signal source is "standalone",
 * the bot blocks entry if the unified zone engine detected unswept liquidity pools
 * near the zone.
 *
 * This test extracts the gate logic into a pure function and tests it in isolation,
 * since the full bot-scanner requires Supabase/network dependencies.
 *
 * Run: deno test --allow-all supabase/functions/bot-scanner/standaloneSweepGate.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ── Extract the standalone sweep gate logic as a pure function ──
// This mirrors the exact conditions from bot-scanner/index.ts lines 5041-5110
interface LiquidityData {
  liquidityScore: number;
  summary: string | null;
  nearbyPools: number;
  sweepEvent: {
    level: number;
    type: string;
    rejected: boolean;
  } | null;
}

interface StandaloneSweepGateInput {
  requireLiquiditySweep: boolean;
  unifiedGatePassed: boolean;
  liquidity: LiquidityData | null;
}

interface StandaloneSweepGateResult {
  blocked: boolean;
  reason: string | null;
}

/**
 * Pure logic extracted from bot-scanner — determines if standalone entry should be blocked.
 */
function evaluateStandaloneSweepGate(input: StandaloneSweepGateInput): StandaloneSweepGateResult {
  if (!input.requireLiquiditySweep || input.unifiedGatePassed || !input.liquidity) {
    return { blocked: false, reason: null };
  }

  const liq = input.liquidity;
  const hasSweepEvent = liq.sweepEvent !== null;
  const sweepRejected = liq.sweepEvent?.rejected === true;

  // Block if: pools exist near zone AND (no sweep occurred OR sweep was absorbed)
  if (liq.nearbyPools > 0 && (!hasSweepEvent || !sweepRejected)) {
    return {
      blocked: true,
      reason: `Standalone Sweep Gate: unswept inducement detected (${liq.summary || liq.nearbyPools + " pool(s)"}) — waiting for BSL/SSL sweep before entry`,
    };
  }

  return { blocked: false, reason: null };
}

// ─── Test 1: USD/JPY scenario — unswept inducement blocks standalone entry ───
// This is the EXACT bug scenario: unified engine found inducement (minor_swing, quality 9/10)
// but state was "hunting_confirmation" not "waiting_for_sweep", so standalone fired.
// With the fix: standalone sweep gate catches it.
Deno.test("BUG FIX: Unswept inducement near zone blocks standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      liquidityScore: 1.0,
      summary: "Inducement: minor_swing (quality 9/10)",
      nearbyPools: 1,
      sweepEvent: null, // No sweep happened — pool is still live
    },
  });

  assertEquals(result.blocked, true, "Should block standalone entry when unswept inducement exists");
  assertEquals(result.reason?.includes("unswept inducement"), true, "Reason should mention unswept inducement");
});

// ─── Test 2: Swept + rejected pool allows entry ───
// If the pool was swept AND price rejected (bounced), the inducement is consumed — allow entry.
Deno.test("Swept + rejected pool allows standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      liquidityScore: 2.0,
      summary: "SSL swept and rejected",
      nearbyPools: 1,
      sweepEvent: {
        level: 1.0950,
        type: "ssl",
        rejected: true, // Swept AND rejected — inducement consumed
      },
    },
  });

  assertEquals(result.blocked, false, "Should allow entry when pool was swept and rejected");
});

// ─── Test 3: Swept but absorbed (broken through) blocks entry ───
// Pool was swept but NOT rejected — price broke through. Zone may be invalidated.
Deno.test("Swept but absorbed (not rejected) blocks standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      liquidityScore: 1.0,
      summary: "SSL swept but absorbed",
      nearbyPools: 1,
      sweepEvent: {
        level: 1.0950,
        type: "ssl",
        rejected: false, // Swept but NOT rejected — absorbed
      },
    },
  });

  assertEquals(result.blocked, true, "Should block when sweep was absorbed (not rejected)");
});

// ─── Test 4: requireLiquiditySweep OFF — no blocking ───
// When the toggle is OFF, standalone entries proceed regardless of inducement.
Deno.test("requireLiquiditySweep OFF allows standalone entry regardless", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: false,
    unifiedGatePassed: false,
    liquidity: {
      liquidityScore: 1.0,
      summary: "Inducement: minor_swing (quality 9/10)",
      nearbyPools: 1,
      sweepEvent: null,
    },
  });

  assertEquals(result.blocked, false, "Should NOT block when requireLiquiditySweep is OFF");
});

// ─── Test 5: Unified gate passed — no blocking (already has its own sweep logic) ───
Deno.test("Unified gate passed bypasses standalone sweep gate", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: true, // Unified story complete — full conviction
    liquidity: {
      liquidityScore: 1.0,
      summary: "Inducement: minor_swing (quality 9/10)",
      nearbyPools: 1,
      sweepEvent: null,
    },
  });

  assertEquals(result.blocked, false, "Should NOT block when unified gate already passed");
});

// ─── Test 6: No liquidity data — no blocking ───
// If the unified engine didn't return liquidity info, can't block.
Deno.test("No liquidity data allows standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: null,
  });

  assertEquals(result.blocked, false, "Should NOT block when no liquidity data available");
});

// ─── Test 7: Zero nearby pools — no blocking ───
// Liquidity data exists but no pools near the zone.
Deno.test("Zero nearby pools allows standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      liquidityScore: 0,
      summary: null,
      nearbyPools: 0,
      sweepEvent: null,
    },
  });

  assertEquals(result.blocked, false, "Should NOT block when there are no nearby pools");
});

// ─── Test 8: Multiple unswept pools — blocks entry ───
Deno.test("Multiple unswept pools blocks standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      liquidityScore: 3.0,
      summary: "2 SSL pools below zone",
      nearbyPools: 2,
      sweepEvent: null,
    },
  });

  assertEquals(result.blocked, true, "Should block when multiple unswept pools exist");
  assertEquals(result.reason?.includes("2 SSL pools below zone"), true, "Reason should include pool summary");
});
