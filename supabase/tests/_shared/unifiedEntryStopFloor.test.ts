/**
 * unifiedEntryStopFloor.test.ts — the entry stop must survive the spread.
 *
 * buildEntryStory derives the stop from zone width alone:
 *
 *     slPrice = zone.high + (zone.high - zone.low) * 0.5
 *
 * With no floor, a narrow zone produces a stop smaller than the spread. Worse,
 * because R:R is reward/risk, a tiny stop inflates R:R — so the *worse* the stop,
 * the *better* the setup scores, and the more easily it clears the minimum-R:R
 * gate. A broken stop was being read as a green light.
 *
 * Reproduced from a live GBP/CHF short on 2026-08-10:
 *
 *     zone      1.09133 – 1.09164   (3.1 pips wide)
 *     impulse   1.08927 → 1.09197   (27 pips, on 5m)
 *     stop      1.09179             (1.55 pips — GBP/CHF spread is 2-3)
 *     R:R       15.29:1
 *
 * GBP/CHF's MIN_SL_PIPS is 25. Note the impulse origin sits only 3.3 pips above
 * entry, so even capping the stop at the origin cannot reach 25 — that impulse is
 * simply too small to support a tradeable stop on this pair, and the setup must be
 * rejected rather than quietly given a 3.3-pip stop.
 */

import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findUnifiedZone } from "../../functions/_shared/unifiedZoneEngine.ts";
import { MIN_SL_PIPS } from "../../functions/_shared/smcAnalysis.ts";

Deno.test("GBP/CHF minimum stop is 25 pips (anchors the live case below)", () => {
  assertEquals(MIN_SL_PIPS["GBP/CHF"], 25);
});

// buildEntryStory is module-private, so exercise the same arithmetic the live
// trade went through. Kept in lockstep with the source by the guard test below.
function entryStop(input: {
  direction: "bullish" | "bearish";
  zoneHigh: number;
  zoneLow: number;
  impulseHigh: number;
  impulseLow: number;
  pipSize: number;
  minStopPips: number;
}): { entry: number; sl: number } | null {
  const pipMult = 1 / input.pipSize;
  let entryPrice: number;
  let slPrice: number;
  if (input.direction === "bearish") {
    entryPrice = input.zoneHigh;
    slPrice = input.zoneHigh + (input.zoneHigh - input.zoneLow) * 0.5;
  } else {
    entryPrice = input.zoneLow;
    slPrice = input.zoneLow - (input.zoneHigh - input.zoneLow) * 0.5;
  }
  const minStop = input.minStopPips > 0 ? input.minStopPips / pipMult : 0;
  if (minStop > 0 && Math.abs(entryPrice - slPrice) < minStop) {
    slPrice = input.direction === "bearish" ? entryPrice + minStop : entryPrice - minStop;
  }
  if (input.direction === "bearish") {
    if (slPrice > input.impulseHigh) {
      if (minStop > 0 && Math.abs(entryPrice - input.impulseHigh) < minStop) return null;
      slPrice = input.impulseHigh;
    }
  } else {
    if (slPrice < input.impulseLow) {
      if (minStop > 0 && Math.abs(entryPrice - input.impulseLow) < minStop) return null;
      slPrice = input.impulseLow;
    }
  }
  return { entry: entryPrice, sl: slPrice };
}

const LIVE_GBPCHF = {
  direction: "bearish" as const,
  zoneHigh: 1.09164,
  zoneLow: 1.09133,
  impulseHigh: 1.09197,
  impulseLow: 1.08927,
  pipSize: 0.0001,
};

Deno.test("the live GBP/CHF trade: unfloored, the stop is 1.55 pips and R:R is 15.29", () => {
  const r = entryStop({ ...LIVE_GBPCHF, minStopPips: 0 })!;
  const riskPips = Math.abs(r.entry - r.sl) / LIVE_GBPCHF.pipSize;
  const rewardPips = Math.abs(r.entry - LIVE_GBPCHF.impulseLow) / LIVE_GBPCHF.pipSize;
  assertAlmostEquals(r.sl, 1.091795, 1e-6, "reproduces the stop shown on the live card");
  assertAlmostEquals(riskPips, 1.55, 0.01);
  assertAlmostEquals(rewardPips / riskPips, 15.29, 0.05, "reproduces the reported 15.29:1");
  assert(riskPips < 3, "stop is smaller than GBP/CHF's typical 2-3 pip spread");
});

