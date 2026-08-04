import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compareDealingRangeDecisions,
  evaluateCanonicalDealingRange,
  normalizeDealingRangeMode,
  resolveCanonicalDealingRange,
  readFrozenCanonicalDealingRange,
  selectCanonicalDealingRange,
} from "./canonicalDealingRange.ts";

const parent = {
  impulseId: "impulse-1h",
  timeframe: "1h",
  high: 1.16,
  low: 1.15,
  direction: "bearish",
};
const child = {
  impulseId: "impulse-5m",
  timeframe: "5m",
  high: 1.155,
  low: 1.152,
  direction: "bearish",
};

Deno.test("canonical range prefers and freezes the valid parent impulse", () => {
  const result = selectCanonicalDealingRange({
    parentImpulse: parent,
    childImpulse: child,
    frozenAt: "2026-08-03T12:00:00.000Z",
  });
  assertEquals(result.available, true);
  if (!result.available) return;
  assertEquals(result.reason, "parent_selected");
  assertEquals(result.range.impulseId, "impulse-1h");
  assertEquals(result.range.source, "higher_timeframe_parent");
  assertEquals(result.range.midpoint, 1.155);
  assertEquals(result.range.frozenAt, "2026-08-03T12:00:00.000Z");
});

Deno.test("canonical range resolves the real selected parent impulse from timeframe evidence", () => {
  const result = resolveCanonicalDealingRange({
    slots: [{
      timeframe: "1H",
      impulses: [
        { ...parent, selected: false, impulseId: "older-1h" },
        { ...parent, selected: true },
      ],
    }, {
      timeframe: "5m",
      impulses: [{ ...child, selected: true }],
    }],
    parentTimeframe: "1h",
    childTimeframe: "5m",
    frozenAt: "2026-08-03T12:00:00.000Z",
  });
  assertEquals(result.available, true);
  if (!result.available) return;
  assertEquals(result.reason, "parent_selected");
  assertEquals(result.range.impulseId, "impulse-1h");
  assertEquals(result.range.high, 1.16);
  assertEquals(result.range.low, 1.15);
});

Deno.test("invalid parent falls back explicitly to the valid child impulse", () => {
  const result = selectCanonicalDealingRange({
    parentImpulse: { ...parent, high: null },
    childImpulse: child,
    frozenAt: "2026-08-03T12:00:00.000Z",
  });
  assertEquals(result.available, true);
  if (!result.available) return;
  assertEquals(result.reason, "child_selected_no_valid_parent");
  assertEquals(result.range.impulseId, "impulse-5m");
});

Deno.test("missing valid impulse is unavailable and never invents a rolling range", () => {
  assertEquals(selectCanonicalDealingRange({
    parentImpulse: null,
    childImpulse: { ...child, high: 1.15, low: 1.16 },
    frozenAt: "2026-08-03T12:00:00.000Z",
  }), {
    available: false,
    range: null,
    reason: "no_valid_impulse_range",
  });
});

Deno.test("legacy toggles map to Avoid Wrong Side, never Strict Value", () => {
  assertEquals(normalizeDealingRangeMode(undefined, {
    onlyBuyInDiscount: true,
    onlySellInPremium: true,
  }), "avoid_wrong_side");
  assertEquals(normalizeDealingRangeMode(undefined), "avoid_wrong_side");
  assertEquals(normalizeDealingRangeMode("strict_value"), "strict_value");
  assertEquals(normalizeDealingRangeMode("off"), "off");
});

Deno.test("Avoid Wrong Side rejects a discount short with canonical explanation", () => {
  const selection = selectCanonicalDealingRange({
    parentImpulse: parent,
    frozenAt: "2026-08-03T12:00:00.000Z",
  });
  if (!selection.available) throw new Error("expected range");
  const result = evaluateCanonicalDealingRange({
    range: selection.range,
    direction: "short",
    price: 1.15324,
    mode: "avoid_wrong_side",
  });
  assertEquals(result.allowed, false);
  assertEquals(result.code, "wrong_side");
  assertEquals(result.zone, "discount");
  assertEquals(Number(result.percent?.toFixed(1)), 32.4);
  assertStringIncludes(result.explanation, "Short rejected by 1H canonical bearish impulse range 1.15000-1.16000");
  assertStringIncludes(result.explanation, "Entry 1.15324 is at 32.4%");
  assertStringIncludes(result.explanation, "Avoid Wrong Side requires at least 45%");
});

