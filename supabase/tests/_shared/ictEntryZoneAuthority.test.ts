import { assertEquals, assertGreater } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { breakerCloseInvalidated, breakerRetestHeld, evaluateBreakerFillLifecycle, hasOppositeStructureBreak } from "../../functions/_shared/breakerSemantics.ts";
import { selectICTEntryZone, type ICTEntryZoneComponent } from "../../functions/_shared/ictEntryZoneAuthority.ts";
import { classifyZoneCandidateLifecycle } from "../../functions/_shared/zoneCandidateModel.ts";

const fresh = classifyZoneCandidateLifecycle({
  zone: { low: 1.1, high: 1.101, direction: "bullish" },
  candlesAfterFormation: [],
});

function component(id: string, type: ICTEntryZoneComponent["type"], overrides: Partial<ICTEntryZoneComponent> = {}): ICTEntryZoneComponent {
  return {
    id, type, direction: "bullish", low: 1.1, high: 1.101,
    timeframe: "1H", impulseId: "1H:10:20:bullish", lifecycle: fresh,
    fibDepth: 0.618, valueLocationScore: 1.5, displacementScore: 2,
    liquidityScore: 1, htfLineageScore: 1, historicalSRScore: 1,
    proximityScore: 1, ...overrides,
  };
}

Deno.test("breaker invalidation uses the far boundary in the new direction", () => {
  const bounds = { low: 1.1, high: 1.101 };
  assertEquals(breakerCloseInvalidated("bearish", bounds, 1.1011), true);
  assertEquals(breakerCloseInvalidated("bearish", bounds, 1.0999), false);
  assertEquals(breakerCloseInvalidated("bullish", bounds, 1.0999), true);
  assertEquals(breakerCloseInvalidated("bullish", bounds, 1.1011), false);
});

Deno.test("breaker retest requires touch without a far-boundary close", () => {
  const bounds = { low: 1.1, high: 1.101 };
  assertEquals(breakerRetestHeld("bearish", bounds, { low: 1.0995, high: 1.1005, close: 1.1002 }), true);
  assertEquals(breakerRetestHeld("bearish", bounds, { low: 1.1005, high: 1.1015, close: 1.1012 }), false);
});

Deno.test("breaker ownership requires opposite structure after the old OB", () => {
  const breaks = [{ index: 12, type: "bullish" }, { index: 18, type: "bearish" }];
  assertEquals(hasOppositeStructureBreak("bearish", 10, 17, breaks), true);
  assertEquals(hasOppositeStructureBreak("bullish", 13, 17, breaks), false);
});

Deno.test("OB and FVG compete without a type preference", () => {
  const selection = selectICTEntryZone([
    component("ob", "ob", { displacementScore: 0.5 }),
    component("fvg", "fvg", { low: 1.102, high: 1.103, displacementScore: 3 }),
  ]);
  assertEquals(selection.selected?.type, "fvg");
});

Deno.test("overlapping OB and FVG become one composite candidate", () => {
  const selection = selectICTEntryZone([
    component("ob", "ob", { low: 1.1, high: 1.1015 }),
    component("fvg", "fvg", { low: 1.101, high: 1.102 }),
  ]);
  assertEquals(selection.selected?.type, "ob_fvg");
  assertEquals(selection.selected?.low, 1.101);
  assertEquals(selection.selected?.high, 1.1015);
  assertEquals(selection.selected?.componentIds, ["fvg", "ob"]);
});

Deno.test("overlapping breaker and FVG form a Unicorn candidate", () => {
  const selection = selectICTEntryZone([
    component("breaker", "breaker", { low: 1.1, high: 1.1015 }),
    component("fvg", "fvg", { low: 1.101, high: 1.102 }),
  ]);
  assertEquals(selection.selected?.type, "breaker_fvg");
  assertGreater(selection.selected?.score ?? 0, 0);
});

Deno.test("breaker fill lifecycle requires frozen structure and an intact far boundary", () => {
  assertEquals(evaluateBreakerFillLifecycle({
    direction: "short",
    bounds: { low: 1.1, high: 1.101 },
    currentClose: 1.1005,
    structureBreakIndex: 20,
  }).allowed, true);
  assertEquals(evaluateBreakerFillLifecycle({
    direction: "short",
    bounds: { low: 1.1, high: 1.101 },
    currentClose: 1.1012,
    structureBreakIndex: 20,
  }).code, "breaker_invalidated");
  assertEquals(evaluateBreakerFillLifecycle({
    direction: "short",
    bounds: { low: 1.1, high: 1.101 },
    currentClose: 1.1005,
    structureBreakIndex: null,
  }).code, "missing_structure_ownership");
});
