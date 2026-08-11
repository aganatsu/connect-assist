/**
 * manualImpulse.test.ts — hand-marked impulses.
 *
 * You mark an impulse on TradingView; the bot does the rest. Everything after
 * impulse selection takes an ImpulseLeg and does not care where it came from,
 * so a manual leg substitutes for findStructuralLeg() and nothing else changes.
 *
 * These tests pin the guardrails: a marking must be coherent, locatable on the
 * chart, large enough to hold a legal stop, and not already invalidated.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveManualImpulse } from "../../functions/_shared/manualImpulse.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

let clock = Date.UTC(2026, 7, 1);
function bar(open: number, high: number, low: number, close: number): Candle {
  const c = { open, high, low, close, volume: 100, datetime: new Date(clock).toISOString() };
  clock += 3_600_000;
  return c;
}

/**
 * EUR/USD rallying 1.0800 → 1.0900 (100 pips), then holding above the origin.
 * Low sits at index 2, high at index 8.
 */
function bullishSeries(): Candle[] {
  clock = Date.UTC(2026, 7, 1);
  const bars: Candle[] = [];
  bars.push(bar(1.0830, 1.0835, 1.0820, 1.0825)); // 0
  bars.push(bar(1.0825, 1.0828, 1.0810, 1.0815)); // 1
  bars.push(bar(1.0815, 1.0818, 1.0800, 1.0808)); // 2  ← origin low
  bars.push(bar(1.0808, 1.0840, 1.0805, 1.0838)); // 3
  bars.push(bar(1.0838, 1.0865, 1.0835, 1.0862)); // 4
  bars.push(bar(1.0862, 1.0880, 1.0858, 1.0876)); // 5
  bars.push(bar(1.0876, 1.0890, 1.0872, 1.0886)); // 6
  bars.push(bar(1.0886, 1.0896, 1.0882, 1.0893)); // 7
  bars.push(bar(1.0893, 1.0900, 1.0888, 1.0897)); // 8  ← terminal high
  bars.push(bar(1.0897, 1.0899, 1.0870, 1.0875)); // 9  pullback, holds origin
  bars.push(bar(1.0875, 1.0882, 1.0860, 1.0868)); // 10
  return bars;
}

const EURUSD = { symbol: "EUR/USD", direction: "bullish" as const, high: 1.0900, low: 1.0800 };

Deno.test("a well-formed marking resolves to a leg", () => {
  const r = resolveManualImpulse(bullishSeries(), EURUSD);
  assertEquals(r.rejection, null, r.detail);
  assert(r.leg);
  assertEquals(r.leg!.direction, "bullish");
  assertEquals(r.leg!.isValid, true);
  assertEquals(r.leg!.startIndex, 2, "origin should resolve to the swing low bar");
  assertEquals(r.leg!.endIndex, 8, "terminus should resolve to the high bar");
  assertEquals(r.leg!.spanBars, 6);
});

Deno.test("the marked prices are used verbatim, not snapped to bar extremes", () => {
  // Mark slightly inside the actual wicks — the fib grid should sit where drawn.
  const r = resolveManualImpulse(bullishSeries(), { ...EURUSD, high: 1.0898, low: 1.0802 });
  assertEquals(r.rejection, null, r.detail);
  assertEquals(r.leg!.high, 1.0898);
  assertEquals(r.leg!.low, 1.0802);
});

Deno.test("bosPrice is the terminal extreme of the marked leg", () => {
  const bull = resolveManualImpulse(bullishSeries(), EURUSD);
  assertEquals(bull.leg!.bosPrice, 1.0900);
});

Deno.test("high must exceed low", () => {
  const r = resolveManualImpulse(bullishSeries(), { ...EURUSD, high: 1.0800, low: 1.0900 });
  assertEquals(r.rejection, "invalid_bounds");
});

Deno.test("an impulse too small to hold a legal stop is refused at marking time", () => {
  // EUR/USD min stop 20 → needs 30 pips at 1.5 R:R. Mark only 12.
  const r = resolveManualImpulse(bullishSeries(), {
    ...EURUSD, high: 1.0900, low: 1.0888,
  });
  assertEquals(r.rejection, "too_small_for_stop");
  assert(r.detail.includes("30"), "should state the pips actually required");
});

