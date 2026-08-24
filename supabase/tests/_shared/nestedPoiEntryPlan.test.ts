import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildConceptEvidence } from "../../functions/_shared/conceptEvidence.ts";
import { selectICTEntryZone } from "../../functions/_shared/ictEntryZoneAuthority.ts";
import {
  buildNestedPoiEntryPlan,
  checkHistoricalSR,
  checkHTFConfluence,
  type RankedPOI,
  refineLowerTF,
} from "../../functions/_shared/impulseZoneEngine.ts";
import { closedCandleTouchesNestedPoiTrigger } from "../../functions/_shared/pendingZoneTouch.ts";
import {
  createZoneLocalConfluenceObservation,
  observeContextOnly,
  observeZoneLocalPoint,
  observeZoneLocalRange,
  type ZoneLocalConfluenceObservation,
  type ZoneLocalEvidenceSource,
} from "../../functions/_shared/zoneLocalConfluence.ts";

const OBSERVED_AT = "2026-08-24T12:00:00Z";

function localObservation(): ZoneLocalConfluenceObservation {
  return createZoneLocalConfluenceObservation({
    candidateId: "outer-zone",
    zone: { low: 1.1, high: 1.11 },
    pipSize: 0.0001,
    atr: 0.002,
  });
}

function rankedZone(
  localConfluence?: ZoneLocalConfluenceObservation,
  direction: "bullish" | "bearish" = "bullish",
): RankedPOI {
  return {
    poi: {
      type: "fvg",
      low: 1.1,
      high: 1.11,
      candleIndex: 10,
      direction,
    },
    fibLevel: 0.618,
    fibDepth: 0.618,
    fibScore: 1.5,
    srConfirmed: false,
    ltfRefined: false,
    htfConfluenceScore: 0,
    htfLayers: [],
    totalScore: 1.5,
    localConfluence,
  };
}

function addRange(
  local: ZoneLocalConfluenceObservation,
  input: {
    source: Extract<
      ZoneLocalEvidenceSource,
      "ltf_refinement" | "htf_order_block" | "htf_fvg" | "htf_breaker"
    >;
    concept: "order_block" | "fvg" | "breaker";
    low: number;
    high: number;
    lifecycle: string;
    credit?: number;
    subtype?: string;
    discriminator?: string;
    direction?: "bullish" | "bearish";
  },
): void {
  const evidence = buildConceptEvidence({
    concept: input.concept,
    detector: { name: "nested-test", version: "1" },
    symbol: "EUR/USD",
    timeframe: "5m",
    sourceCandleStart: OBSERVED_AT,
    observedAt: OBSERVED_AT,
    direction: input.direction || "bullish",
    bounds: { low: input.low, high: input.high },
    lifecycle: input.lifecycle,
    discriminator: input.discriminator || input.source,
    attributes: input.subtype ? { subtype: input.subtype } : {},
  });
  local.items.push(observeZoneLocalRange({
    source: input.source,
    label: input.concept,
    evidence,
    candidate: local,
    bounds: { low: input.low, high: input.high },
    legacyScoreContribution: input.credit ?? 1,
    attributes: input.subtype ? { subtype: input.subtype } : {},
  }));
}

function addPoint(
  local: ZoneLocalConfluenceObservation,
  input: {
    source: "historical_sr" | "impulse_fib" | "htf_fib";
    concept: "support_resistance" | "fib_level";
    level: number;
    credit?: number;
    discriminator?: string;
  },
): void {
  const evidence = buildConceptEvidence({
    concept: input.concept,
    detector: { name: "nested-test", version: "1" },
    symbol: "EUR/USD",
    timeframe: "5m",
    sourceCandleStart: OBSERVED_AT,
    observedAt: OBSERVED_AT,
    direction: input.concept === "support_resistance" ? "neutral" : "bullish",
    level: input.level,
    discriminator: input.discriminator || input.source,
  });
  local.items.push(observeZoneLocalPoint({
    source: input.source,
    label: input.concept,
    evidence,
    candidate: local,
    level: input.level,
    legacyScoreContribution: input.credit ?? 1,
  }));
}

