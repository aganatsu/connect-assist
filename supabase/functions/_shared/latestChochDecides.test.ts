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

// ── 2026-11-12 follow-up: a newer CHoCH does not count once structure has broken against the bias ──

// EUR/JPY 15m, 2026-11-12 00:00 → 02:45 (real closes), the bars the 02:50 scan saw.
const eurjpyBars = [
  [177.2375, 177.24278, 177.00191, 177.02145], [177.05956, 177.11608, 177.0225, 177.04583],
  [177.04345, 177.1237, 177.02435, 177.06716], [177.07952, 177.13446, 177.05368, 177.10674],
  [177.10036, 177.13989, 176.97451, 177.01687], [177.00808, 177.11415, 177.00808, 177.10552],
  [177.10094, 177.19112, 177.07941, 177.10569], [177.11056, 177.1934, 177.09282, 177.19045],
  [177.18199, 177.28824, 177.16662, 177.26246], [177.24781, 177.26733, 177.14573, 177.15562],
  [177.15873, 177.16269, 176.77705, 176.91993], [176.92891, 177.02793, 176.92891, 176.98834],
].map(([open, high, low, close], i) => ({ datetime: new Date(Date.UTC(2026, 10, 12, 0, 15 * i)).toISOString(), open, high, low, close, volume: 0 }));
const eurjpyStructure = (bars: typeof eurjpyBars) => ({
  // two bearish CHoCHs, then the 02:00 bullish CHoCH (index 8) that broke the 177.24498 lower high
  choch: [
    { index: 0, type: "bearish", price: 177.00191, level: 177.07294 },
    { index: 4, type: "bearish", price: 176.97451, level: 177.00191 },
    { index: 8, type: "bullish", price: 177.28824, level: 177.24498 },
  ],
  bos: [], trend: "ranging",
  swingPoints: [{ type: "high", price: 177.24498, index: 0 }, { type: "low", price: 176.97451, index: 4 }, { type: "high", price: 177.28824, index: 8 }],
}) as never;

Deno.test("EUR/JPY 2026-11-12 02:50: the 02:30 close below the 176.975 swing low means the newer bullish CHoCH does not lift the block", () => {
  const r = is4HRetracing(eurjpyStructure(eurjpyBars), "bullish", eurjpyBars, 10, false, true, "15m");
  assertEquals(r.chochAgainst, true);
  assertEquals(r.reason.includes("newer bullish CHoCH not counted"), true);
  assertEquals(r.reason.includes("176.97451"), true);
});

Deno.test("a pullback that stays above the latest swing low keeps the newer CHoCH in charge (zone entries unaffected)", () => {
  // same story, but the 02:30 candle only dips to 177.00 and closes 177.05 — above 176.975
  const held = eurjpyBars.map((b, i) => i === 10 ? { ...b, low: 177.0, close: 177.05 } : i === 11 ? { ...b, close: 177.02 } : b);
  assertEquals(is4HRetracing(eurjpyStructure(held), "bullish", held, 10, false, true, "15m").chochAgainst, false);
});

Deno.test("bearish bias mirrors it: a close above the latest swing high voids the newer bearish CHoCH", () => {
  const s = ({
    choch: [{ index: 22, type: "bullish", price: 1.1010 }, { index: 26, type: "bearish", price: 1.0990 }],
    bos: [], trend: "ranging",
    swingPoints: [{ type: "high", price: 1.1003, index: 24 }],
  }) as never;
  const up = bars.map((b, i) => i === 28 ? { ...b, close: 1.1006 } : b);
  assertEquals(is4HRetracing(s, "bearish", up, 10, false, true).chochAgainst, true);
  assertEquals(is4HRetracing(s, "bearish", bars, 10, false, true).chochAgainst, false);
});

Deno.test("old rule (latestDecides off) is unchanged", () => {
  assertEquals(is4HRetracing(eurjpyStructure(eurjpyBars), "bullish", eurjpyBars, 10).chochAgainst, true);
});