Deno.test("the size floor scales with the instrument", () => {
  // 42 pips (bar 5 low → bar 8 high, so the order is a valid bullish leg):
  // fine on EUR/USD (needs 20 × 1.5 = 30), refused on GBP/NZD (needs 30 × 1.5 = 45).
  const eur = resolveManualImpulse(bullishSeries(), { ...EURUSD, high: 1.0900, low: 1.0858 });
  assertEquals(eur.rejection, null, eur.detail);

  const gbpnzd = resolveManualImpulse(bullishSeries(), {
    symbol: "GBP/NZD", direction: "bullish", high: 1.0900, low: 1.0858,
  });
  assertEquals(gbpnzd.rejection, "too_small_for_stop");
});

Deno.test("a direction that contradicts the chart is refused", () => {
  // On this series the low precedes the high, so it cannot be a bearish leg.
  const r = resolveManualImpulse(bullishSeries(), { ...EURUSD, direction: "bearish" });
  assertEquals(r.rejection, "direction_mismatch");
});

Deno.test("levels that are not on the chart are refused", () => {
  const r = resolveManualImpulse(bullishSeries(), {
    ...EURUSD, high: 1.2500, low: 1.2400,
  });
  assertEquals(r.rejection, "not_found_in_candles");
  assert(r.matchErrorPips, "should report how far off the marking was");
});

Deno.test("a leg whose origin has already been broken is refused", () => {
  const bars = bullishSeries();
  bars.push(bar(1.0868, 1.0870, 1.0780, 1.0790)); // closes below the 1.0800 origin
  const r = resolveManualImpulse(bars, EURUSD);
  assertEquals(r.rejection, "origin_already_broken");
  assert(r.detail.includes("1.08"), "should name the origin it broke");
});

Deno.test("a wick through the origin that closes back inside does NOT invalidate", () => {
  const bars = bullishSeries();
  bars.push(bar(1.0868, 1.0872, 1.0785, 1.0845)); // sweeps below, closes above
  const r = resolveManualImpulse(bars, EURUSD);
  assertEquals(r.rejection, null, r.detail);
  assertEquals(r.leg!.isValid, true);
});

Deno.test("bearish markings resolve symmetrically", () => {
  clock = Date.UTC(2026, 7, 1);
  const bars: Candle[] = [];
  bars.push(bar(1.0890, 1.0900, 1.0885, 1.0888)); // 0 ← terminal high
  bars.push(bar(1.0888, 1.0890, 1.0860, 1.0864));
  bars.push(bar(1.0864, 1.0868, 1.0840, 1.0844));
  bars.push(bar(1.0844, 1.0848, 1.0820, 1.0824));
  bars.push(bar(1.0824, 1.0828, 1.0800, 1.0806)); // 4 ← origin low
  bars.push(bar(1.0806, 1.0830, 1.0804, 1.0826)); // pullback, holds
  const r = resolveManualImpulse(bars, {
    symbol: "EUR/USD", direction: "bearish", high: 1.0900, low: 1.0800,
  });
  assertEquals(r.rejection, null, r.detail);
  assertEquals(r.leg!.startIndex, 0, "bearish legs start at the high");
  assertEquals(r.leg!.endIndex, 4, "bearish legs end at the low");
  assertEquals(r.leg!.bosPrice, 1.0800);
});

Deno.test("resolution reports how closely the marking matched real bars", () => {
  const r = resolveManualImpulse(bullishSeries(), EURUSD);
  assert(r.matchErrorPips);
  assert(r.matchErrorPips!.high < 1, "exact marking should match within a pip");
  assert(r.matchErrorPips!.low < 1);
});

// ── The override seam ────────────────────────────────────────────────────────
// A resolved manual leg must substitute for detection wholesale: no structural
// search, no candidate ranking, and every downstream stage behaving normally.

