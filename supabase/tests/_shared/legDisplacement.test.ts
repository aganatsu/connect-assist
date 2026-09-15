import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { measureLegDisplacement } from "../../functions/_shared/impulseZoneEngine.ts";

/**
 * impulseZoneEngine defines an impulse structurally — swing origin to BOS — and
 * contains ZERO references to displacement. So a three-week grind that clips a
 * swing high produces the same leg, the same dealing range, the same Fib levels
 * and the same zone score as a two-candle expansion.
 *
 * That is strange in a system that already prices displacement twice:
 *   confluenceScoring:490   order block with displacement 2.0 pts, without 0.75
 *   confluenceScoring:2355  FVG without displacement demoted out of Tier 1,
 *                           "without displacement, an FVG is just a random gap"
 *
 * This measures the leg so the two cases are distinguishable. It is
 * OBSERVATIONAL — nothing gates on it. The point is to be able to answer "do
 * low-displacement legs underperform?" from recorded data instead of assuming
 * it from theory, which is what the confirmation hunt taught: it was
 * theoretically sound and produced zero fills in the system's history.
 */

type C = { open: number; high: number; low: number; close: number; time?: string };

/** Quiet candles: small bodies, wide-ish wicks — the baseline to measure against. */
function calm(n: number, price = 100): C[] {
  return Array.from({ length: n }, (_, i) => ({
    open: price + (i % 2 ? 0.02 : -0.02),
    close: price + (i % 2 ? -0.02 : 0.02),
    high: price + 0.15,
    low: price - 0.15,
  }));
}

/** Big full-bodied candles in one direction. */
function expansion(n: number, from: number, step: number): C[] {
  return Array.from({ length: n }, (_, i) => {
    const o = from + i * step;
    const c = o + step;
    return { open: o, close: c, high: c + 0.01, low: o - 0.01 };
  });
}

/** Same total distance, spread over many small candles. */
function grind(n: number, from: number, total: number): C[] {
  const step = total / n;
  return Array.from({ length: n }, (_, i) => {
    const o = from + i * step;
    const c = o + step;
    return { open: o, close: c, high: c + 0.12, low: o - 0.12 };
  });
}

Deno.test("an expansion leg and a grind of equal size are told apart", () => {
  const base = calm(20);
  const fast = [...base, ...expansion(4, 100, 1.5)];
  const slow = [...base, ...grind(40, 100, 6)];

  const f = measureLegDisplacement(fast, 20, fast.length - 1)!;
  const s = measureLegDisplacement(slow, 20, slow.length - 1)!;

  assert(f, "expansion measured");
  assert(s, "grind measured");
  // Both cover 6.0 of price. Only one did it with force.
  assert(f.maxRangeMultiple > s.maxRangeMultiple,
    `expansion ${f.maxRangeMultiple} should exceed grind ${s.maxRangeMultiple}`);
  assert(f.avgBodyRatio > s.avgBodyRatio,
    `expansion bodies ${f.avgBodyRatio} should exceed grind ${s.avgBodyRatio}`);
  assert(f.rangePerBar > s.rangePerBar, "expansion covers more ground per bar");
  assertEquals(f.strength, "strong");
  assertEquals(s.strength, "weak");
});

Deno.test("the baseline excludes the leg itself", () => {
  // A trailing window containing the leg lets a big move raise the average it
  // is compared against, so the more violent the displacement the more ordinary
  // it looks. The baseline must be the candles BEFORE the leg.
  const base = calm(20);
  const short = [...base, ...expansion(3, 100, 1.5)];
  const long = [...base, ...expansion(30, 100, 1.5)];

  const a = measureLegDisplacement(short, 20, short.length - 1)!;
  const b = measureLegDisplacement(long, 20, long.length - 1)!;
  // Same candle shape in both; a longer run of them must not dilute the reading.
  assertEquals(a.strength, b.strength);
  assert(Math.abs(a.maxRangeMultiple - b.maxRangeMultiple) < 0.5,
    `range multiple should not drift with leg length: ${a.maxRangeMultiple} vs ${b.maxRangeMultiple}`);
});

Deno.test("returns undefined rather than a misleading zero when history is thin", () => {
  // Fewer than 5 prior candles is not a baseline. Reporting 0% body ratio would
  // read as "no displacement" when the truth is "not measurable".
  const c = [...calm(3), ...expansion(4, 100, 1.5)];
  assertEquals(measureLegDisplacement(c, 3, c.length - 1), undefined);
  assertEquals(measureLegDisplacement(calm(30), 25, 20), undefined, "inverted range");
});

