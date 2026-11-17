/**
 * CLOSE_BASED_BREAKS — a BOS/CHoCH is the first candle that CLOSES beyond the latest confirmed swing
 * (breaks from analyzeMarketStructureCanonical), and an impulse runs from its origin to the extreme
 * the leg reached. Default on; Bot Config strategy.closeBasedBreaks = false restores the legacy rule.
 *
 * Reference case: GBP/AUD 1H, owner's Bot View 2026-11-17. Price closed above the 1.95694, 1.95810
 * and 1.95907 swing highs (2026-11-16 20:00 / 22:00, 2026-11-17 06:00), but each next swing-high
 * candle wicked back, so the legacy rule logged sweeps, the last BOS stayed 2026-11-16 01:00 and the
 * impulse (1.94659 → 1.9545) and its zone sat ~80 pips under price.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analyzeMarketStructure, setBreakDetectionMode, getBreakDetectionMode, resolveBreakDetectionMode,
  type Candle,
} from "../../functions/_shared/smcAnalysis.ts";
import { findImpulseLeg } from "../../functions/_shared/impulseZoneEngine.ts";

const gbpaud: Candle[] = JSON.parse(Deno.readTextFileSync(
  new URL("../fixtures/structure/gbpaud_1h_2026-11-17.json", import.meta.url)));

function withMode<T>(mode: "close" | "legacy", fn: () => T): T {
  const before = getBreakDetectionMode();
  setBreakDetectionMode(mode);
  try { return fn(); } finally { setBreakDetectionMode(before); }
}
const bullishBreakTimes = (c: Candle[]) => {
  const st = analyzeMarketStructure(c);
  return [...st.bos, ...st.choch].filter((b) => b.type === "bullish").map((b) => b.datetime).sort();
};

Deno.test("default mode is close; only an explicit false selects legacy", () => {
  assertEquals(getBreakDetectionMode(), "close");
  assertEquals(resolveBreakDetectionMode(undefined), "close");
  assertEquals(resolveBreakDetectionMode(true), "close");
  assertEquals(resolveBreakDetectionMode(null), "close");
  assertEquals(resolveBreakDetectionMode("false"), "close");
  assertEquals(resolveBreakDetectionMode(false), "legacy");
});

Deno.test("GBP/AUD: close rule records the three breaks on the candles that closed through", () => {
  const t = withMode("close", () => bullishBreakTimes(gbpaud));
  for (const when of ["2026-11-16T20:00:00Z", "2026-11-16T22:00:00Z", "2026-11-17T06:00:00Z"]) {
    assert(t.includes(when), `break on ${when} (got ${t.slice(-5).join(", ")})`);
  }
});

Deno.test("GBP/AUD: legacy rule misses them (the defect, pinned)", () => {
  const t = withMode("legacy", () => bullishBreakTimes(gbpaud));
  assertEquals(t.filter((x) => x > "2026-11-16T01:00:00Z").length, 0,
    "legacy: no bullish break after 2026-11-16 01:00");
});

Deno.test("GBP/AUD: the impulse moves to the latest leg, origin → extreme", () => {
  const close = withMode("close", () => findImpulseLeg(gbpaud, "bullish", "1H"))!;
  assertEquals(close.low, 1.95515, "origin = the 2026-11-17 03:00 HL");
  assertEquals(close.high, 1.96115, "runs to the high the leg reached, not the break candle");
  assertEquals(close.startTime, "2026-11-17T03:00:00Z");
  assertEquals(close.endTime, "2026-11-17T09:00:00Z");

  const legacy = withMode("legacy", () => findImpulseLeg(gbpaud, "bullish", "1H"))!;
  assertEquals([legacy.low, legacy.high], [1.94659, 1.9545], "legacy stays on the old leg");
});

Deno.test("swing points (the HH/HL labels) are identical under both rules", () => {
  // Same pivots, prices and types. Only the derived lifecycle (broken / swept / brokenAt) differs,
  // because it is computed from the breaks — and under the close rule it is right (1.95694 broken
  // 2026-11-16 20:00, where legacy called it swept).
  const key = (m: "close" | "legacy") => withMode(m, () =>
    analyzeMarketStructure(gbpaud).swingPoints.map((p) => `${p.type}@${p.index}=${p.price}`));
  assertEquals(key("close"), key("legacy"));
});

Deno.test("every close-rule break closed beyond its level, after the swing was confirmed", () => {
  withMode("close", () => {
    const st = analyzeMarketStructure(gbpaud);
    for (const b of [...st.bos, ...st.choch]) {
      const c = gbpaud[b.index];
      assert(b.type === "bullish" ? c.close > b.level : c.close < b.level, `${b.datetime} closes through ${b.level}`);
      const swingIdx = (b as any).swingIndex as number;
      assert(b.index >= swingIdx + 3, `${b.datetime}: no break before the swing is confirmed (3 bars)`);
      assert(b.extremeIndex !== undefined && b.extremeIndex >= b.index, "extremeIndex at/after the break");
    }
  });
});

// ── Wiring pins ──
const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const confirm = Deno.readTextFileSync(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));
const mapper = Deno.readTextFileSync(new URL("../../functions/_shared/configMapper.ts", import.meta.url));

Deno.test("Bot Config strategy.closeBasedBreaks maps with default true", () => {
  assertStringIncludes(mapper, "closeBasedBreaks: true,");
  assertStringIncludes(mapper, "closeBasedBreaks: strategy.closeBasedBreaks ?? raw.closeBasedBreaks ?? RUNTIME_DEFAULTS.closeBasedBreaks,");
  assertStringIncludes(scanner, "closeBasedBreaks: true,");
});

Deno.test("bot-scanner sets the rule at scan start and per pair; the confirmation scanner per order", () => {
  assertStringIncludes(scanner, "setBreakDetectionMode(resolveBreakDetectionMode((config as any).closeBasedBreaks));");
  assertStringIncludes(scanner, "setBreakDetectionMode(resolveBreakDetectionMode((pairConfig as any).closeBasedBreaks));");
  assertStringIncludes(confirm, "setBreakDetectionMode(resolveBreakDetectionMode(strategyConfig.closeBasedBreaks));");
});