Deno.test("a resolved manual leg maps POIs like any other impulse", async () => {
  const { mapImpulsePOIs } = await import(
    "../../functions/_shared/impulseZoneEngine.ts"
  );
  const bars = bullishSeries();
  const r = resolveManualImpulse(bars, EURUSD);
  assertEquals(r.rejection, null, r.detail);

  const pois = mapImpulsePOIs(bars, r.leg!);
  assert(Array.isArray(pois), "POI mapping must accept a hand-marked leg");
  for (const poi of pois) {
    assert(
      poi.candleIndex >= r.leg!.startIndex && poi.candleIndex <= r.leg!.endIndex,
      `POI at ${poi.candleIndex} must sit inside the marked leg ` +
        `(${r.leg!.startIndex}..${r.leg!.endIndex})`,
    );
    assertEquals(poi.direction, "bullish", "POIs must align with the marked direction");
  }
});

Deno.test("source guard: the engine prefers a supplied manual impulse over detection", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  assert(
    /let impulse = options\?\.manualImpulse \?\? findStructuralLeg\(/.test(src),
    "manual impulse must short-circuit findStructuralLeg, not merely influence it",
  );
  assert(
    /manualImpulse\?: ImpulseLeg \| null;/.test(src),
    "ZoneEngineOptions must expose manualImpulse",
  );
});

// ── Scanner wiring ───────────────────────────────────────────────────────────

Deno.test("a marking only overrides the timeframe slot it was marked on", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  const block = src.slice(
    src.indexOf("const optionsFor ="),
    src.indexOf("// ── WATERFALL"),
  );
  assert(block.length > 0, "optionsFor not found");
  assert(
    /options\.manualImpulse\.timeframe === timeframe/.test(block),
    "the waterfall evaluates every slot, so a marking must be gated to its own " +
      "timeframe or it would override detection on timeframes never touched",
  );
  assert(
    /manualImpulse,/.test(block),
    "optionsFor must pass the gated value through",
  );
});

Deno.test("source guard: the scanner resolves, injects and retires markings", () => {
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  assert(
    /\.from\("manual_impulses"\)[\s\S]{0,200}\.eq\("status", "active"\)/.test(scanner),
    "only active markings may be loaded",
  );
  assert(
    /manualImpulse: manualImpulseLeg,/.test(scanner),
    "the resolved leg must be handed to the zone engine",
  );
  // A transient miss must not discard the marking; only permanent failures do.
  assert(
    /resolvedManual\.rejection === "origin_already_broken"/.test(scanner) &&
      !/rejection === "not_found_in_candles"[\s\S]{0,80}retireManualImpulse/.test(scanner),
    "a marking must survive a transient resolution miss",
  );
  assert(
    /await Promise\.allSettled\(manualImpulseRetirements\)/.test(scanner),
    "retirements must be settled before the cycle ends",
  );
});

// ── Revisited levels ─────────────────────────────────────────────────────────
// Live report (AUD/JPY, 2026-08-11): a leg marked 114.661 → 109.231 in August
// resolved to "May 31 → Aug 2, 45 D bars". Price had reached a similar high
// months earlier, and the matcher scanned forwards keeping strict improvements,
// so the EARLIEST equally-close bar won. The drawn leg was ~8 bars.

Deno.test("an earlier visit to the same level does not steal the anchor", () => {
  clock = Date.UTC(2026, 4, 1);
  const bars: Candle[] = [];
  // An old high at the same level, months back.
  bars.push(bar(114.40, 114.661, 114.20, 114.30)); // 0 ← decoy high
  for (let i = 0; i < 20; i++) bars.push(bar(112.5, 112.8, 112.2, 112.6));
  // The leg actually marked: high → low.
  bars.push(bar(114.40, 114.661, 114.10, 114.20)); // 21 ← real high
  bars.push(bar(114.20, 114.30, 112.00, 112.20));
  bars.push(bar(112.20, 112.40, 110.00, 110.30));
  bars.push(bar(110.30, 110.50, 109.231, 109.60)); // 24 ← real low
  bars.push(bar(109.60, 111.00, 109.50, 110.90));  // holds above the origin? no —
  // origin for a bearish leg is the HIGH, so a close above 114.661 would kill it.

  const r = resolveManualImpulse(bars, {
    symbol: "AUD/JPY", direction: "bearish", high: 114.661, low: 109.231,
  });
  assertEquals(r.rejection, null, r.detail);
  assertEquals(r.leg!.startIndex, 21, "must anchor to the recent high, not the decoy at index 0");
  assertEquals(r.leg!.endIndex, 24);
  assertEquals(r.leg!.spanBars, 3, "the drawn leg is short — not a months-long span");
});

