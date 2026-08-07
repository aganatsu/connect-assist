import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCanonicalLiquiditySequences } from "../functions/_shared/canonicalLiquiditySequence.ts";

const authority = (events: any[]) => ({ contractVersion: "canonical-structure.v1", observationOnly: true, affectsAuthorization: false, internalLookback: 3, externalLookback: 7, levels: [{ id: "inducement", significance: "internal", side: "low", price: 1.1, pivotIndex: 1, confirmedIndex: 4, datetime: "x", label: "HL", status: "swept" }], events, trend: { internal: "bullish", external: "ranging" } }) as any;
const event = (id: string, type: string, direction: string, candleIndex: number) => ({ id, type, direction, significance: "internal", levelId: id, level: 1, candleIndex, datetime: "x", close: 1, extreme: 1, closeDistance: 0, displacementRatio: 0.8 });

Deno.test("sweep plus same-direction MSS confirms fakeout sequence", () => {
  const report = buildCanonicalLiquiditySequences(authority([event("s", "sweep", "bullish", 10), event("m", "mss", "bullish", 12)]));
  assertEquals(report.sequences[0].status, "fakeout_confirmed");
  assertEquals(report.sequences[0].entryReady, true);
  assertEquals(report.sequences[0].inducement?.id, "inducement");
});

Deno.test("sweep alone never authorizes entry", () => {
  const report = buildCanonicalLiquiditySequences(authority([event("s", "sweep", "bearish", 10)]));
  assertEquals(report.sequences[0].status, "sweep_only");
  assertEquals(report.sequences[0].entryReady, false);
});

Deno.test("opposite shift does not confirm fakeout", () => {
  const report = buildCanonicalLiquiditySequences(authority([event("s", "sweep", "bullish", 10), event("m", "mss", "bearish", 12)]));
  assertEquals(report.sequences.find((sequence) => sequence.sweep)?.entryReady, false);
});
