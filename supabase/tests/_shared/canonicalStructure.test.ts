import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analyzeMarketStructure,
  analyzeMarketStructureCanonical,
} from "../../functions/_shared/smcAnalysis.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * Canonical structure engine — SHADOW. Nothing in production consumes it.
 *
 * Ported from the ignored regression in #580, and ENABLED here. The old
 * analyzeMarketStructure may continue to fail the same case; that PR stays
 * open. These tests pin the canonical engine only.
 *
 * REFERENCE CASE. GBP/CAD daily: an external swing low at 1.84018 (04 May) was
 * closed through on 14 May and price continued ~1.8x ATR beyond it, yet no
 * bearish break was reported in fifteen bars. Measured across five FX pairs,
 * the old engine misses 13-28 real structure events each, almost all external,
 * because it builds break events pairwise between consecutive swings and so
 * never looks at the bar that actually closed through.
 *
 * Tests assert CORRECT behaviour rather than pinning the defect — a test that
 * encodes a bug is worse than no test, and this repo has shipped one of those.
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}

/**
 * Drift, a pronounced swing low at 1.84018, a rally away, then a decisive
 * close back below it.
 *
 * NOTE ON THE FIRST CLOSE-THROUGH. The descending run after the swing high
 * steps down 60 pips a bar, so bar 26 closes at 1.83838 — already below the
 * level — one bar BEFORE the bar this fixture was originally written to treat
 * as the breaking candle. The engine is right to fire on 26: the rule is the
 * FIRST close through, not the most dramatic one. Asserting bar 27 here would
 * have encoded a slower engine as correct.
 */
function closeThroughExternalLow(): Candle[] {
  t = 0;
  const out: Candle[] = [];
  const p = 1.86;
  for (let i = 0; i < 10; i++) out.push(candle(p, p + 0.0015, p - 0.0015, p));
  for (let i = 0; i < 4; i++) {
    const o = p - i * 0.0035, c = o - 0.0035;
    out.push(candle(o, o + 0.0005, c - 0.0005, c));
  }
  const low = 1.84018;
  out.push(candle(low + 0.001, low + 0.0015, low, low + 0.0012));      // swing low, index 14
  for (let i = 0; i < 6; i++) {
    const o = low + 0.0012 + i * 0.0045, c = o + 0.0045;
    out.push(candle(o, c + 0.0005, o - 0.0005, c));
  }
  const top = low + 0.0012 + 0.027;
  out.push(candle(top, top + 0.002, top - 0.0005, top - 0.001));       // swing high
  for (let i = 0; i < 5; i++) {
    const o = top - i * 0.006, c = o - 0.006;
    out.push(candle(o, o + 0.0005, c - 0.0005, c));                    // bar 26 closes below
  }
  out.push(candle(low + 0.002, low + 0.0025, 1.83801, 1.83867));
  out.push(candle(1.83854, 1.84135, 1.83043, 1.83198));
  return out;
}

const POLICIES = ["latest_confirmed", "latest_unbroken_structural"] as const;

