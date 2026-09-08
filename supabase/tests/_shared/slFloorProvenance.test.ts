import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MIN_SL_PIPS, SPECS } from "../../functions/_shared/smcAnalysis.ts";

/**
 * GBP/USD position 1ec762e3, opened 2026-09-07 20:20 UTC, closed sl_hit for
 * -493.23 on a 4.01-lot position.
 *
 *   entry      1.35410
 *   stop       1.35287   = 12.3 pips
 *   MIN_SL_PIPS["GBP/USD"] = 25
 *
 * Its signal_reason recorded `originalSL: 1.35287`, so the stop was 12.3 pips
 * AT ENTRY, and its exitFlags recorded trailingStopEnabled false,
 * breakEvenEnabled false, both Activated false — management never touched it.
 *
 * Static reading eliminated every mechanism I could check:
 *   - SPECS["GBP/USD"].pipSize is 0.0001, so the floor is 0.0025 in price
 *   - MIN_SL_PIPS is imported, not shadowed in bot-scanner
 *   - all six `sl` reassignments after the floor either widen or are guarded
 *     by `>= effectiveMinSlPips`
 *   - analysis.lastPrice is never mutated, so the floor and the recorded entry
 *     share one reference price
 *   - signal_reason carries no filledFromLimitOrder, so it is the market path
 *
 * So this records the inputs rather than guessing again. No behaviour change.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the case that motivated this is arithmetically a violation", () => {
  const entry = 1.35410, stop = 1.35287;
  const pipSize = SPECS["GBP/USD"].pipSize;
  assertEquals(pipSize, 0.0001, "a 5-digit pipSize would explain it away; it is not");
  const pips = Math.abs(entry - stop) / pipSize;
  assertEquals(Math.round(pips * 10) / 10, 12.3);
  assertEquals(MIN_SL_PIPS["GBP/USD"], 25);
  assert(pips < MIN_SL_PIPS["GBP/USD"], "12.3 is below the 25-pip floor");
  // Even the missing-pair fallback would have been enough.
  assert(pips < 15, "and below the `?? 15` fallback too");
});

Deno.test("the floor decision records its inputs, not just its outcome", () => {
  for (const f of [
    "slBeforeFloor", "lastPrice", "pipSize", "staticMinSlPips",
    "atrFloorPips", "effectiveMinSlPips", "actualSlPips", "widened",
  ]) {
    assert(new RegExp(`${f}[,:]`).test(scanner), `slFloorTrace must record ${f}`);
  }
  assert(/\(detail as any\)\.slFloor = slFloorTrace;/.test(scanner), "and reach scan detail");
});

Deno.test("the trace is captured before the widening, not after", () => {
  // Recording slBeforeFloor after the branch would capture the widened value
  // and show nothing.
  const i = scanner.indexOf("const slFloorTrace = {");
  const j = scanner.indexOf("if (actualSlDistance < minSlDistance) {", i);
  assert(i > -1 && j > i, "the trace must be built before the widening branch");
});

Deno.test("the stop that reaches the position is recorded separately", () => {
  // slFloor is the decision; slAtEntry is the outcome after every override
  // (impulse, unified, cascade, anchored). A violation is only provable with
  // both.
  const i = scanner.indexOf("(detail as any).slAtEntry = {");
  assert(i > -1, "slAtEntry missing");
  const block = scanner.slice(i, i + 700);
  // `sl` and `tp` are shorthand properties, so match either form.
  for (const f of ["entry", "slPips", "floorPips", "belowFloor"]) {
    assert(new RegExp(`${f}:`).test(block), `slAtEntry must record ${f}`);
  }
  for (const f of ["sl", "tp"]) {
    assert(new RegExp(`\\b${f}(,|:)`).test(block), `slAtEntry must record ${f}`);
  }
});

Deno.test("slAtEntry is measured after every SL override has run", () => {
  // Placed at marketEntryPrice, which is after the impulse/unified/cascade/
  // anchored overrides. Measuring earlier would miss an override lowering it.
  const anchored = scanner.indexOf("Zone-Anchored Stop (flag: zoneAnchoredStop");
  const atEntry = scanner.indexOf("(detail as any).slAtEntry = {");
  assert(anchored > -1 && atEntry > anchored, "must come after the last override");
});

Deno.test("belowFloor allows for float noise but not for a real breach", () => {
  const check = (slPips: number, floor: number) => slPips < (floor - 0.01);
  assertEquals(check(12.3, 25), true, "the observed case must flag");
  assertEquals(check(25, 25), false, "exactly at the floor is not a breach");
  assertEquals(check(24.995, 25), false, "float noise must not flag");
  assertEquals(check(24.9, 25), true, "a real tenth-of-a-pip breach must flag");
});
