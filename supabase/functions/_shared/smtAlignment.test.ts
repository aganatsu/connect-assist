import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectSMTDivergence } from "./smcAnalysis.ts";

/**
 * The previous implementation compared each series' Nth-from-last swing:
 *
 *   thisLows[thisLows.length - 1].price   vs   corrLows[corrLows.length - 1].price
 *
 * "Last" was counted independently per instrument, and SwingPoint.datetime and
 * .index were both unused. Correct while both pairs printed the same number of
 * swings; meaningless when one was choppier — which is exactly when divergence
 * is interesting. It feeds Gate 9b, a HARD veto, so a misaligned read refused
 * the trade rather than merely mis-scoring it.
 *
 * These tests pin the property that replaced it: the comparison is anchored on
 * TIME, so it cannot be fooled by one instrument printing more swings.
 */

type C = { datetime: string; open: number; high: number; low: number; close: number };

/** Bars on a 1h grid, so the two series share timestamps. */
function series(n: number, price: (i: number) => number, spread = 0.001, startHour = 0): C[] {
  return Array.from({ length: n }, (_, i) => {
    const p = price(i);
    const t = new Date(Date.UTC(2026, 0, 1, startHour + i)).toISOString().slice(0, 19);
    return { datetime: t, open: p, high: p + spread, low: p - spread, close: p };
  });
}

const FLAT = (p: number) => () => p;

Deno.test("one pair sweeps its prior low, the other holds → bullish SMT", () => {
  // 40 bars: first 20 flat, last 20 push lower on EUR only.
  const eur = [...series(20, FLAT(1.10)), ...series(20, i => 1.10 - (i + 1) * 0.001, 0.001, 20)];
  const gbp = [...series(20, FLAT(1.30)), ...series(20, FLAT(1.30), 0.001, 20)];
  const r = detectSMTDivergence("EUR/USD", eur, gbp);
  assertEquals(r.detected, true);
  assertEquals(r.type, "bullish");
  assertEquals(r.correlatedPair, "GBP/USD");
});

Deno.test("both sweeping is not divergence", () => {
  const eur = [...series(20, FLAT(1.10)), ...series(20, i => 1.10 - (i + 1) * 0.001, 0.001, 20)];
  const gbp = [...series(20, FLAT(1.30)), ...series(20, i => 1.30 - (i + 1) * 0.001, 0.001, 20)];
  assertEquals(detectSMTDivergence("EUR/USD", eur, gbp).detected, false);
});

Deno.test("a choppier partner no longer breaks the comparison", () => {
  // THE REGRESSION THIS EXISTS FOR. GBP oscillates hard, so under the old
  // ordinal logic it printed far more swings and "last swing low" pointed at a
  // different moment than EUR's. Its range is stable, so there is no sweep and
  // no divergence — the verdict must come from the prices in the window, not
  // from how many wiggles each side made.
  const eur = [...series(20, FLAT(1.10)), ...series(20, FLAT(1.10), 0.001, 20)];
  const gbp = [
    ...series(20, i => 1.30 + (i % 2 ? 0.004 : -0.004)),
    ...series(20, i => 1.30 + (i % 2 ? 0.004 : -0.004), 0.001, 20),
  ];
  const r = detectSMTDivergence("EUR/USD", eur, gbp);
  assertEquals(r.detected, false, r.detail);
});

Deno.test("bars are matched by timestamp, not array position", () => {
  // The partner is shifted a day later, so nothing lines up. Under index-based
  // comparison it would still produce a verdict from whatever sat at the same
  // offsets. It must refuse instead.
  const eur = [...series(20, FLAT(1.10)), ...series(20, i => 1.10 - (i + 1) * 0.001, 0.001, 20)];
  const gbpShifted = [...series(20, FLAT(1.30), 0.001, 100), ...series(20, FLAT(1.30), 0.001, 120)];
  const r = detectSMTDivergence("EUR/USD", eur, gbpShifted);
  assertEquals(r.detected, false);
  assert(/cannot compare/.test(r.detail), r.detail);
});

Deno.test("partial overlap is tolerated, total mismatch is not", () => {
  // A few missing bars on one provider should not silence the signal.
  const eur = [...series(20, FLAT(1.10)), ...series(20, i => 1.10 - (i + 1) * 0.001, 0.001, 20)];
  const gbpGappy = [...series(20, FLAT(1.30)), ...series(20, FLAT(1.30), 0.001, 20)]
    .filter((_, i) => i % 7 !== 0);          // ~14% of bars missing
  const r = detectSMTDivergence("EUR/USD", eur, gbpGappy);
  assertEquals(r.detected, true, r.detail);
});

Deno.test("cannot-tell reads as not-detected, never as a veto", () => {
  // Gate 9b refuses the trade on an explicit opposite reading. Anything
  // uncertain must come back detected:false, or missing data starts cancelling
  // setups.
  const eur = series(40, FLAT(1.10));
  for (const partner of [[] as C[], series(5, FLAT(1.30))]) {
    const r = detectSMTDivergence("EUR/USD", eur, partner);
    assertEquals(r.detected, false);
    assertEquals(r.type, null);
  }
  // Unmapped symbol too.
  assertEquals(detectSMTDivergence("US30", eur, eur).detected, false);
});

Deno.test("the correlation map is all positively correlated pairs", () => {
  // The logic assumes partners move together — a lower low on one and not the
  // other is the signal. An inverse pair such as EUR/USD vs USD/CHF would
  // invert the meaning and report divergence on normal behaviour.
  const src = Deno.readTextFileSync(new URL("./smcAnalysis.ts", import.meta.url));
  const block = src.slice(src.indexOf("export const SMT_PAIRS"), src.indexOf("export const ASSET_PROFILES"));
  for (const inverse of ['"EUR/USD": "USD/CHF"', '"GBP/USD": "USD/JPY"', '"EUR/USD": "DXY"']) {
    assert(!block.includes(inverse), `${inverse} is inversely correlated and would invert the signal`);
  }
  assert(block.includes('"EUR/USD": "GBP/USD"') && block.includes('"XAU/USD": "XAG/USD"'));
});

Deno.test("the hard veto still keys off the scoring factor, not this detail", () => {
  // Gate 9b matches confluenceScoring's phrase "opposite to signal direction",
  // which is built from smtResult.type and the trade direction — not from the
  // detail strings rewritten here. Worth pinning: if it ever read this detail,
  // rewording a message would silently disable the veto.
  const scoring = Deno.readTextFileSync(new URL("./confluenceScoring.ts", import.meta.url));
  assert(/opposite to signal direction/.test(scoring), "the phrase lives in confluenceScoring");
  const smc = Deno.readTextFileSync(new URL("./smcAnalysis.ts", import.meta.url));
  assert(!/opposite to signal direction/.test(smc), "and must not be produced here");
});