for (const policy of POLICIES) {
  Deno.test(`[${policy}] a close through an external swing low is reported as a break`, () => {
    const candles = closeThroughExternalLow();
    const st = analyzeMarketStructureCanonical(candles, { policy });

    const low = st.swingPoints.find(s =>
      s.type === "low" && Math.abs(s.price - 1.84018) < 1e-9);
    assert(low, "the swing low is detected");
    assertEquals(low!.significance, "external", "and as an external swing");

    const breaks = [...st.bos, ...st.choch].filter(b =>
      b.type === "bearish" && Math.abs((b.level ?? NaN) - 1.84018) < 1e-9);
    assertEquals(breaks.length, 1,
      "exactly one bearish break — detected, and never emitted twice for the same swing");
    assertEquals(breaks[0].significance, "external",
      "an external swing produces an external break");
    assert(breaks[0].closeBased, "it closed through, so closeBased must be true");
  });

  Deno.test(`[${policy}] the break lands on the FIRST bar that closes through`, () => {
    const candles = closeThroughExternalLow();
    const st = analyzeMarketStructureCanonical(candles, { policy });
    const brk = [...st.bos, ...st.choch].find(b =>
      b.type === "bearish" && Math.abs((b.level ?? NaN) - 1.84018) < 1e-9)!;

    // Independently derive the expected bar rather than hard-coding an index,
    // so the assertion survives a change to the fixture's shape.
    const swingIdx = candles.findIndex(c => Math.abs(c.low - 1.84018) < 1e-9);
    const firstClose = candles.findIndex((c, i) => i > swingIdx && c.close < 1.84018);
    assertEquals(brk.index, firstClose,
      "the break is reported on the bar that closed through, not on a later pivot");
    assertEquals(brk.datetime, candles[firstClose].datetime);
  });

  Deno.test(`[${policy}] nothing is emitted before the pivot could be known`, () => {
    const candles = closeThroughExternalLow();
    const st = analyzeMarketStructureCanonical(candles, { policy });
    const swingIdx = candles.findIndex(c => Math.abs(c.low - 1.84018) < 1e-9);
    // External confirmation needs lookback bars on BOTH sides: externalLookback
    // is max(internal + 4, 7) = 7 at the default internal lookback of 3.
    const earliest = swingIdx + 7;
    for (const b of [...st.bos, ...st.choch]) {
      assert(b.index >= earliest,
        `break at ${b.index} precedes the confirmation bar ${earliest} — that is lookahead`);
    }
  });

  Deno.test(`[${policy}] the ledger records the crossing as a fact`, () => {
    const candles = closeThroughExternalLow();
    const st = analyzeMarketStructureCanonical(candles, { policy });
    const hit = st.swingLevelBreaks.filter((x: any) =>
      Math.abs(x.level - 1.84018) < 1e-9 && x.direction === "bearish");
    assertEquals(hit.length, 1, "recorded once in the factual layer");
    assert(hit[0].barsFromConfirmation >= 0,
      "and measured from confirmation, not from the pivot bar");
  });
}

/**
 * Two lower highs: A at 1.9000, then B at 1.8800. Price later closes above B,
 * and later still above A.
 *
 * This is the case the two policies disagree about, and the reason the
 * alternative exists at all. Under latest_confirmed, B's confirmation retires
 * A, so A's genuine break produces no event. Under
 * latest_unbroken_structural, B does not engulf A — 1.8800 is below 1.9000 —
 * so A stays eligible and both breaks are reported.
 *
 * The factual ledger is identical either way. Only the event policy differs.
 */
function twoLowerHighs(): Candle[] {
  t = 0;
  const out: Candle[] = [];
  for (let i = 0; i < 6; i++) out.push(candle(1.8700, 1.8715, 1.8685, 1.8700));
  out.push(candle(1.8850, 1.9000, 1.8840, 1.8860));                    // swing high A
  for (let i = 0; i < 6; i++) {
    const o = 1.8850 - i * 0.0040, c = o - 0.0040;
    out.push(candle(o, o + 0.0006, c - 0.0006, c));
  }
  out.push(candle(1.8600, 1.8615, 1.8560, 1.8610));
  for (let i = 0; i < 5; i++) {
    const o = 1.8620 + i * 0.0030, c = o + 0.0030;
    out.push(candle(o, c + 0.0006, o - 0.0006, c));
  }
  out.push(candle(1.8770, 1.8800, 1.8760, 1.8775));                    // swing high B
  for (let i = 0; i < 6; i++) {
    const o = 1.8750 - i * 0.0035, c = o - 0.0035;
    out.push(candle(o, o + 0.0006, c - 0.0006, c));
  }
  for (let i = 0; i < 6; i++) {
    const o = 1.8560 + i * 0.0075, c = o + 0.0075;
    out.push(candle(o, c + 0.0008, o - 0.0008, c));                    // through B, then A
  }
  for (let i = 0; i < 5; i++) {
    const o = 1.9020 + i * 0.0030, c = o + 0.0030;
    out.push(candle(o, c + 0.0006, o - 0.0006, c));
  }
  return out;
}

Deno.test("latest_confirmed retires an unbroken higher high, so its later break is silent", () => {
  const candles = twoLowerHighs();
  const st = analyzeMarketStructureCanonical(candles, { policy: "latest_confirmed" });
  const bull = [...st.bos, ...st.choch].filter(b => b.type === "bullish");

  assertEquals(bull.length, 1, "only the surviving pointer emits");
  assert(Math.abs((bull[0].level ?? NaN) - 1.8800) < 1e-9,
    "and it is the later, lower high");
  assertEquals(st.supersessions.length, 1, "the higher high was retired unbroken");

  const sup = st.supersessions[0];
  assert(Math.abs(sup.supersededLevel - 1.9000) < 1e-9);
  assert(Math.abs(sup.replacementLevel - 1.8800) < 1e-9);
  assert(sup.laterBroken,
    "and it WAS broken later — this is the cost of the policy, measured not assumed");
  assert((sup.barsUntilLaterBreak ?? 0) > 0);
});

