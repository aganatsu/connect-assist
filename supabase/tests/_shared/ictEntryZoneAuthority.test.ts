import { assertEquals, assertGreater } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { breakerCloseInvalidated, breakerRetestHeld, evaluateBreakerFillLifecycle, hasOppositeStructureBreak } from "../../functions/_shared/breakerSemantics.ts";
import {
  type ICTEntryZoneComponent,
  type ICTStructurePoiComponent,
  type ICTStructurePoiEntryZoneInput,
  mapDetectedStructurePoiComponents,
  selectICTEntryZone,
} from "../../functions/_shared/ictEntryZoneAuthority.ts";
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

function structurePoiComponent(
  id: string,
  type: ICTStructurePoiComponent["type"],
  overrides: Partial<ICTStructurePoiComponent> = {},
): ICTStructurePoiComponent {
  return {
    id,
    evidenceId: `evidence:${id}`,
    type,
    direction: "bullish",
    low: 1.1,
    high: 1.101,
    timeframe: "5m",
    sourceCandleStart: "2026-08-28T10:00:00.000Z",
    sourceCandleEnd: "2026-08-28T10:05:00.000Z",
    lifecycle: fresh,
    fibDepth: 0,
    valueLocationScore: 0,
    displacementScore: 2,
    liquidityScore: 0,
    htfLineageScore: 1,
    historicalSRScore: 0,
    proximityScore: 1,
    ...overrides,
  };
}

