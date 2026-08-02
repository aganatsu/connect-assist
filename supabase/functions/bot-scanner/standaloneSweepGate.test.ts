/**
 * standaloneSweepGate.test.ts — Regression tests for the standalone sweep gate.
 *
 * Verifies that when requireLiquiditySweep is ON and the signal source is "standalone",
 * the bot blocks entry if the unified zone engine detected unswept liquidity pools
 * near the zone.
 *
 * The scanner imports the same pure authority evaluated here, so production and
 * tests cannot drift back to the old "any nearby pool blocks" behavior.
 *
 * Run: deno test --allow-all supabase/functions/bot-scanner/standaloneSweepGate.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateStandaloneSweepGate } from "../_shared/standaloneSweepGate.ts";

Deno.test("bot-scanner uses canonical standalone sweep authority, not nearby-pool count", () => {
  const scanner = Deno.readTextFileSync(
    new URL("./index.ts", import.meta.url),
  );
  assertEquals(
    scanner.includes("evaluateStandaloneSweepGate({"),
    true,
  );
  assertEquals(
    scanner.includes("liq.nearbyPools > 0"),
    false,
  );
});

// ─── Test 1: USD/JPY scenario — unswept inducement blocks standalone entry ───
// This is the EXACT bug scenario: unified engine found inducement (minor_swing, quality 9/10)
// but state was "hunting_confirmation" not "waiting_for_sweep", so standalone fired.
// With the fix: standalone sweep gate catches it.
Deno.test("BUG FIX: Unswept inducement near zone blocks standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      summary: "Inducement: minor_swing (quality 9/10)",
      gateReason: "Local SSL inside zone is unswept — sweep required",
      entryTriggerState: "unswept",
      hasUnsweptEntryTrigger: true,
    },
  });

  assertEquals(result.blocked, true, "Should block standalone entry when unswept inducement exists");
  assertEquals(result.status, "waiting_for_sweep");
  assertEquals(result.reason?.includes("Local SSL"), true, "Reason should identify the local trigger");
});

// ─── Test 2: Swept + rejected pool allows entry ───
// If the pool was swept AND price rejected (bounced), the inducement is consumed — allow entry.
Deno.test("Swept + rejected pool allows standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      summary: "SSL swept and rejected",
      gateReason: "Local SSL swept and rejected — confirmation may proceed",
      entryTriggerState: "swept_rejected",
      hasUnsweptEntryTrigger: false,
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
      summary: "SSL swept but absorbed",
      gateReason: "Local SSL swept without rejection — fresh trigger and confirmation required",
      entryTriggerState: "swept_absorbed",
      hasUnsweptEntryTrigger: false,
    },
  });

  assertEquals(result.blocked, true, "Should block when sweep was absorbed (not rejected)");
  assertEquals(result.status, "waiting_for_reconfirmation");
});

// ─── Test 4: requireLiquiditySweep OFF — no blocking ───
// When the toggle is OFF, standalone entries proceed regardless of inducement.
Deno.test("requireLiquiditySweep OFF allows standalone entry regardless", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: false,
    unifiedGatePassed: false,
    liquidity: {
      summary: "Inducement: minor_swing (quality 9/10)",
      gateReason: "Local SSL inside zone is unswept — sweep required",
      entryTriggerState: "unswept",
      hasUnsweptEntryTrigger: true,
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
      summary: "Inducement: minor_swing (quality 9/10)",
      gateReason: "Local SSL inside zone is unswept — sweep required",
      entryTriggerState: "unswept",
      hasUnsweptEntryTrigger: true,
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

// ─── Test 7: Context-only pools — no blocking ───
Deno.test("Context-only nearby pools do not control standalone entry", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      summary: "2 contextual pools",
      gateReason: "2 contextual pool(s); none local enough to gate entry",
      entryTriggerState: "none",
      hasUnsweptEntryTrigger: false,
    },
  });

  assertEquals(result.blocked, false, "Context-only pools must never gate entry");
});

// ─── Test 8: State alone cannot claim an unswept authority ───
Deno.test("Inconsistent unswept state without a qualified trigger fails open", () => {
  const result = evaluateStandaloneSweepGate({
    requireLiquiditySweep: true,
    unifiedGatePassed: false,
    liquidity: {
      summary: "legacy unswept label",
      entryTriggerState: "unswept",
      hasUnsweptEntryTrigger: false,
    },
  });

  assertEquals(result.blocked, false, "Both canonical state and qualified-trigger evidence are required");
});