Deno.test("flat candles cannot produce a divide-by-zero", () => {
  const flat: C[] = Array.from({ length: 30 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
  assertEquals(measureLegDisplacement(flat, 20, 29), undefined, "zero-range baseline");
});

Deno.test("displacement bar counting matches smcAnalysis's definition", () => {
  // Both detectors must agree on what a displacement candle is, or the zone
  // score and the leg reading will contradict each other on the same chart.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  const smc = Deno.readTextFileSync(
    new URL("../../functions/_shared/smcAnalysis.ts", import.meta.url),
  );
  const cond = /bodyMultiple >= 2\.0 && bodyRatio >= 0\.7 && rangeMultiple >= 1\.5/;
  assert(cond.test(smc.replace(/\s+/g, " ")), "smcAnalysis thresholds unchanged");
  assert(/body \/ avgBody >= 2\.0 && bodyRatio >= 0\.7 && rangeMultiple >= 1\.5/
    .test(src.replace(/\s+/g, " ")), "leg measurement uses the same bar");
});

Deno.test("nothing gates on it", () => {
  // The moment this becomes a filter it changes which trades happen, and the
  // Era C freeze says execution plumbing only until ~40 trades.
  const engine = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  assert(!/if \([^)]*displacement\.strength/.test(engine),
    "the engine must not branch on leg displacement");
  assert(!/impulse\.displacement[^;]*(?:continue|rejected|return null)/.test(scanner),
    "the scanner must not reject on leg displacement");
  assert(/OBSERVATIONAL ONLY/.test(engine), "say so where it is defined");
});

Deno.test("the measurement is persisted, not just displayed", () => {
  // PR #530 showed displacement in the Zone Story but wrote it nowhere, so the
  // panel could display a number that no query could ever group trades by.
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  assert(
    /leg_displacement: \(detail as any\)\.unifiedZone\?\.impulse\?\.displacement \?\? null,/.test(scanner),
    "written onto trade_reasonings at the entry path",
  );
  // It must NOT go into factors_json: that column is an array and
  // bot-weekly-advisor iterates it, so an object nested there breaks silently.
  const advisor = Deno.readTextFileSync(
    new URL("../../functions/bot-weekly-advisor/index.ts", import.meta.url),
  );
  assert(/for \(const f of r\.factors_json\)/.test(advisor),
    "the advisor still iterates factors_json as an array");
  assert(!/factors_json: \{/.test(scanner), "factors_json must stay an array");
});

Deno.test("the column exists and the join key is on both tables", () => {
  const mig = Deno.readTextFileSync(
    new URL("../../migrations/20260915060000_trade_reasonings_leg_displacement.sql", import.meta.url),
  );
  assert(/ADD COLUMN IF NOT EXISTS leg_displacement jsonb/.test(mig));
  const base = Deno.readTextFileSync(
    new URL("../../migrations/20260914000000_baseline_schema.sql", import.meta.url),
  );
  // The analysis query joins on position_id, so both tables must carry it.
  for (const t of ["trade_reasonings", "paper_trade_history"]) {
    const block = base.slice(
      base.indexOf(`CREATE TABLE IF NOT EXISTS public.${t} (`),
      base.indexOf(");", base.indexOf(`CREATE TABLE IF NOT EXISTS public.${t} (`)),
    );
    assert(/position_id text NOT NULL/.test(block), `${t}.position_id must exist for the join`);
  }
});

// ─── Plotting detail ─────────────────────────────────────────────────────────

import { impulseFibLevels } from "../../functions/_shared/impulseZoneEngine.ts";

Deno.test("bearish fib levels sit above the low, bullish below the high", () => {
  // A retracement travels back toward the leg's origin. Computing both
  // directions the same way would put every bearish level on the wrong side of
  // the leg — below the low, where price has already been.
  const bull = impulseFibLevels(1.35058, 1.34647, "bullish");
  const bear = impulseFibLevels(1.35058, 1.34647, "bearish");

  const f618bull = bull.find(f => f.level === 0.618)!;
  const f618bear = bear.find(f => f.level === 0.618)!;

  assert(f618bull.price < 1.35058 && f618bull.price > 1.34647,
    "bullish 61.8% retraces down from the high");
  assert(f618bear.price > 1.34647 && f618bear.price < 1.35058,
    "bearish 61.8% retraces up from the low");
  // They are mirror images about the midpoint.
  const mid = (1.35058 + 1.34647) / 2;
  assert(Math.abs((f618bull.price - mid) + (f618bear.price - mid)) < 1e-9,
    "the two directions mirror each other");
});

Deno.test("a zero-range leg yields no levels rather than a flat grid", () => {
  assertEquals(impulseFibLevels(1.5, 1.5, "bullish"), []);
  assertEquals(impulseFibLevels(1.0, 1.5, "bearish"), [], "inverted high/low");
});

Deno.test("the full candle time is kept, not truncated to a date", () => {
  // .slice(0, 10) threw the time away, so a 1H leg spanning two dates could not
  // be located on a chart — which is the whole point of plotting it.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  assert(/impulse\.startTime = startCandle\.datetime;/.test(src), "start time kept whole");
  assert(/impulse\.endTime = endCandle\.datetime;/.test(src), "end time kept whole");
  assert(/impulse\.startDate = startCandle\.datetime\.slice\(0, 10\);/.test(src),
    "the date is still populated for anything already reading it");
});

Deno.test("the panel describes the move in travel order", () => {
  // It printed low -> high for every leg, so a bearish impulse read backwards:
  // 1.34647 -> 1.35058 when price actually went 1.35058 -> 1.34647.
  const panel = Deno.readTextFileSync(
    new URL("../../../src/components/ZoneStoryPanel.tsx", import.meta.url),
  );
  assert(!/\{fmt\(unifiedData\.impulse\.low\)\} → \{fmt\(unifiedData\.impulse\.high\)\}/.test(panel),
    "the unconditional low -> high render must be gone");
  assert(/unifiedData\.impulse\.origin/.test(panel) && /unifiedData\.impulse\.terminus/.test(panel),
    "renders origin -> terminus");
});

Deno.test("bar timestamps are formatted without being moved", () => {
  // new Date(iso).toLocaleString() renders in the BROWSER's timezone, so the
  // same bar would read differently depending on where the dashboard is open.
  // That is the shape of the TwelveData bug — a "Z" that was never UTC — and
  // the panel exists to tell the truth about a setup.
  const panel = Deno.readTextFileSync(
    new URL("../../../src/components/ZoneStoryPanel.tsx", import.meta.url),
  );
  const fmt = panel.slice(panel.indexOf("function fmtBarTime"), panel.indexOf("function sameDay"));
  assert(!/new Date\(/.test(fmt), "must not construct a Date — that converts to local time");
  assert(!/toLocaleString|toLocaleDateString|toLocaleTimeString/.test(fmt),
    "must not use locale formatting");
  assert(/UTC/.test(panel), "the timezone is stated rather than implied");
  assert(/Daily and Weekly bars are stamped 00:00/.test(panel),
    "explains why D/W drop the time");
});

// ─── Origin / BOS candle closes ──────────────────────────────────────────────

import { measureLegCandles } from "../../functions/_shared/impulseZoneEngine.ts";

Deno.test("close strength is normalised by direction", () => {
  // A bullish break closing at its high and a bearish break closing at its low
  // are equally strong. Reporting raw close position would call one 1.0 and the
  // other 0.0 for identical conviction.
  const strongBull = [{ open: 10, high: 12, low: 10, close: 12 }];
  const strongBear = [{ open: 12, high: 12, low: 10, close: 10 }];
  assertEquals(measureLegCandles(strongBull, 0, 0, "bullish")!.bosCloseStrength, 1);
  assertEquals(measureLegCandles(strongBear, 0, 0, "bearish")!.bosCloseStrength, 1);
});

Deno.test("a break that closed back where it started reads as rejected", () => {
  // Pushed to 12, closed at 10.2 — on the timeframe below this is a break that
  // already failed. It is the case the HTF close hides.
  const rejected = [{ open: 10, high: 12, low: 10, close: 10.2 }];
  const q = measureLegCandles(rejected, 0, 0, "bullish")!;
  assert(q.bosCloseStrength < 0.15, `expected weak close, got ${q.bosCloseStrength}`);
  assert(q.bosRejectionWick > 0.8, `expected a large rejection wick, got ${q.bosRejectionWick}`);
});

Deno.test("a doji is neither strong nor rejected", () => {
  const flat = [{ open: 10, high: 10, low: 10, close: 10 }];
  assertEquals(measureLegCandles(flat, 0, 0, "bullish")!.bosCloseStrength, 0.5);
  assertEquals(measureLegCandles(flat, 0, 0, "bullish")!.bosRejectionWick, 0);
});

Deno.test("origin and BOS are measured separately", () => {
  // The leg can start from a decisive candle and end on a weak one, or vice
  // versa, and those mean different things.
  const c = [
    { open: 10, high: 12, low: 10, close: 12 },   // origin: decisive
    { open: 12, high: 12, low: 11, close: 11.9 },
    { open: 12, high: 14, low: 12, close: 12.2 }, // BOS: rejected
  ];
  const q = measureLegCandles(c, 0, 2, "bullish")!;
  assertEquals(q.originCloseStrength, 1);
  assert(q.bosCloseStrength < 0.2, "the BOS candle was rejected");
});

Deno.test("it is honest about being a proxy, and gates nothing", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  assert(/It is a PROXY, not a real LTF read/.test(src),
    "the limitation is stated where it is defined");
  assert(/OBSERVATIONAL\. Nothing gates on it\./.test(src));
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  assert(!/candleQuality[^;]*(?:continue|rejected)/.test(scanner),
    "the scanner must not reject on it");
});

// ─── Leg sequence ────────────────────────────────────────────────────────────

Deno.test("selection behaviour is unchanged — only observation was added", () => {
  // The risk in touching this loop is silently changing WHICH leg is chosen.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  // Still the most recent valid same-direction break, first hit wins.
  assert(/\.filter\(b => b\.type === direction\)/.test(src), "selection still direction-filtered");
  assert(/\.sort\(\(a, b\) => b\.index - a\.index\)/.test(src), "still most-recent-first");
  assert(/if \(!impulse \|\| !impulse\.isValid\) \{ rejectedBefore\+\+; continue; \}/.test(src),
    "invalid legs still skipped, now counted");
});

Deno.test("opposing breaks are kept for observation but excluded from selection", () => {
  // Filtering them out before anything looked was why "the prior leg was
  // contradicted" could not be known. They must inform the sequence without
  // becoming selectable.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  assert(/const opposingBreaks = everyBreak\.filter\(b => b\.type !== direction\);/.test(src));
  assert(!/for \(const \[attempt, bos\] of opposingBreaks/.test(src),
    "opposing breaks must never be iterated as candidates");
});

Deno.test("position distinguishes continuation from first-after-reversal", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  // An opposing break BETWEEN the prior same-direction break and this one is
  // what makes this leg a fresh start rather than a continuation.
  assert(/b\.index > priorBos\.index && b\.index < bos\.index/.test(src),
    "the window is between the two same-direction breaks, not all of history");
  assert(/!priorBos \? "only"/.test(src), "no prior leg is its own case, not a continuation");
});

Deno.test("displacement trend is null rather than guessed when either side is unmeasurable", () => {
  // measureLegDisplacement returns undefined on thin history. Ranking that as
  // 0 and calling it "weakening" would invent a signal.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  assert(/\(a === 0 \|\| b === 0\)\s*\n?\s*\? null/.test(src.replace(/\s+/g, m => m.includes("\n") ? "\n" : " ")) ||
         /a === 0 \|\| b === 0/.test(src), "unmeasurable means null");
});

Deno.test("it appears in the What's Active tab as observational", () => {
  // The whole point of that tab is that measured-but-unused things are visible
  // as such. A new measurement that skips it recreates the problem.
  const panel = Deno.readTextFileSync(
    new URL("../../../src/components/SignalStatusPanel.tsx", import.meta.url),
  );
  assert(/Impulse leg sequence/.test(panel), "listed");
  const entry = panel.slice(panel.indexOf("Impulse leg sequence"), panel.indexOf("Blocked retracements"));
  assert(/observationalOnly: true/.test(entry), "and marked observational");
  assert(/waitingFor:/.test(entry), "with what would settle it");
});

Deno.test("nothing gates on the sequence", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  assert(!/if \([^)]*sequence\.(position|displacementTrend)/.test(src));
  assert(!/sequence[^;]*(?:continue;|rejected)/.test(scanner));
});
