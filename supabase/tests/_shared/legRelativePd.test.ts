import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The P/D gate does not measure premium/discount against a dealing range.
 *
 * calculatePremiumDiscount (smcAnalysis ~2213) takes the MAX of the last 5
 * swing highs and the MIN of the last 5 swing lows. Those two points need not
 * be adjacent, need not belong to the same move, and have no order in time.
 * It is a bounding box around recent pivots. A bullish impulse and a bearish
 * one covering the same prices produce an identical box, because it has no
 * direction — and a dealing range is defined by its direction.
 *
 * The impulse zone engine already measures against the actual leg
 * (impulseZoneEngine ~441), direction-aware, and the two can disagree. The
 * observed failure: in a trend the box keeps stale highs while price makes
 * lower lows, so it reads "discount" for the whole move and refuses every
 * continuation short.
 *
 * Measured 2026-09-10 across 36 Era C trades where both were recoverable:
 *
 *   box and leg AGREE      31 trades   45.2% win   +$1,274.58
 *   box yes, leg no         2 trades    0.0% win     -$762.04
 *   box no, leg yes         3 trades   33.3% win      -$48.41
 *
 * They agree 86% of the time. The 5 disagreements lean toward the leg, but
 * n=5 decides nothing, and the box gate's strongest evidence is on REJECTED
 * setups (0 wins in 26 sole-gate refusals) where the leg could not be
 * reconstructed at all.
 *
 * So this changes NO gate behaviour. It records the leg figure on scans,
 * trades and rejected setups so both sides accumulate and the question can be
 * settled with data instead of theory.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** Position within the impulse leg, mirroring the scanner. */
const legPct = (price: number, low: number, high: number) =>
  Math.round(((price - low) / (high - low)) * 1000) / 10;

Deno.test("the leg measure is position within the impulse, not a box", () => {
  // Impulse 100 -> 200. Halfway back is equilibrium regardless of direction.
  assertEquals(legPct(150, 100, 200), 50);
  assertEquals(legPct(120, 100, 200), 20);   // deep discount of the leg
  assertEquals(legPct(180, 100, 200), 80);   // deep premium of the leg
});

Deno.test("it can disagree with a box that spans more than one leg", () => {
  // A leg from 76500 to 77500, but the trailing box also holds an older high
  // at 79000. Price at 76840 is 34% of the box and 34% of the leg here —
  // the divergence appears once the box reaches beyond the current move.
  const price = 76840;
  assertEquals(legPct(price, 76500, 77500), 34);
  assertEquals(legPct(price, 76500, 79000), 13.6, "same price, far deeper in a wider box");
});

Deno.test("degenerate ranges produce null rather than Infinity", () => {
  // high === low would divide by zero and reach the gate reason as "Infinity%".
  const guard = scanner.indexOf("(analysis as any).legPd = (_izImp");
  assert(guard > -1, "the measure must be computed");
  const block = scanner.slice(guard, guard + 700);
  assert(/_izImp\.high !== _izImp\.low/.test(block), "reject a zero-width leg");
  assert(/typeof _izImp\.high === "number"/.test(block), "and non-numeric bounds");
  assert(/typeof analysis\.lastPrice === "number"/.test(block), "and a missing price");
  assert(/: null;/.test(block), "falling back to null, not a wrong number");
});

Deno.test("it is computed before the gates run", () => {
  // runSafetyGates reads analysis.legPd for the message. Computing it after
  // would silently print nothing.
  const compute = scanner.indexOf("(analysis as any).legPd = (_izImp");
  const gates = scanner.indexOf("const gates = await runSafetyGates(");
  assert(compute > -1 && gates > compute, "must be set before runSafetyGates");
});

Deno.test("the gate message no longer calls the box a swing range", () => {
  // "swing range" borrowed ICT's dealing-range meaning without its substance.
  assert(!/of the \$\{tfLabel\} swing range/.test(scanner), "the old wording must be gone");
  assert(/of the \$\{tfLabel\} 5-swing box/.test(scanner), "named for what it is");
});

Deno.test("the leg figure appears on all three P/D verdicts", () => {
  // Both rejections and the pass, so the comparison is visible wherever the
  // gate speaks — not only when it blocks.
  assertEquals(
    (scanner.match(/\$\{rawStr\}\$\{legStr\}/g) ?? []).length, 3,
    "buy rejection, sell rejection, and the OK branch",
  );
});

Deno.test("it gates nothing", () => {
  // The whole point: advisory until the data says otherwise. legPd must never
  // appear in a passed:false decision.
  const i = scanner.indexOf("const _legPd = (analysis as any).legPd;");
  assert(i > -1);
  const block = scanner.slice(i, i + 1600);
  assert(!/legPd[^\n]*passed: false/.test(block), "must not drive a rejection");
  assert(/advisory/i.test(scanner.slice(Math.max(0, i - 400), i + 200)), "and say so");
});

Deno.test("both measures are recorded on trades, scans and rejected setups", () => {
  assertEquals(
    (scanner.match(/legPd: \(analysis as any\)\.legPd \?\? null,/g) ?? []).length, 2,
    "both entry routes carry it into signal_reason",
  );
  assert(
    /\(detail as any\)\.legPd = \(analysis as any\)\.legPd \?\? null;/.test(scanner),
    "and scan detail carries it for pairs that never became a trade",
  );
  // The refused side is the one that could not be reconstructed before, and is
  // where the box gate's 0-for-26 evidence lives.
  const i = scanner.indexOf("raw_detail: {");
  const block = scanner.slice(i, i + 800);
  assert(/legPd: analysis\.legPd \?\? null,/.test(block), "leg measure on rejected setups");
  assert(/boxPd: analysis\.pd/.test(block), "and the box measure beside it");
});