Deno.test("nested POI plan selects the strongest contained range without a midpoint fallback", () => {
  const local = localObservation();
  addRange(local, {
    source: "ltf_refinement",
    concept: "fvg",
    low: 1.104,
    high: 1.106,
    lifecycle: "open",
    discriminator: "fvg",
  });
  addRange(local, {
    source: "ltf_refinement",
    concept: "order_block",
    low: 1.1035,
    high: 1.1055,
    lifecycle: "fresh",
    discriminator: "ob",
  });
  addPoint(local, {
    source: "impulse_fib",
    concept: "fib_level",
    level: 1.1045,
    credit: 1.5,
  });
  addPoint(local, {
    source: "historical_sr",
    concept: "support_resistance",
    level: 1.1048,
  });

  const plan = buildNestedPoiEntryPlan(rankedZone(local));
  assertEquals(plan.contractVersion, "nested-poi-entry.v1");
  assertEquals(plan.enforcement, "observe_only");
  assertEquals(plan.reason, "selected");
  assertExists(plan.selected);
  assertEquals(plan.selected.type, "ob");
  assertEquals(plan.selected.geometry, "range");
  assertEquals(plan.selected.entryPrice, 1.1055);
  assertEquals(plan.selected.independentEvidenceCount, 4);
  assertEquals(plan.selected.supportingFamilies, [
    "fib",
    "fvg",
    "ob",
    "support_resistance",
  ]);
});

Deno.test("nested POI plan accepts only a true active breaker", () => {
  const local = localObservation();
  addRange(local, {
    source: "htf_breaker",
    concept: "breaker",
    low: 1.102,
    high: 1.103,
    lifecycle: "respected",
    subtype: "breaker",
    discriminator: "active-breaker",
  });
  addRange(local, {
    source: "htf_breaker",
    concept: "breaker",
    low: 1.104,
    high: 1.105,
    lifecycle: "active",
    subtype: "mitigation_block",
    discriminator: "mitigation-block",
  });
  addRange(local, {
    source: "htf_breaker",
    concept: "breaker",
    low: 1.106,
    high: 1.107,
    lifecycle: "broken",
    subtype: "breaker",
    discriminator: "broken-breaker",
  });

  const plan = buildNestedPoiEntryPlan(rankedZone(local));
  assertExists(plan.selected);
  assertEquals(plan.candidates.length, 1);
  assertEquals(plan.selected.type, "breaker");
  assertEquals(plan.selected.lifecycle, "respected");
});

Deno.test("nested ICT authority rejects invalid or non-contained evidence before ranking", () => {
  const local = localObservation();
  addRange(local, {
    source: "ltf_refinement",
    concept: "order_block",
    low: 1.102,
    high: 1.103,
    lifecycle: "broken",
    credit: 100,
    discriminator: "broken-ob",
  });
  addRange(local, {
    source: "htf_breaker",
    concept: "breaker",
    low: 1.104,
    high: 1.105,
    lifecycle: "active",
    subtype: "mitigation_block",
    credit: 100,
    discriminator: "wrong-breaker-subtype",
  });
  addRange(local, {
    source: "htf_fvg",
    concept: "fvg",
    low: 1.1,
    high: 1.106,
    lifecycle: "open",
    credit: 100,
    discriminator: "outer-boundary-fvg",
  });
  addRange(local, {
    source: "ltf_refinement",
    concept: "fvg",
    low: 1.107,
    high: 1.108,
    lifecycle: "open",
    credit: 1,
    discriminator: "valid-fvg",
  });

  const selection = selectICTEntryZone({
    mode: "nested_poi",
    outerZone: { low: 1.1, high: 1.11, direction: "bullish" },
    impulseId: "outer-zone",
    evidence: local.items,
  });

  assertExists(selection.selected);
  assertEquals(selection.ranked.length, 1);
  assertEquals(selection.selected.type, "fvg");
  assertEquals(selection.selected.low, 1.107);
  assertEquals(selection.selected.high, 1.108);
});

Deno.test("nested POI plan rejects buffered points and partially overlapping ranges", () => {
  const local = localObservation();
  addRange(local, {
    source: "htf_fvg",
    concept: "fvg",
    low: 1.0995,
    high: 1.102,
    lifecycle: "open",
  });
  addPoint(local, {
    source: "historical_sr",
    concept: "support_resistance",
    level: 1.0999,
  });
  assert(local.items.every((item) => item.qualification?.qualified === true));

  const plan = buildNestedPoiEntryPlan(rankedZone(local));
  assertEquals(plan.selected, null);
  assertEquals(plan.candidates, []);
  assertEquals(plan.reason, "no_contained_trigger");
});

