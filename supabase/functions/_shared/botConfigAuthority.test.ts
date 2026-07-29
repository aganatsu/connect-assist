/**
 * Phase 2 regression: the live scanner must not own a second config mapper or
 * a second runtime-default object. Both belong to configMapper.ts.
 */

import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./configMapper.ts";
import { applyTradingStyleProfile } from "./tradingStyleConfig.ts";

const scannerSource = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);

Deno.test("bot-scanner has no local runtime-default object", () => {
  assertFalse(
    /const\s+DEFAULTS\s*=\s*\{/.test(scannerSource),
    "Runtime defaults must only be declared in _shared/configMapper.ts",
  );
  assert(
    scannerSource.includes('from "../_shared/tradingStyleConfig.ts"'),
    "Scanner must import the shared trading-style authority",
  );
});

Deno.test("bot-scanner has no legacy config mapper", () => {
  assertFalse(
    scannerSource.includes("_legacyLoadConfigMapping"),
    "Dead mapping logic can drift from the canonical mapper",
  );
  assertFalse(
    scannerSource.includes("LEGACY loadConfig body"),
    "Legacy mapping reference block must stay removed",
  );
});

Deno.test("bot-scanner loadConfig delegates to the canonical mapper", () => {
  const loadConfigBlock = scannerSource.match(
    /async function loadConfig[\s\S]*?(?=\n\/\/ ─── Safety Gates)/,
  );
  assert(loadConfigBlock, "Could not locate bot-scanner loadConfig");
  assertEquals(
    (loadConfigBlock[0].match(/mapNestedToFlat\(/g) ?? []).length,
    1,
  );
  assert(
    loadConfigBlock[0].includes(
      "return mapNestedToFlat(data?.config_json || null);",
    ),
  );
});

Deno.test("canonical mapper owns the effective empty-config defaults", () => {
  const resolved = mapNestedToFlat(null);
  assertEquals(resolved.minConfluence, RUNTIME_DEFAULTS.minConfluence);
  assertEquals(resolved.riskPerTrade, RUNTIME_DEFAULTS.riskPerTrade);
  assertEquals(
    resolved.partialTPEnabled,
    RUNTIME_DEFAULTS.partialTPEnabled,
  );
  assertEquals(resolved.tradingStyle, RUNTIME_DEFAULTS.tradingStyle);
});

Deno.test("scanner preserves the historical partial-TP style sentinel", () => {
  const resolved = applyTradingStyleProfile(
    mapNestedToFlat(null),
    "day_trader",
  );
  assertFalse(
    resolved.config.partialTPEnabled,
    "Removing duplicate defaults must not silently enable partial TP",
  );
});