function structurePoiInput(
  components: ICTStructurePoiComponent[],
  overrides: Partial<ICTStructurePoiEntryZoneInput> = {},
): ICTStructurePoiEntryZoneInput {
  return {
    mode: "structure_poi",
    contextId: "liquidity:sweep-1:choch-1",
    direction: "bullish",
    observedAt: "2026-08-28T10:10:00.000Z",
    currentPrice: 1.1005,
    timeframes: {
      setup: "5m",
      structure: "15m",
      confirmation: "5m",
    },
    components,
    ...overrides,
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

Deno.test("structure POIs use the existing type-neutral selector without an impulse ID", () => {
  const selection = selectICTEntryZone(structurePoiInput([
    structurePoiComponent("ob:entity-1", "ob", {
      low: 1.1,
      high: 1.1015,
      timeframe: "15m",
      displacementScore: 0.5,
    }),
    structurePoiComponent("fvg:entity-1", "fvg", {
      low: 1.102,
      high: 1.103,
      displacementScore: 3,
    }),
  ]));

  assertEquals(selection.enforcement, "observe_only");
  assertEquals(selection.affectsAuthorization, false);
  assertEquals(selection.selected?.affectsAuthorization, false);
  assertEquals(selection.mode, "structure_poi");
  assertEquals(selection.setupFamily, "structure_poi");
  assertEquals(selection.timeframes, {
    setup: "5m", structure: "15m", confirmation: "5m",
  });
  assertEquals(selection.selected?.type, "fvg");
  assertEquals(selection.selected?.entryPrice, 1.103);
  assertEquals(selection.selected?.structuralInvalidation, 1.102);
  assertEquals(selection.selected?.contextId, "liquidity:sweep-1:choch-1");
  assertEquals(selection.selected?.timeframeRoles, ["setup", "confirmation"]);
  assertEquals(selection.selected?.sourceEvidenceIds, [
    "evidence:fvg:entity-1",
  ]);
});

Deno.test("structure POI selection accepts only stable closed-bar evidence on resolved timeframes", () => {
  const selection = selectICTEntryZone(structurePoiInput([
    structurePoiComponent("valid", "fvg"),
    structurePoiComponent("wrong-direction", "ob", { direction: "bearish" }),
    structurePoiComponent("wrong-timeframe", "ob", { timeframe: "1H" }),
    structurePoiComponent("forming", "ob", {
      sourceCandleEnd: "2026-08-28T10:15:00.000Z",
    }),
    structurePoiComponent("missing-evidence", "ob", { evidenceId: "" }),
    structurePoiComponent("invalid-score", "ob", {
      displacementScore: Number.NaN,
    }),
    structurePoiComponent("", "ob"),
    structurePoiComponent("bad-bounds", "ob", { low: 1.102, high: 1.101 }),
  ]));

  assertEquals(selection.componentCounts, { received: 8, accepted: 1 });
  assertEquals(selection.ranked.length, 1);
  assertEquals(selection.selected?.componentIds, ["valid"]);
});

Deno.test("structure POI role matching normalizes equivalent timeframe labels", () => {
  const selection = selectICTEntryZone(structurePoiInput([
    structurePoiComponent("one-hour", "ob", { timeframe: "1h" }),
  ], {
    timeframes: { setup: "1H", structure: "4H", confirmation: "15m" },
  }));

  assertEquals(selection.componentCounts, { received: 1, accepted: 1 });
  assertEquals(selection.selected?.timeframeRoles, ["setup"]);
});

Deno.test("overlapping structure POIs form one stable composite candidate", () => {
  const components = [
    structurePoiComponent("ob:entity-2", "ob", {
      low: 1.1,
      high: 1.1015,
    }),
    structurePoiComponent("fvg:entity-2", "fvg", {
      low: 1.101,
      high: 1.102,
    }),
  ];
  const first = selectICTEntryZone(structurePoiInput(components));
  const rescanned = selectICTEntryZone(structurePoiInput([...components].reverse(), {
    observedAt: "2026-08-28T10:20:00.000Z",
    contextId: "  liquidity:sweep-1:choch-1  ",
  }));

  assertEquals(first.selected?.type, "ob_fvg");
  assertEquals(first.selected?.low, 1.101);
  assertEquals(first.selected?.high, 1.1015);
  assertEquals(first.selected?.id, "structure_poi:fvg:entity-2+ob:entity-2");
  assertEquals(rescanned.selected?.id, first.selected?.id);
  assertEquals(rescanned.contextId, first.contextId);
  assertEquals(
    rescanned.selected?.sourceEvidenceIds,
    first.selected?.sourceEvidenceIds,
  );
});

Deno.test("pre-existing breaker evidence is selectable without current impulse ownership", () => {
  const candles = Array.from({ length: 24 }, (_, index) => ({
    open: 1.105, high: 1.106, low: 1.104, close: 1.105,
    datetime: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
  }));
  const components = mapDetectedStructurePoiComponents({
    symbol: "GBP/CHF",
    direction: "bearish",
    currentPrice: 1.103,
    observedAt: candles[23].datetime,
    timeframes: { setup: "1H", structure: "4H", confirmation: "15m" },
    sources: [{
      timeframe: "4H",
      candles,
      orderBlocks: [{
        index: 4, high: 1.106, low: 1.104, type: "bullish",
        datetime: candles[4].datetime, mitigated: true, mitigatedPercent: 100,
        hasDisplacement: true, state: "broken", testedCount: 1,
        brokenAt: 9, mitigatedAt: 9,
      }],
      fairValueGaps: [],
      breakerBlocks: [{
        type: "bearish_breaker", subtype: "breaker", high: 1.106, low: 1.104,
        mitigatedAt: 9, originalOBType: "bullish", isActive: true,
        state: "active", testedCount: 0,
      }],
    }],
  });
  const selection = selectICTEntryZone(structurePoiInput(components, {
    direction: "bearish",
    currentPrice: 1.103,
    timeframes: { setup: "1H", structure: "4H", confirmation: "15m" },
    observedAt: candles[23].datetime,
  }));

  assertEquals(components.length, 1);
  assertEquals(components[0].type, "breaker");
  assertEquals(components[0].sourceCandleStart, candles[4].datetime);
  assertEquals(components[0].sourceCandleEnd, candles[9].datetime);
  assertEquals(selection.selected?.type, "breaker");
  assertEquals(selection.selected?.sourceWindow, {
    start: candles[4].datetime,
    end: candles[9].datetime,
  });
  assertEquals(selection.selected?.entryPrice, 1.104);
  assertEquals(selection.selected?.structuralInvalidation, 1.106);
});

Deno.test("legacy impulse selection still rejects components without impulse ownership", () => {
  const selection = selectICTEntryZone([
    component("unowned", "ob", { impulseId: "" }),
  ]);

  assertEquals(selection.selected, null);
  assertEquals(selection.ranked, []);
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
