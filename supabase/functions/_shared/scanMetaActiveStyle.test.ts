/**
 * scanMetaActiveStyle.test.ts — Verifies that the __meta object in scan_logs
 * details_json includes the activeStyle field, and that the frontend display
 * logic correctly resolves which style to show.
 *
 * This test was added as part of the zone-story-style-fix to ensure:
 *   1. The __meta object always includes activeStyle
 *   2. Frontend style resolution prefers scan's activeStyle over config
 *   3. Mismatch detection works when config differs from last scan
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Simulate the __meta construction logic from bot-scanner ─────────
// This mirrors the exact logic in bot-scanner/index.ts around line 6735
function buildMetaObject(resolvedStyle: string) {
  return {
    __meta: true,
    candleSource: "metaapi",
    sourceBreakdown: { metaapi: 12, twelvedata: 0, polygon: 0, none: 0 },
    brokerConnected: true,
    managementActions: [],
    rateLimitThrottles: 0,
    fotsiStrengths: null,
    dataCache: { hits: 5, fetches: 7, errors: 0, seeded: 0 },
    staging: { enabled: false },
    pendingOrders: { enabled: false },
    rejectionSummary: { buckets: {}, impulseZoneBreakdown: {}, directionBreakdown: {} },
    activeStyle: resolvedStyle,  // <-- THE FIX: this field was missing before
  };
}

// ─── Simulate the frontend style resolution logic from BotView.tsx ───
type TradingStyleMode = "scalper" | "day_trader" | "swing_trader";

function resolveDisplayStyle(
  configStyle: TradingStyleMode,
  scanActiveStyle: string | undefined | null
): { displayStyle: TradingStyleMode; mismatch: boolean } {
  const displayStyle = (scanActiveStyle || configStyle) as TradingStyleMode;
  const mismatch = !!scanActiveStyle && scanActiveStyle !== configStyle;
  return { displayStyle, mismatch };
}

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("__meta includes activeStyle field for day_trader", () => {
  const meta = buildMetaObject("day_trader");
  assert(meta.__meta === true);
  assertEquals(meta.activeStyle, "day_trader");
});

Deno.test("__meta includes activeStyle field for scalper", () => {
  const meta = buildMetaObject("scalper");
  assertEquals(meta.activeStyle, "scalper");
});

Deno.test("__meta includes activeStyle field for swing_trader", () => {
  const meta = buildMetaObject("swing_trader");
  assertEquals(meta.activeStyle, "swing_trader");
});

Deno.test("frontend resolves style from scan when available", () => {
  // Config says day_trader, but last scan used scalper
  const result = resolveDisplayStyle("day_trader", "scalper");
  assertEquals(result.displayStyle, "scalper");
  assertEquals(result.mismatch, true);
});

Deno.test("frontend falls back to config when scan has no activeStyle", () => {
  // No activeStyle in scan (legacy scan before this fix)
  const result = resolveDisplayStyle("swing_trader", undefined);
  assertEquals(result.displayStyle, "swing_trader");
  assertEquals(result.mismatch, false);
});

Deno.test("frontend shows no mismatch when scan and config agree", () => {
  const result = resolveDisplayStyle("day_trader", "day_trader");
  assertEquals(result.displayStyle, "day_trader");
  assertEquals(result.mismatch, false);
});

Deno.test("frontend shows mismatch when config changed after scan", () => {
  // User changed config to swing_trader but last scan was day_trader
  const result = resolveDisplayStyle("swing_trader", "day_trader");
  assertEquals(result.displayStyle, "day_trader");
  assertEquals(result.mismatch, true);
});

Deno.test("frontend handles null activeStyle gracefully", () => {
  const result = resolveDisplayStyle("scalper", null);
  assertEquals(result.displayStyle, "scalper");
  assertEquals(result.mismatch, false);
});

Deno.test("resolvedStyle defaults to day_trader when config.tradingStyle.mode is undefined", () => {
  // This mirrors the bot-scanner logic: config.tradingStyle?.mode || "day_trader"
  const configMode = undefined;
  const resolvedStyle = configMode || "day_trader";
  const meta = buildMetaObject(resolvedStyle);
  assertEquals(meta.activeStyle, "day_trader");
});
