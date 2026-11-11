import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { is4HRetracing } from "./directionEngine.ts";
import { buildDirectionConfig } from "./smcDirectionDecision.ts";
import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./configMapper.ts";

// 30 flat 15m bars; only the CHoCH list matters for the block decision.
const bars = Array.from({ length: 30 }, (_, i) => ({
  datetime: new Date(Date.UTC(2026, 10, 11, 0, 15 * i)).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1, volume: 0,
}));
const structure = (choch: Array<{ index: number; type: "bullish" | "bearish"; price: number }>) =>
  ({ choch, bos: [], swingPoints: [], trend: "ranging" }) as never;

Deno.test("default: an opposing 15m CHoCH in the window blocks, even with a newer one back with the bias", () => {
  const s = structure([{ index: 22, type: "bearish", price: 1.0990 }, { index: 26, type: "bullish", price: 1.1010 }]);
  assertEquals(is4HRetracing(s, "bullish", bars, 10).chochAgainst, true);
});

Deno.test("latestDecides: the newer CHoCH with the bias lifts the block", () => {
  const s = structure([{ index: 22, type: "bearish", price: 1.0990 }, { index: 26, type: "bullish", price: 1.1010 }]);
  assertEquals(is4HRetracing(s, "bullish", bars, 10, false, true).chochAgainst, false);
});

Deno.test("latestDecides: if the latest CHoCH is against the bias, it still blocks", () => {
  const s = structure([{ index: 22, type: "bullish", price: 1.1010 }, { index: 26, type: "bearish", price: 1.0990 }]);
  assertEquals(is4HRetracing(s, "bullish", bars, 10, false, true).chochAgainst, true);
  // bearish bias mirrors it
  const t = structure([{ index: 22, type: "bullish", price: 1.1010 }, { index: 27, type: "bearish", price: 1.0990 }]);
  assertEquals(is4HRetracing(t, "bearish", bars, 10, false, true).chochAgainst, false);
});

Deno.test("buildDirectionConfig: ON by default (the fix); only an explicit false restores the old rule", () => {
  assertEquals(buildDirectionConfig({}).structureLatestChochDecides, true);
  assertEquals(buildDirectionConfig({ structureLatestChochDecides: true }).structureLatestChochDecides, true);
  assertEquals(buildDirectionConfig({ structureLatestChochDecides: false }).structureLatestChochDecides, false);
});

Deno.test("configMapper: strategy.structureLatestChochDecides reaches the runtime config; default true", () => {
  assertEquals((RUNTIME_DEFAULTS as Record<string, unknown>).structureLatestChochDecides, true);
  assertEquals((mapNestedToFlat({}) as Record<string, unknown>).structureLatestChochDecides, true);
  assertEquals((mapNestedToFlat({ strategy: { structureLatestChochDecides: false } }) as Record<string, unknown>).structureLatestChochDecides, false);
});

Deno.test("the reason names the timeframe actually checked (15m on the scalper path), not 4H", () => {
  const s = structure([{ index: 26, type: "bearish", price: 1.0990 }]);
  const r = is4HRetracing(s, "bullish", bars, 10, false, true, "15m");
  assertEquals(r.chochAgainst, true);
  assertEquals(r.reason.startsWith("15m CHoCH against bullish bias"), true);
  // the legacy day-trader path keeps its real 4H label
  assertEquals(is4HRetracing(s, "bullish", bars, 10).reason.startsWith("4H CHoCH against"), true);
});

Deno.test("when a newer CHoCH overrides opposing ones, the reason says so instead of 'no CHoCH'", () => {
  const s = ({
    choch: [{ index: 22, type: "bearish", price: 1.0990 }, { index: 26, type: "bullish", price: 1.1010 }],
    bos: [], trend: "bullish",
    swingPoints: [{ type: "high", price: 1.1020, index: 20 }, { type: "low", price: 1.0980, index: 23 }],
  }) as never;
  const r = is4HRetracing(s, "bullish", bars, 10, false, true, "15m");
  assertEquals(r.chochAgainst, false);
  assertEquals(r.reason.includes("1 opposing CHoCH superseded by a newer bullish CHoCH"), true);
  assertEquals(r.reason.includes("no CHoCH"), false);
});
