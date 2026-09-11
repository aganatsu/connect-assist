import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Nothing recorded why a position was the size it was.
 *
 * computePositionSize starts from riskPercent and then FOUR multipliers only
 * ever cut it — volatility scaling, prop firm, the correlation advisory (to
 * 0.5x), and signalSource !== "unified" (0.5x). So the dollars actually risked
 * can sit well under the configured percent, and `sizingResult.adjustments`
 * was computed, logged to the console, and thrown away.
 *
 * Measured 2026-09-10 over Era C, splitting trades by whether price was inside
 * the OB/FVG:
 *
 *   price inside the POI   20 trades  +0.62R avg  +12.40R  $274.57 per R
 *   near the zone only     40 trades  -0.18R avg   -7.04R  $402.51 per R
 *
 * Dollars-per-R is the money actually put behind one unit of risk. The bucket
 * with the BETTER edge carries 32% LESS of it — the system under-bets its best
 * setups, worth roughly $1,588 on that sample. Which multiplier causes it was
 * unanswerable, because none of them survived the scan.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("provenance is recorded on both entry routes", () => {
  assertEquals(
    (scanner.match(/sizing: sizingProvenance,/g) ?? []).length, 2,
    "the pending order and the market entry",
  );
});

Deno.test("every multiplier that can cut the size is captured", () => {
  const i = scanner.indexOf("const sizingProvenance = {");
  assert(i > -1, "the record must exist");
  const block = scanner.slice(i, scanner.indexOf("};", i));
  for (const f of [
    "signalSource",              // which route, and therefore the 0.5x
    "riskPercent",               // what was configured
    "method",                    // percent_risk vs fixed vs volatility
    "baseLots",                  // before the cuts
    "finalLots",                 // after them
    "adjustments",               // computePositionSize's own list
    "correlationMultiplier",     // applied outside that function
    "signalSourceMultiplier",    // and so is this, the largest single cut
  ]) {
    assert(new RegExp(`\\b${f}:`).test(block), `must record ${f}`);
  }
});

Deno.test("baseLots and finalLots bracket the cuts, so the total is derivable", () => {
  // Without both ends you cannot tell a 0.5x from two 0.7x. finalLots must be
  // the post-multiplier `size`, not sizingResult.lots.
  const i = scanner.indexOf("const sizingProvenance = {");
  const block = scanner.slice(i, scanner.indexOf("};", i));
  assert(/baseLots: sizingResult\.baseLots,/.test(block), "the pre-cut figure comes from the sizer");
  assert(/finalLots: size,/.test(block), "the post-cut figure is the local `size`, after every multiplier");
});

Deno.test("the record is built after the multipliers, not before", () => {
  // signalSource's 0.5x is applied to `size` in a block of its own. Building
  // the record above it would capture the pre-cut value and report a lie.
  const halving = scanner.indexOf("const standaloneMultiplier = 0.5;");
  const record = scanner.indexOf("const sizingProvenance = {");
  assert(halving > -1 && record > halving, "provenance must come after the 0.5x is applied");
});

Deno.test("the signalSource multiplier is derived from the same test the sizer uses", () => {
  // If these ever disagree the record becomes worse than nothing.
  const i = scanner.indexOf("const sizingProvenance = {");
  const block = scanner.slice(i, scanner.indexOf("};", i));
  assert(
    /signalSourceMultiplier: \(detail as any\)\.signalSource !== "unified" \? 0\.5 : 1\.0,/.test(block),
    "same condition as the halving block",
  );
  assert(
    /if \(\(detail as any\)\.signalSource !== "unified"\) \{/.test(scanner),
    "and that block still uses it",
  );
});