Deno.test("nested POI plan rejects point and range geometry on the outer boundary", () => {
  const local = localObservation();
  addPoint(local, {
    source: "historical_sr",
    concept: "support_resistance",
    level: 1.1,
    discriminator: "outer-low",
  });
  addPoint(local, {
    source: "impulse_fib",
    concept: "fib_level",
    level: 1.11,
    discriminator: "outer-high",
  });
  addRange(local, {
    source: "ltf_refinement",
    concept: "order_block",
    low: 1.1,
    high: 1.102,
    lifecycle: "fresh",
    discriminator: "range-on-low",
  });
  addRange(local, {
    source: "ltf_refinement",
    concept: "fvg",
    low: 1.108,
    high: 1.11,
    lifecycle: "open",
    discriminator: "range-on-high",
  });

  const plan = buildNestedPoiEntryPlan(rankedZone(local));
  assertEquals(plan.selected, null);
  assertEquals(plan.candidates, []);
  assertEquals(plan.reason, "no_contained_trigger");
});

Deno.test("nested POI plan supports exact S/R and Fib point triggers", () => {
  const local = localObservation();
  addPoint(local, {
    source: "historical_sr",
    concept: "support_resistance",
    level: 1.103,
    credit: 1,
  });
  addPoint(local, {
    source: "htf_fib",
    concept: "fib_level",
    level: 1.106,
    credit: 1.5,
  });

  const plan = buildNestedPoiEntryPlan(rankedZone(local));
  assertExists(plan.selected);
  assertEquals(plan.selected.type, "fib");
  assertEquals(plan.selected.geometry, "level");
  assertEquals(plan.selected.entryPrice, 1.106);
});

Deno.test("nested POI range entry uses the near edge for a bearish setup", () => {
  const local = localObservation();
  addRange(local, {
    source: "ltf_refinement",
    concept: "fvg",
    low: 1.106,
    high: 1.108,
    lifecycle: "open",
    direction: "bearish",
  });

  const plan = buildNestedPoiEntryPlan(rankedZone(local, "bearish"));
  assertExists(plan.selected);
  assertEquals(plan.selected.direction, "bearish");
  assertEquals(plan.selected.entryPrice, 1.106);
});

Deno.test("nested POI plan rejects evidence that conflicts with setup direction", () => {
  const local = localObservation();
  addRange(local, {
    source: "ltf_refinement",
    concept: "order_block",
    low: 1.103,
    high: 1.104,
    lifecycle: "fresh",
    direction: "bullish",
  });

  const plan = buildNestedPoiEntryPlan(rankedZone(local, "bearish"));
  assertEquals(plan.selected, null);
  assertEquals(plan.reason, "no_contained_trigger");
});

Deno.test("nested POI plan returns no trigger when local evidence is unavailable", () => {
  const plan = buildNestedPoiEntryPlan(rankedZone());
  assertEquals(plan.selected, null);
  assertEquals(plan.candidates, []);
  assertEquals(plan.reason, "local_evidence_unavailable");
  assertEquals("entryPrice" in plan, false);
});

Deno.test("nested POI ranking is deterministic across evidence input order", () => {
  const makeLocal = (reverse: boolean) => {
    const local = localObservation();
    const additions = [
      () =>
        addRange(local, {
          source: "ltf_refinement",
          concept: "fvg",
          low: 1.102,
          high: 1.103,
          lifecycle: "open",
          discriminator: "a",
        }),
      () =>
        addRange(local, {
          source: "ltf_refinement",
          concept: "fvg",
          low: 1.106,
          high: 1.107,
          lifecycle: "open",
          discriminator: "b",
        }),
    ];
    for (const add of reverse ? additions.reverse() : additions) add();
    return local;
  };
  const first = buildNestedPoiEntryPlan(rankedZone(makeLocal(false)));
  const second = buildNestedPoiEntryPlan(rankedZone(makeLocal(true)));
  assertEquals(first.selected?.id, second.selected?.id);
  assertEquals(
    first.candidates.map((candidate) => candidate.id),
    second.candidates.map((candidate) => candidate.id),
  );
});

Deno.test("nested FVG evidence never bridges non-contiguous visits to the outer zone", () => {
  const local = localObservation();
  const zone = rankedZone(local);
  const candle = (
    minute: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ) => ({
    datetime: `2026-08-24T12:${String(minute).padStart(2, "0")}:00Z`,
    open,
    high,
    low,
    close,
    volume: 100,
  });
  const outside = (minute: number) =>
    candle(minute, 1.1115, 1.112, 1.111, 1.1115);
  const candles = [
    candle(0, 1.101, 1.102, 1.1005, 1.1015),
    outside(1),
    outside(2),
    outside(3),
    candle(4, 1.1025, 1.105, 1.1025, 1.104),
    outside(5),
    outside(6),
    outside(7),
    candle(8, 1.1065, 1.108, 1.106, 1.107),
    outside(9),
  ];

  refineLowerTF(candles, zone, {
    entryTimeframe: "5m",
    collectNestedPoiEvidence: true,
    evidenceContext: {
      symbol: "EUR/USD",
      timeframe: "1H",
      observedAt: OBSERVED_AT,
    },
  });

  assertEquals(
    (zone.nestedPoiEvidence || []).filter((item) =>
      item.source === "ltf_refinement" &&
      item.evidence?.concept === "fvg"
    ),
    [],
  );
});