Deno.test("the origin is still the closest bar, not merely a recent one", () => {
  // Bars near but not at the marked low must not win over the exact one.
  const bars = bullishSeries();
  const r = resolveManualImpulse(bars, EURUSD);
  assertEquals(r.rejection, null, r.detail);
  assertEquals(r.leg!.startIndex, 2, "bar 2 has the exact 1.0800 low; bar 3 at 1.0805 must not win");
});

// ── Soft qualification ───────────────────────────────────────────────────────
// qualifyImpulseLeg asks "is this really an impulse?" — displacement, body
// ratio, path efficiency, candle overlap. Those thresholds exist to stop
// AUTOMATIC detection promoting a choppy drift. A person drawing a leg has
// already made that judgement, so for a marked leg they are recorded, not
// enforced. Structural reasons are never softened.

Deno.test("soft qualification records quality failures without blocking", async () => {
  const { qualifyImpulseLeg } = await import(
    "../../functions/_shared/impulseZoneEngine.ts"
  );
  // A deliberately choppy leg: heavy overlap, weak directional movement.
  clock = Date.UTC(2026, 7, 1);
  const bars: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    const base = 1.0800 + i * 0.0002;
    bars.push(bar(base, base + 0.0030, base - 0.0028, base + 0.0001));
  }
  const leg = {
    high: 1.0890, low: 1.0800, direction: "bullish" as const,
    startIndex: 0, endIndex: 29, isValid: true, bosPrice: 1.0890,
    breakType: "bos" as const, closeBased: true,
  };
  const poi = [{
    type: "ob" as const, high: 1.0820, low: 1.0810,
    candleIndex: 5, direction: "bullish" as const,
  }];

  const strict = qualifyImpulseLeg(bars, leg, poi as any);
  const soft = qualifyImpulseLeg(bars, leg, poi as any, { softQualification: true });

  assertEquals(strict.qualified, false, "a choppy leg must fail strict qualification");
  assert(strict.reasons.length > 0);
  assertEquals(strict.softenedReasons.length, 0, "strict mode softens nothing");

  assertEquals(soft.qualified, true, "the same leg, hand-marked, proceeds");
  assert(soft.softenedReasons.length > 0, "and says what it overlooked");
  assertEquals(
    soft.reasons.length, strict.reasons.length,
    "softening must not hide the reasons, only stop them blocking",
  );
});

Deno.test("soft qualification still blocks structural failures", async () => {
  const { qualifyImpulseLeg } = await import(
    "../../functions/_shared/impulseZoneEngine.ts"
  );
  const bars = bullishSeries();
  const base = {
    high: 1.0900, low: 1.0800, direction: "bullish" as const,
    startIndex: 2, endIndex: 8, bosPrice: 1.0900,
    breakType: "bos" as const, closeBased: true,
  };

  // No POI to enter at — untradeable however good the leg looks.
  const noPoi = qualifyImpulseLeg(bars, { ...base, isValid: true }, [], {
    softQualification: true,
  });
  assertEquals(noPoi.qualified, false, "nowhere to enter must still block");
  assert(noPoi.reasons.some((r) => r.includes("No accepted FVG or Order Block")));
  assert(
    !noPoi.softenedReasons.some((r) => r.includes("No accepted FVG or Order Block")),
    "a structural reason must never be softened",
  );

  // Origin gone — the premise of the leg is void.
  const broken = qualifyImpulseLeg(bars, { ...base, isValid: false }, [
    { type: "ob", high: 1.0820, low: 1.0810, candleIndex: 3, direction: "bullish" },
  ] as any, { softQualification: true });
  assertEquals(broken.qualified, false);
  assertEquals(broken.state, "invalidated");
});

Deno.test("a hand-marked leg reports closeBased, so it is not failed for lacking a BOS close", () => {
  const r = resolveManualImpulse(bullishSeries(), EURUSD);
  assertEquals(r.rejection, null, r.detail);
  assertEquals(
    r.leg!.closeBased, true,
    "there is no detected structure break to confirm on a drawn leg",
  );
});
