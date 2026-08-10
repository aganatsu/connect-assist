/**
 * exitEvaluation.test.ts — the shared SL/TP exit owner.
 *
 * Pins the behaviour that used to differ between backtest, the two paper paths
 * and live: wick detection, gap-through pricing, adverse-only slippage, and the
 * same-bar SL+TP tie-break.
 */

import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateExit, priceAsBar } from "../../functions/_shared/exitEvaluation.ts";

const PIP = 0.0001;
const LONG = {
  direction: "long" as const,
  stopLoss: 1.0950,
  takeProfit: 1.1100,
  pipSize: PIP,
};
const SHORT = {
  direction: "short" as const,
  stopLoss: 1.1050,
  takeProfit: 1.0900,
  pipSize: PIP,
};

Deno.test("evaluateExit — no breach returns no exit", () => {
  const d = evaluateExit({ open: 1.1000, high: 1.1020, low: 1.0980, close: 1.1010 }, LONG);
  assertEquals(d.hit, false);
  assertEquals(d.reason, null);
  assertEquals(d.exitPrice, null);
});

Deno.test("evaluateExit — long: wick through SL is a hit even when the bar closes above", () => {
  // This is the case the poll-based paper paths could not see.
  const d = evaluateExit({ open: 1.1000, high: 1.1010, low: 1.0940, close: 1.1005 }, LONG);
  assertEquals(d.hit, true);
  assertEquals(d.reason, "sl_hit");
});

Deno.test("evaluateExit — long: SL fill is gap-adjusted and worsened by slippage", () => {
  // Bar gapped to 1.0900, well through the 1.0950 stop.
  const d = evaluateExit({ open: 1.0960, high: 1.0965, low: 1.0900, close: 1.0910 }, LONG);
  // gapPrice = min(sl, low) = 1.0900, then -0.5 pip
  assertAlmostEquals(d.exitPrice!, 1.0900 - 0.5 * PIP, 1e-9);
});

Deno.test("evaluateExit — short: SL fill gaps upward and slippage worsens it", () => {
  const d = evaluateExit({ open: 1.1040, high: 1.1120, low: 1.1035, close: 1.1100 }, SHORT);
  assertEquals(d.reason, "sl_hit");
  assertAlmostEquals(d.exitPrice!, 1.1120 + 0.5 * PIP, 1e-9);
});

Deno.test("evaluateExit — TP fills exactly, with no positive slippage", () => {
  const d = evaluateExit({ open: 1.1050, high: 1.1150, low: 1.1040, close: 1.1120 }, LONG);
  assertEquals(d.reason, "tp_hit");
  assertEquals(d.exitPrice, 1.1100);
});

Deno.test("evaluateExit — same bar hits both: nearer-to-open wins", () => {
  // Open 1.0960 → SL (1.0950) is 10 pips away, TP (1.1100) is 140 away. SL wins.
  const slFirst = evaluateExit({ open: 1.0960, high: 1.1150, low: 1.0940, close: 1.1100 }, LONG);
  assertEquals(slFirst.reason, "sl_hit");
  assert(slFirst.ambiguousBar);

  // Open 1.1090 → TP (1.1100) is 10 pips away, SL (1.0950) is 140 away. TP wins.
  const tpFirst = evaluateExit({ open: 1.1090, high: 1.1150, low: 1.0940, close: 1.0960 }, LONG);
  assertEquals(tpFirst.reason, "tp_hit");
  assert(tpFirst.ambiguousBar);
});

Deno.test("evaluateExit — exact tie on an ambiguous bar resolves to SL, never a win", () => {
  // open sits exactly midway between SL and TP
  const mid = (LONG.stopLoss + LONG.takeProfit) / 2;
  const d = evaluateExit({ open: mid, high: 1.1150, low: 1.0940, close: mid }, LONG);
  assertEquals(d.reason, "sl_hit");
  assert(d.ambiguousBar);
});

Deno.test("evaluateExit — falls back to close when the bar has no open", () => {
  const d = evaluateExit({ high: 1.1150, low: 1.0940, close: 1.0955 }, LONG);
  assertEquals(d.reason, "sl_hit"); // close is nearer SL
  assert(d.ambiguousBar);
});

Deno.test("evaluateExit — slState renames the stop without changing the price", () => {
  const bar = { open: 1.0960, high: 1.0965, low: 1.0940, close: 1.0945 };
  const plain = evaluateExit(bar, LONG);
  const be = evaluateExit(bar, { ...LONG, slState: "be" });
  const trail = evaluateExit(bar, { ...LONG, slState: "trail" });
  assertEquals(plain.reason, "sl_hit");
  assertEquals(be.reason, "be_hit");
  assertEquals(trail.reason, "trail_hit");
  assertEquals(be.exitPrice, plain.exitPrice);
  assertEquals(trail.exitPrice, plain.exitPrice);
});

Deno.test("evaluateExit — missing SL or TP is skipped, not treated as zero", () => {
  const noSL = evaluateExit({ open: 1.0900, high: 1.0910, low: 1.0800, close: 1.0850 }, {
    ...LONG, stopLoss: null,
  });
  assertEquals(noSL.hit, false);

  const noTP = evaluateExit({ open: 1.1100, high: 1.1200, low: 1.1090, close: 1.1150 }, {
    ...LONG, takeProfit: null,
  });
  assertEquals(noTP.hit, false);
});

Deno.test("priceAsBar — degrades to point detection, matching the old poll behaviour", () => {
  // The wick case above is invisible to a point check — this documents the gap
  // that bot-scanner's bar-based re-check exists to close.
  const missed = evaluateExit(priceAsBar(1.1005), LONG);
  assertEquals(missed.hit, false);

  const caught = evaluateExit(priceAsBar(1.0940), LONG);
  assertEquals(caught.reason, "sl_hit");
  assertAlmostEquals(caught.exitPrice!, 1.0940 - 0.5 * PIP, 1e-9);
});

Deno.test("evaluateExit — the two paper paths now agree (regression: scanner skipped slippage)", () => {
  // bot-scanner previously filled at exactly `sl` while paper-trading applied
  // 0.5 pips. Same input must now produce the same exit price.
  const price = 1.0940;
  const paperTrading = evaluateExit(priceAsBar(price), { ...LONG, slippagePips: 0.5 });
  const scanner = evaluateExit(priceAsBar(price), LONG); // default slippage
  assertEquals(scanner.exitPrice, paperTrading.exitPrice);
  assert(scanner.exitPrice! < LONG.stopLoss, "fill must be worse than the stop, not exactly at it");
});