Deno.test("the live GBP/CHF trade is rejected once the 25-pip floor applies", () => {
  // The floored stop cannot fit inside the impulse: origin is 3.3 pips from entry.
  const r = entryStop({ ...LIVE_GBPCHF, minStopPips: 25 });
  assertEquals(r, null, "a 27-pip impulse cannot support a 25-pip stop — no valid entry");
});

Deno.test("a stop narrower than the floor is widened, not rejected, when the impulse allows it", () => {
  const r = entryStop({
    direction: "bearish",
    zoneHigh: 1.1000, zoneLow: 1.0997,   // 3 pip zone → 1.5 pip raw stop
    impulseHigh: 1.1100, impulseLow: 1.0800, // roomy impulse
    pipSize: 0.0001, minStopPips: 25,
  })!;
  assertAlmostEquals((r.sl - r.entry) / 0.0001, 25, 0.01, "stop widened to the floor");
  assert(r.sl < 1.1100, "still inside the impulse");
});

Deno.test("a stop already wider than the floor is left alone", () => {
  const r = entryStop({
    direction: "bearish",
    zoneHigh: 1.1000, zoneLow: 1.0920,   // 80 pip zone → 40 pip raw stop
    impulseHigh: 1.1200, impulseLow: 1.0800,
    pipSize: 0.0001, minStopPips: 25,
  })!;
  assertAlmostEquals((r.sl - r.entry) / 0.0001, 40, 0.01, "untouched — already above the floor");
});

Deno.test("bullish setups get the same treatment", () => {
  const tooSmall = entryStop({
    direction: "bullish",
    zoneHigh: 1.1003, zoneLow: 1.1000,
    impulseHigh: 1.1050, impulseLow: 1.0998, // origin only 2 pips below entry
    pipSize: 0.0001, minStopPips: 25,
  });
  assertEquals(tooSmall, null, "impulse too small to hold a 25-pip stop");

  const ok = entryStop({
    direction: "bullish",
    zoneHigh: 1.1003, zoneLow: 1.1000,
    impulseHigh: 1.1200, impulseLow: 1.0900,
    pipSize: 0.0001, minStopPips: 25,
  })!;
  assertAlmostEquals((ok.entry - ok.sl) / 0.0001, 25, 0.01);
});

Deno.test("minStopPips = 0 preserves the legacy behaviour exactly", () => {
  const r = entryStop({ ...LIVE_GBPCHF, minStopPips: 0 })!;
  assertAlmostEquals(r.sl, 1.091795, 1e-6);
});

Deno.test("source guard: buildEntryStory applies the floor and the impulse-fit check", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/unifiedZoneEngine.ts", import.meta.url),
  );
  assert(src.includes("minStopPips"), "config must expose minStopPips");
  assert(
    /const minStop = minStopPips > 0 \? minStopPips \/ pipMult : 0;/.test(src),
    "buildEntryStory must convert the floor into price distance",
  );
  assert(
    /if \(minStop > 0 && Math\.abs\(entryPrice - impulse\.(high|low)\) < minStop\) return null;/.test(src),
    "must reject when the floored stop cannot fit inside the impulse",
  );
  // The scanner must actually supply it.
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  assert(
    /minStopPips: Math\.max\(\s*MIN_SL_PIPS\[pair\]/.test(scanner),
    "bot-scanner must pass MIN_SL_PIPS-derived floor into findUnifiedZone",
  );
});

Deno.test("findUnifiedZone accepts minStopPips without disturbing a no-zone result", () => {
  const res = findUnifiedZone(
    [], [], [], "bearish", 1.09, [], undefined, undefined, undefined, undefined, undefined,
    { minStopPips: 25 },
  );
  assertEquals(res.hasZone, false);
});
