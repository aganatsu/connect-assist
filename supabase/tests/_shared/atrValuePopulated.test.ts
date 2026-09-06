import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateATR } from "../../functions/_shared/smcAnalysis.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * `runConfluenceAnalysis` computed `atrValue` for SLTPInput and then did not
 * return it. So every downstream `analysis.atrValue` was `undefined`, and every
 * `(analysis as any).atrValue ?? 0` resolved to zero.
 *
 * Five behaviours silently did nothing as a result:
 *
 *   bot-scanner :4521  zone-story ATR stop floor
 *   bot-scanner :5841  the REAL ATR stop floor   <- this one matters
 *   bot-scanner :6055  regime-adaptive TP
 *   bot-scanner :6145+ volatility-adjusted position sizing
 *   bot-scanner :1575  Gate 18, the ATR volatility filter
 *
 * The stop floor is `max(MIN_SL_PIPS, atr * ATR_SL_FLOOR_MULTIPLIER / pipSize)`.
 * With ATR at zero it collapses to the static floor — which is exactly how
 * BTC/USD got a bare 150-point stop inside a 1354-point zone on 2026-09-04 and
 * lost $532.50 without the zone ever being invalidated.
 *
 * Gate 18 was worse than inert. It read `analysis._candles`, which has never
 * existed either, so it fell through to `calculateATR([], 14)` — zero for any
 * array shorter than 15 — and then compared that against `atrFilterMin`. With
 * that setting on, the gate blocked every trade.
 *
 * Populating the field is a one-line fix. CONSUMING it switches four dormant
 * behaviours on at once, including stop distance and position size, so the read
 * goes through `atrDerivedFloorsEnabled`, default OFF.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const scoring = await Deno.readTextFile(
  new URL("../../functions/_shared/confluenceScoring.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

Deno.test("calculateATR returns zero for a short series — the silent path", () => {
  // This is what Gate 18 was calling, every time, via a field that never existed.
  assertEquals(calculateATR([], 14), 0);
  assertEquals(calculateATR(new Array(14).fill({ high: 2, low: 1, close: 1.5 }) as Candle[], 14), 0);
  // 15 candles is the first length that produces a real number.
  const real = calculateATR(new Array(15).fill({ high: 2, low: 1, close: 1.5 }) as Candle[], 14);
  assert(real > 0, "a full window must produce a non-zero ATR");
});

Deno.test("a zero ATR collapses the stop floor to the static one", () => {
  // Reproduces bot-scanner's two-layer floor with the BTC numbers.
  const floor = (atr: number, pipSize: number, staticMin: number, mult: number) =>
    Math.max(staticMin, atr > 0 ? (atr * mult) / pipSize : 0);

  // BTC/USD, pipSize 1, MIN_SL_PIPS 150, ATR_SL_FLOOR_MULTIPLIER 1.5.
  assertEquals(floor(0, 1, 150, 1.5), 150, "unpopulated ATR gives the bare static floor");
  // A plausible BTC ATR of 600 points would have demanded 900.
  assertEquals(floor(600, 1, 150, 1.5), 900);
  // The stop that actually traded was 150 points inside a 1354-point zone.
  assert(150 < 900, "the ATR floor would have rejected that stop as too tight");
});

Deno.test("atrValue is returned from the analysis", () => {
  const ret = scoring.slice(scoring.lastIndexOf("  return {"));
  assert(/^\s*atrValue,$/m.test(ret), "atrValue must be in the returned object");
});

Deno.test("consumption goes through one gated value", () => {
  assert(
    /const atrForConsumers = \(pairConfig as any\)\.atrDerivedFloorsEnabled === true/.test(scanner),
    "there must be a single place that decides whether ATR is consumed",
  );
  assert(
    /\? \(\(analysis as any\)\.atrValue \?\? 0\)\s*\n\s*: 0;/.test(scanner),
    "off must resolve to the same zero every consumer has been seeing",
  );
});

Deno.test("no consumer reads analysis.atrValue directly any more", () => {
  // A stray direct read would switch that one behaviour on regardless of the
  // flag, which is exactly the failure this is guarding against.
  const strays = scanner.match(/atrValue: \(analysis as any\)\.atrValue/g) ?? [];
  assertEquals(strays.length, 0, "found an ungated consumer");
  assert(
    !/const zoneAtrVal = \(analysis as any\)\.atrValue/.test(scanner),
    "the zone-story floor must use the gated value",
  );
  assert(
    !/const atrVal = \(analysis as any\)\.atrValue/.test(scanner),
    "the real stop floor must use the gated value",
  );
});

Deno.test("Gate 18 no longer reads a field that does not exist", () => {
  // Match the dead call, not the word — the comment explaining the bug
  // legitimately names the field.
  assert(
    !/calculateATR\(analysis\._candles/.test(scanner),
    "the fallback through a field that never existed must be gone",
  );
  const i = scanner.indexOf("Gate 18");
  const block = scanner.slice(i, i + 900);
  assert(
    /atrDerivedFloorsEnabled === true/.test(block),
    "the gate must honour the flag, so it stays inert until ATR is trusted",
  );
});

Deno.test("the flag defaults off in the live mapper and bot-scanner agrees", () => {
  assert(/atrDerivedFloorsEnabled: false/.test(mapper), "RUNTIME_DEFAULTS entry missing");
  assert(
    /atrDerivedFloorsEnabled: strategy\.atrDerivedFloorsEnabled \?\? raw\.atrDerivedFloorsEnabled \?\? RUNTIME_DEFAULTS\.atrDerivedFloorsEnabled/.test(mapper),
    "must be mapped in configMapper",
  );
  const a = scanner.match(/^  atrDerivedFloorsEnabled: (\w+),/m);
  const b = mapper.match(/^  atrDerivedFloorsEnabled: (\w+),/m);
  assert(a && b, "missing from one defaults object");
  assertEquals(a[1], b[1]);
});

Deno.test("the measured value is exposed even while unconsumed", () => {
  // So the ATR the floors WOULD use is visible before anyone turns them on.
  assert(
    /\(analysis as any\)\.atrConsumed = atrForConsumers;/.test(scanner),
    "the resolved value should be attached for observability",
  );
});

Deno.test("the floor the flag WOULD impose is recorded while it is off", () => {
  // atrConsumed is 0 when the flag is off, so on its own it says nothing about
  // whether turning the flag on is safe. The unconsumed measurement is what
  // makes that decision answerable from data.
  const i = scanner.indexOf("const atrMeasured =");
  assert(i > -1, "the raw measurement must be taken");
  const block = scanner.slice(i, i + 700);
  for (const field of ["measured", "measuredPips", "floorPips", "staticFloorPips", "enabled"]) {
    assert(new RegExp(`${field}:`).test(block), `scan detail must carry ${field}`);
  }
  assert(
    /measured: atrMeasured/.test(block),
    "the recorded value must be the raw ATR, not the gated one",
  );
});

Deno.test("the recorded floor is comparable against the static floor", () => {
  // The question the data has to answer is 'would the ATR floor have been
  // BINDING?' — that needs both numbers side by side.
  const i = scanner.indexOf("const atrMeasured =");
  const block = scanner.slice(i, i + 700);
  assert(/ATR_SL_FLOOR_MULTIPLIER/.test(block), "must use the same multiplier the floor uses");
  assert(/MIN_SL_PIPS\[pair\]/.test(block), "must record the static floor it competes with");
});