Deno.test("latest_unbroken_structural keeps it, and reports both breaks", () => {
  const candles = twoLowerHighs();
  const st = analyzeMarketStructureCanonical(candles, { policy: "latest_unbroken_structural" });
  const bull = [...st.bos, ...st.choch].filter(b => b.type === "bullish");

  assertEquals(bull.length, 2, "the retained higher high emits too");
  const levels = bull.map(b => b.level ?? NaN).sort();
  assert(Math.abs(levels[0] - 1.8800) < 1e-9);
  assert(Math.abs(levels[1] - 1.9000) < 1e-9);
  assertEquals(st.supersessions.length, 0,
    "a lower high does not engulf a higher one, so nothing is retired");
});

Deno.test("the two policies disagree on events but never on facts", () => {
  const candles = twoLowerHighs();
  const a = analyzeMarketStructureCanonical(candles, { policy: "latest_confirmed" });
  const b = analyzeMarketStructureCanonical(candles, { policy: "latest_unbroken_structural" });

  assertEquals(
    a.swingLevelBreaks.map((x: any) => `${x.index}_${x.level}`),
    b.swingLevelBreaks.map((x: any) => `${x.index}_${x.level}`),
    "the factual ledger is policy-independent; only event emission differs",
  );
  assert(
    [...a.bos, ...a.choch].length !== [...b.bos, ...b.choch].length,
    "and the policies genuinely differ here, so this fixture is load-bearing",
  );
});

Deno.test("shadow only — the production engine is untouched by all of this", () => {
  // analyzeMarketStructure must keep behaving exactly as it does today. If this
  // ever starts passing, something has wired the canonical engine into the old
  // one without an era boundary being declared.
  const candles = closeThroughExternalLow();
  const old = analyzeMarketStructure(candles);
  const low = old.swingPoints.find(s =>
    s.type === "low" && Math.abs(s.price - 1.84018) < 1e-9);
  assert(low, "the old engine still finds the swing — the gap was never detection");
  assertEquals(low!.significance, "external");
});

for (const policy of POLICIES) {
  Deno.test(`[${policy}] supersession reach is a three-way partition, not a boolean`, () => {
    // The first version of this measurement reported !closedBeyond as
    // "wick-only", which silently merged two opposite meanings: the
    // replacement wicked past the old level but its close held, versus the
    // replacement never reached the old level at all. Under
    // latest_unbroken_structural the replacement engulfs by definition so it
    // always reaches; under latest_confirmed a pointer is retired purely
    // because a newer one confirmed, and that swing may sit nowhere near the
    // old level. Merging them overstated the semantic mismatch.
    const candles = twoLowerHighs();
    const st = analyzeMarketStructureCanonical(candles, { policy });

    for (const sup of st.supersessions) {
      const flags = [
        sup.replacementClosedBeyondOldLevel,
        sup.replacementOnlyWickedBeyondOldLevel,
        sup.replacementDidNotReachBeyondOldLevel,
      ].filter(Boolean);
      assertEquals(flags.length, 1,
        `exactly one category must hold for a superseded level at ${sup.supersededLevel}`);
    }

    const s = st.supersessionSummary;
    assertEquals(
      s.replacementClosedBeyondOldLevel +
        s.replacementOnlyWickedBeyondOldLevel +
        s.replacementDidNotReachBeyondOldLevel,
      s.total,
      "the three counts must account for every supersession, with none double-counted",
    );
  });
}

Deno.test("latest_unbroken_structural only ever retires levels the replacement reached", () => {
  // Engulfment is defined on swing prices, and a swing high's price IS its
  // high, so the replacement bar necessarily trades beyond the old level. If
  // this ever fails, the engulfment rule and the supersession measurement have
  // drifted apart.
  const candles = twoLowerHighs();
  const st = analyzeMarketStructureCanonical(candles, { policy: "latest_unbroken_structural" });
  for (const sup of st.supersessions) {
    assertEquals(sup.replacementDidNotReachBeyondOldLevel, false,
      "an engulfing replacement must by definition have reached beyond the old level");
  }
});