Deno.test("nested FVG evidence is available before legacy inside-zone refinement qualifies", () => {
  const local = localObservation();
  const zone = rankedZone(local);
  const candles = [
    {
      datetime: "2026-08-24T12:00:00Z",
      open: 1.101,
      high: 1.102,
      low: 1.1005,
      close: 1.1015,
      volume: 100,
    },
    {
      datetime: "2026-08-24T12:01:00Z",
      open: 1.111,
      high: 1.113,
      low: 1.1105,
      close: 1.112,
      volume: 100,
    },
    {
      datetime: "2026-08-24T12:02:00Z",
      open: 1.106,
      high: 1.108,
      low: 1.105,
      close: 1.107,
      volume: 100,
    },
    ...Array.from({ length: 7 }, (_, offset) => ({
      datetime: `2026-08-24T12:0${offset + 3}:00Z`,
      open: 1.112,
      high: 1.113,
      low: 1.111,
      close: 1.1125,
      volume: 100,
    })),
  ];

  refineLowerTF(candles, zone, {
    entryTimeframe: "1m",
    collectNestedPoiEvidence: true,
    evidenceContext: {
      symbol: "EUR/USD",
      timeframe: "1H",
      observedAt: OBSERVED_AT,
    },
  });

  const fvgs = (zone.nestedPoiEvidence || []).filter((item) =>
    item.source === "ltf_refinement" && item.evidence?.concept === "fvg" &&
    item.evidence.bounds?.low === 1.102 && item.evidence.bounds?.high === 1.105
  );
  assertEquals(fvgs.length, 1);
  assertEquals(zone.ltfRefined, false);
});

Deno.test("nested POI touch requires a completed candle to overlap the frozen trigger", () => {
  const local = localObservation();
  addRange(local, {
    source: "ltf_refinement",
    concept: "order_block",
    low: 1.103,
    high: 1.104,
    lifecycle: "fresh",
  });
  const selected = buildNestedPoiEntryPlan(rankedZone(local)).selected;
  assertExists(selected);
  assertEquals(
    closedCandleTouchesNestedPoiTrigger({
      datetime: "2026-08-24T12:05:00Z",
      open: 1.105,
      low: 1.1035,
      high: 1.105,
      close: 1.104,
      volume: 1,
    }, selected),
    true,
  );
  assertEquals(
    closedCandleTouchesNestedPoiTrigger({
      datetime: "2026-08-24T12:10:00Z",
      open: 1.105,
      low: 1.1041,
      high: 1.105,
      close: 1.1045,
      volume: 1,
    }, selected),
    false,
  );
});

Deno.test("nested POI plan never promotes context-only evidence into an entry", () => {
  const local = localObservation();
  local.items.push(observeContextOnly({
    source: "premium_discount",
    label: "Premium/Discount alignment",
    evidence: null,
    candidate: local,
    legacyScoreContribution: 0.5,
    reasonCode: "directional_context_not_price_local",
  }));
  const plan = buildNestedPoiEntryPlan(rankedZone(local));
  assertEquals(plan.selected, null);
  assertEquals(plan.reason, "no_contained_trigger");
});

Deno.test("historical S/R emits every contained level but scores the layer once", () => {
  const local = localObservation();
  const zone = rankedZone(local);
  const candles = Array.from({ length: 17 }, (_, index) => {
    const close = index < 8 ? 1.102 : 1.108;
    return {
      datetime: `2026-08-24T${String(index).padStart(2, "0")}:00:00Z`,
      open: close,
      high: close + 0.0001,
      low: close - 0.0001,
      close,
      volume: 100,
    };
  });

  checkHistoricalSR(candles, [zone], 16, {
    collectNestedPoiEvidence: true,
    evidenceContext: {
      symbol: "EUR/USD",
      timeframe: "1H",
      observedAt: OBSERVED_AT,
    },
  });

  assertEquals(zone.srConfirmed, true);
  assertEquals(zone.srLevel, 1.102);
  assertEquals(zone.totalScore, 2.5);
  assertEquals(
    local.items.filter((item) => item.source === "historical_sr").length,
    1,
  );
  assertEquals(
    (zone.nestedPoiEvidence || []).filter((item) =>
      item.source === "historical_sr"
    ).length,
    1,
  );
});