Deno.test("Avoid Wrong Side allows equilibrium boundaries", () => {
  const selection = selectCanonicalDealingRange({ parentImpulse: parent, frozenAt: "now" });
  if (!selection.available) throw new Error("expected range");
  assertEquals(evaluateCanonicalDealingRange({ range: selection.range, direction: "short", price: 1.1545, mode: "avoid_wrong_side" }).allowed, true);
  assertEquals(evaluateCanonicalDealingRange({ range: selection.range, direction: "long", price: 1.1555, mode: "avoid_wrong_side" }).allowed, true);
});

Deno.test("Strict Value uses exclusive 45 and 55 percent thresholds", () => {
  const selection = selectCanonicalDealingRange({ parentImpulse: parent, frozenAt: "now" });
  if (!selection.available) throw new Error("expected range");
  assertEquals(evaluateCanonicalDealingRange({ range: selection.range, direction: "long", price: 1.1545, mode: "strict_value" }).allowed, false);
  assertEquals(evaluateCanonicalDealingRange({ range: selection.range, direction: "long", price: 1.15449, mode: "strict_value" }).allowed, true);
  assertEquals(evaluateCanonicalDealingRange({ range: selection.range, direction: "short", price: 1.1555, mode: "strict_value" }).allowed, false);
  assertEquals(evaluateCanonicalDealingRange({ range: selection.range, direction: "short", price: 1.15551, mode: "strict_value" }).allowed, true);
});

Deno.test("Off and unavailable observations cannot block", () => {
  const selection = selectCanonicalDealingRange({ parentImpulse: parent, frozenAt: "now" });
  if (!selection.available) throw new Error("expected range");
  assertEquals(evaluateCanonicalDealingRange({ range: selection.range, direction: "short", price: 1.151, mode: "off" }).allowed, true);
  const unavailable = evaluateCanonicalDealingRange({ range: null, direction: "short", price: 1.151, mode: "strict_value" });
  assertEquals(unavailable.available, false);
  assertEquals(unavailable.allowed, true);
});

Deno.test("frozen range reader rejects absent and tampered lifecycle data", () => {
  const selection = selectCanonicalDealingRange({ parentImpulse: parent, frozenAt: "now" });
  if (!selection.available) throw new Error("expected range");
  assertEquals(readFrozenCanonicalDealingRange({ canonicalDealingRange: selection }), selection.range);
  assertEquals(readFrozenCanonicalDealingRange({
    canonicalDealingRange: {
      ...selection,
      range: { ...selection.range, midpoint: 0 },
    },
  }), null);
  assertEquals(readFrozenCanonicalDealingRange(null), null);
});

Deno.test("comparison records disagreement without enforcing it", () => {
  const canonical = evaluateCanonicalDealingRange({ range: null, direction: "long", price: 1.15, mode: "avoid_wrong_side" });
  assertEquals(compareDealingRangeDecisions({ canonical, rollingAllowed: false, rollingPercent: 70 }).decisionsMatch, null);
  const selection = selectCanonicalDealingRange({ parentImpulse: parent, frozenAt: "now" });
  if (!selection.available) throw new Error("expected range");
  const available = evaluateCanonicalDealingRange({ range: selection.range, direction: "short", price: 1.15324, mode: "avoid_wrong_side" });
  const comparison = compareDealingRangeDecisions({ canonical: available, rollingAllowed: true, rollingPercent: 60 });
  assertEquals(comparison.decisionsMatch, false);
  assertEquals(comparison.enforcement, "observe_only");
});
