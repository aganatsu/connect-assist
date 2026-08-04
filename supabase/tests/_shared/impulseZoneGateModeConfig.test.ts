/**
 * Test: impulseZoneGateMode config resolution
 * Verifies that strategy.impulseZoneGateMode is correctly resolved from config
 * and that the default is "hard" when not specified.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Simulate the config resolution logic from configMapper.ts
const RUNTIME_DEFAULTS = {
  impulseZoneGateMode: "hard" as "hard" | "soft" | "off",
};

function resolveImpulseZoneGateMode(
  strategy: Record<string, any>,
  raw: Record<string, any>
): "hard" | "soft" | "off" {
  return (strategy.impulseZoneGateMode ?? raw.impulseZoneGateMode ?? RUNTIME_DEFAULTS.impulseZoneGateMode) as "hard" | "soft" | "off";
}

Deno.test("impulseZoneGateMode defaults to 'hard' when not set", () => {
  const result = resolveImpulseZoneGateMode({}, {});
  assertEquals(result, "hard");
});

Deno.test("impulseZoneGateMode reads from strategy when set", () => {
  const result = resolveImpulseZoneGateMode({ impulseZoneGateMode: "soft" }, {});
  assertEquals(result, "soft");
});

Deno.test("impulseZoneGateMode reads from raw when strategy not set", () => {
  const result = resolveImpulseZoneGateMode({}, { impulseZoneGateMode: "off" });
  assertEquals(result, "off");
});

Deno.test("impulseZoneGateMode strategy takes priority over raw", () => {
  const result = resolveImpulseZoneGateMode(
    { impulseZoneGateMode: "soft" },
    { impulseZoneGateMode: "off" }
  );
  assertEquals(result, "soft");
});

Deno.test("impulseZoneGateMode accepts all valid values", () => {
  assertEquals(resolveImpulseZoneGateMode({ impulseZoneGateMode: "hard" }, {}), "hard");
  assertEquals(resolveImpulseZoneGateMode({ impulseZoneGateMode: "soft" }, {}), "soft");
  assertEquals(resolveImpulseZoneGateMode({ impulseZoneGateMode: "off" }, {}), "off");
});

// Test that the UI field name matches what configMapper reads from
Deno.test("UI writes to strategy.impulseZoneGateMode which configMapper reads", () => {
  // Simulate what updateField('strategy', 'impulseZoneGateMode', 'soft') produces
  const configFromUI = {
    strategy: { impulseZoneGateMode: "soft" },
  };
  // configMapper reads strategy.impulseZoneGateMode
  const resolved = resolveImpulseZoneGateMode(configFromUI.strategy, {});
  assertEquals(resolved, "soft");
});