Deno.test("nested evidence collection preserves legacy local confluence while exposing later candidates", () => {
  const weakOb = {
    index: 1,
    high: 1.102,
    low: 1.101,
    type: "bullish",
    datetime: "2026-08-24T08:00:00Z",
    mitigated: false,
    mitigatedPercent: 0,
    state: "fresh",
    testedCount: 0,
  } as const;
  const strongerOb = {
    index: 2,
    high: 1.106,
    low: 1.105,
    type: "bullish",
    datetime: "2026-08-24T09:00:00Z",
    mitigated: false,
    mitigatedPercent: 0,
    state: "fresh",
    testedCount: 0,
  } as const;
  const supportingFvg = {
    index: 3,
    high: 1.1065,
    low: 1.1055,
    type: "bullish",
    datetime: "2026-08-24T10:00:00Z",
    mitigated: false,
    state: "open",
    fillPercent: 0,
    respectedCount: 0,
  } as const;
  const evaluate = (collectNestedPoiEvidence: boolean) => {
    const local = localObservation();
    const zone = rankedZone(local);
    checkHTFConfluence([zone], {
      h4OBs: [weakOb, strongerOb],
      h4FVGs: [supportingFvg],
      h4Breakers: [],
      htfFibLevels: null,
      htfPD: null,
      direction: "bullish",
    }, {
      collectNestedPoiEvidence,
      evidenceContext: {
        symbol: "EUR/USD",
        timeframe: "1H",
        observedAt: OBSERVED_AT,
      },
    });
    return { local, zone };
  };

  const legacy = evaluate(false);
  const nested = evaluate(true);
  assertEquals(nested.local, legacy.local);
  assertEquals(legacy.zone.nestedPoiEvidence, undefined);
  assertEquals(
    (nested.zone.nestedPoiEvidence || []).filter((item) =>
      item.source === "htf_order_block"
    ).length,
    1,
  );
  const selected = buildNestedPoiEntryPlan(nested.zone).selected;
  assertExists(selected);
  assertEquals(selected.type, "ob");
  assertEquals(selected.low, 1.105);
  assertEquals(selected.high, 1.106);
  assertEquals(selected.independentEvidenceCount, 2);
});

Deno.test("HTF evidence enumeration makes nested selection independent of detector order", () => {
  const weakOb = {
    index: 1,
    high: 1.102,
    low: 1.101,
    type: "bullish",
    datetime: "2026-08-24T08:00:00Z",
    mitigated: false,
    mitigatedPercent: 0,
    state: "fresh",
    testedCount: 0,
  } as const;
  const clusteredOb = {
    index: 2,
    high: 1.106,
    low: 1.105,
    type: "bullish",
    datetime: "2026-08-24T09:00:00Z",
    mitigated: false,
    mitigatedPercent: 0,
    state: "fresh",
    testedCount: 0,
  } as const;
  const clusteredFvg = {
    index: 3,
    high: 1.1065,
    low: 1.1055,
    type: "bullish",
    datetime: "2026-08-24T10:00:00Z",
    mitigated: false,
    state: "open",
    fillPercent: 0,
    respectedCount: 0,
  } as const;
  const evaluate = (reverse: boolean) => {
    const local = localObservation();
    const zone = rankedZone(local);
    checkHTFConfluence([zone], {
      h4OBs: reverse ? [clusteredOb, weakOb] : [weakOb, clusteredOb],
      h4FVGs: [clusteredFvg],
      h4Breakers: [],
      htfFibLevels: null,
      htfPD: null,
      direction: "bullish",
    }, {
      collectNestedPoiEvidence: true,
      evidenceContext: {
        symbol: "EUR/USD",
        timeframe: "1H",
        observedAt: OBSERVED_AT,
      },
    });
    return { zone, local, plan: buildNestedPoiEntryPlan(zone) };
  };

  const forward = evaluate(false);
  const reverse = evaluate(true);
  for (const result of [forward, reverse]) {
    assertEquals(result.zone.htfConfluenceScore, 2);
    assertEquals(result.zone.htfLayers, ["4H_OB", "4H_FVG"]);
    assertEquals(
      result.local.items.filter((item) => item.source === "htf_order_block")
        .length,
      1,
    );
    assertEquals(
      (result.zone.nestedPoiEvidence || []).filter((item) =>
        item.source === "htf_order_block"
      ).length,
      1,
    );
    assertExists(result.plan.selected);
    assertEquals(result.plan.selected.type, "ob");
    assertEquals(result.plan.selected.low, 1.105);
    assertEquals(result.plan.selected.high, 1.106);
    assertEquals(result.plan.selected.independentEvidenceCount, 2);
  }
  assertEquals(forward.plan.selected?.id, reverse.plan.selected?.id);
});
