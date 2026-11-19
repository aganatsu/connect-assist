/**
 * IMPULSE_STRETCH_PREREG_V1 — the origin-fallback switch in findImpulseLeg.
 *
 * Reference case: GBP/NZD 1H as of 2026-11-18 16:00 UTC (the bot bought 2.39552 at 16:25, stopped
 * −1R). The latest bullish break is 2026-11-17 21:00 (close above 2.40444, peak 2.40693 at 22:00).
 * Its origin, the 2.3973 swing low (17 Nov 09:00), was closed through at 18 Nov 10:00 (2.39591),
 * and so was the next one (2.3954). Today's code reaches back to 2.39019 (16 Nov 07:00).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";
import {
  findImpulseLeg, setImpulseOriginFallback, getImpulseOriginFallback, resolveImpulseOriginFallback,
} from "../../functions/_shared/impulseZoneEngine.ts";

const gbpnzd: Candle[] = JSON.parse(Deno.readTextFileSync(
  new URL("../fixtures/structure/gbpnzd_1h_2026-11-18.json", import.meta.url)));

function withFallback<T>(on: boolean, fn: () => T): T {
  const before = getImpulseOriginFallback();
  setImpulseOriginFallback(on);
  try { return fn(); } finally { setImpulseOriginFallback(before); }
}

Deno.test("default: strict (no fallback); only strictImpulseOrigin === false re-enables it", () => {
  assertEquals(getImpulseOriginFallback(), false);
  assertEquals(resolveImpulseOriginFallback(undefined), false);
  assertEquals(resolveImpulseOriginFallback(true), false);
  assertEquals(resolveImpulseOriginFallback(null), false);
  assertEquals(resolveImpulseOriginFallback("false"), false);
  assertEquals(resolveImpulseOriginFallback(false), true);
});

Deno.test("GBP/NZD: today's code stretches the leg back to 2.39019 (what the bot traded)", () => {
  const leg = withFallback(true, () => findImpulseLeg(gbpnzd, "bullish", "1H"))!;
  assertEquals([leg.low, leg.high], [2.39019, 2.40693]);
  assertEquals(leg.startTime, "2026-11-16T07:00:00Z");
  assertEquals(leg.endTime, "2026-11-17T22:00:00Z");
});

Deno.test("GBP/NZD: strict — the latest push's origin was closed through, so no bullish leg", () => {
  assertEquals(withFallback(false, () => findImpulseLeg(gbpnzd, "bullish", "1H")), null);
});

Deno.test("strict changes nothing when the nearest origin holds", () => {
  // Before 18 Nov 10:00 the 2.3973 origin was intact: both modes give 2.3973 → 2.40693.
  const upTo = gbpnzd.filter((c) => c.datetime <= "2026-11-18T09:00:00Z");
  const on = withFallback(true, () => findImpulseLeg(upTo, "bullish", "1H"))!;
  const off = withFallback(false, () => findImpulseLeg(upTo, "bullish", "1H"))!;
  assertEquals([on.low, on.high], [2.3973, 2.40693]);
  assertEquals([off.low, off.high, off.startIndex, off.endIndex], [on.low, on.high, on.startIndex, on.endIndex]);
  assert(off.isValid);
});

// ── Wiring pins ──
const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const mapper = Deno.readTextFileSync(new URL("../../functions/_shared/configMapper.ts", import.meta.url));

Deno.test("Bot Config strategy.strictImpulseOrigin maps with default true", () => {
  assert(mapper.includes("strictImpulseOrigin: true,"));
  assert(mapper.includes("strictImpulseOrigin: strategy.strictImpulseOrigin ?? raw.strictImpulseOrigin ?? RUNTIME_DEFAULTS.strictImpulseOrigin,"));
  assert(scanner.includes("strictImpulseOrigin: true,"));
});

Deno.test("bot-scanner sets the rule at scan start and per pair", () => {
  assert(scanner.includes("setImpulseOriginFallback(resolveImpulseOriginFallback((config as any).strictImpulseOrigin));"));
  assert(scanner.includes("setImpulseOriginFallback(resolveImpulseOriginFallback((pairConfig as any).strictImpulseOrigin));"));
});
