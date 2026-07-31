import {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildConceptEvidence,
  buildEntityId,
  buildEvidenceId,
  distanceToBounds,
  overlapMetrics,
} from "./conceptEvidence.ts";

const base = {
  concept: "fvg" as const,
  detector: { name: "smc.detectFVGs", version: "1" },
  symbol: "GBP/USD",
  timeframe: "1H",
  sourceCandleStart: "2026-07-31T12:00:00.000Z",
  direction: "bullish" as const,
  bounds: { low: 1.274, high: 1.275 },
};

Deno.test("concept evidence ID is deterministic across object instances", () => {
  assertEquals(buildEvidenceId(base), buildEvidenceId({ ...base }));
});

Deno.test("concept evidence ID normalizes symbol, timeframe, and bounds", () => {
  assertEquals(
    buildEvidenceId(base),
    buildEvidenceId({
      ...base,
      symbol: " gbp/usd ",
      timeframe: "1h",
      bounds: { low: 1.275, high: 1.274 },
    }),
  );
});

Deno.test("concept evidence ID changes with source, detector, or entity", () => {
  assertNotEquals(
    buildEvidenceId(base),
    buildEvidenceId({
      ...base,
      sourceCandleStart: "2026-07-31T13:00:00.000Z",
    }),
  );
  assertEquals(
    buildEntityId(base),
    buildEntityId({
      ...base,
      detector: { ...base.detector, version: "2" },
    }),
  );
  assertNotEquals(
    buildEvidenceId(base),
    buildEvidenceId({
      ...base,
      detector: { ...base.detector, version: "2" },
    }),
  );
  assertNotEquals(
    buildEvidenceId(base),
    buildEvidenceId({ ...base, bounds: { low: 1.273, high: 1.274 } }),
  );
});

Deno.test("concept evidence preserves normalized identity and provenance", () => {
  const evidence = buildConceptEvidence({
    ...base,
    observedAt: "2026-07-31T14:00:00.000Z",
    lifecycle: "open",
    attributes: { quality: 6.2 },
  });
  assertEquals(evidence.evidenceId, buildEvidenceId(base));
  assertEquals(evidence.entityId, buildEntityId(base));
  assertEquals(evidence.symbol, "GBP/USD");
  assertEquals(evidence.bounds, { low: 1.274, high: 1.275 });
  assertEquals(evidence.lifecycle, "open");
  assertEquals(evidence.attributes.quality, 6.2);
});

Deno.test("zone overlap and distance use zone edges, not midpoint distance", () => {
  const overlap = overlapMetrics(
    { low: 1.274, high: 1.275 },
    { low: 1.2745, high: 1.2755 },
  );
  assertAlmostEquals(overlap.amount, 0.0005);
  assertAlmostEquals(overlap.percent, 50);
  assertAlmostEquals(
    distanceToBounds(
      { low: 1.274, high: 1.275 },
      { level: 1.273 },
    ),
    0.001,
  );
  assertEquals(
    distanceToBounds(
      { low: 1.274, high: 1.275 },
      { level: 1.2746 },
    ),
    0,
  );
});
