import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * A zone is an AREA. Price can react at the near edge, the middle, or only after
 * tagging the far edge — that is what makes it a zone rather than a line. A stop
 * placed INSIDE it bets on WHERE within the zone price reacts, not on WHETHER
 * the zone holds. Only the second is the thesis.
 *
 * Every stop the system produces today sits inside the zone:
 *
 *   structural swing    150 pts
 *   LTF refinedSL        36.7 pts
 *   zone half-width     677 pts   (rejected as over-cap, so never used)
 *
 * BTC/USD 2026-09-04: entered 79637.76 inside a 79000-80354.65 zone with a
 * 150-point stop at 79487.76. Price bottomed exactly there, never reached 79000,
 * closed -$532.50. The zone was never invalidated — the trade lost because the
 * stop was 11% of the zone's width.
 *
 * The flag anchors the stop beyond the far edge, and SKIPS the setup when that
 * stop exceeds the override cap rather than falling back to a stop that does not
 * express the idea. Default OFF: this changes stop distance, position size, R:R
 * and therefore which setups clear the min-R:R gate.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

Deno.test("the stop anchors beyond the zone edge, not inside it", () => {
  assert(
    /anchorZone\.low - adjustedSlBuffer \* spec\.pipSize/.test(scanner),
    "a long's stop must sit below zoneLow by the buffer",
  );
  assert(
    /anchorZone\.high \+ adjustedSlBuffer \* spec\.pipSize/.test(scanner),
    "a short's stop must sit above zoneHigh by the buffer",
  );
});

Deno.test("an over-cap anchored stop skips the setup rather than shrinking", () => {
  // Falling back to a floor-width stop inside the zone is the behaviour that
  // lost money. If a structurally valid stop will not fit, do not trade.
  assert(
    /anchoredPips > maxAnchoredPips/.test(scanner),
    "the anchored stop must be compared against the cap",
  );
  assert(
    /detail\.status = "skipped_zone_too_wide"/.test(scanner),
    "over-cap must skip with its own status, not silently reuse the old stop",
  );
  const i = scanner.indexOf('detail.status = "skipped_zone_too_wide"');
  const branch = scanner.slice(i, i + 800);
  assert(/continue;/.test(branch), "the skip branch must actually skip the pair");
  assert(/reason = "exceeds_cap"/.test(branch), "and record why, for querying");
});

Deno.test("a stop tighter than the floor widens away from the zone", () => {
  // A very tight zone can produce a sub-floor stop. Widening must keep it on the
  // far side, never pull it back inside.
  assert(
    /anchoredPips < effectiveMinSlPips/.test(scanner),
    "the floor must still apply to the anchored stop",
  );
  assert(
    /widenedToFloor = widened/.test(scanner),
    "widening must be recorded so it is visible in scan detail",
  );
});

Deno.test("the measurement runs even when the flag is off", () => {
  // Otherwise turning the flag on is blind: the skip rate is only discovered by
  // watching trades stop happening.
  const i = scanner.indexOf("const zoneAnchoredStopOn");
  const guard = scanner.slice(i, scanner.indexOf("const anchoredSL"));
  assert(
    !/zoneAnchoredStopOn &&/.test(guard),
    "the outer guard must not require the flag — the arithmetic is always run",
  );
  for (const field of ["wouldSkip", "stopInsideZone", "zoneWidthPips", "currentSlPips", "enabled"]) {
    assert(new RegExp(`${field}[,:]`).test(scanner), `shadow field ${field} must be recorded`);
  }
});

Deno.test("the shadow branch cannot move a trade", () => {
  // Everything that mutates sl/tp or skips must sit under the flag. The off
  // branch may only log.
  const start = scanner.indexOf("if (!zoneAnchoredStopOn) {");
  const end = scanner.indexOf("} else if (anchoredPips > maxAnchoredPips)", start);
  assert(start > -1 && end > start, "the flag-off branch was not found");
  const offBranch = scanner.slice(start, end);
  for (const forbidden of ["sl =", "tp =", "continue;", "detail.status"]) {
    assert(
      !offBranch.includes(forbidden),
      `the flag-off branch must not contain \`${forbidden}\` — it must be inert`,
    );
  }
});

Deno.test("stopInsideZone measures the defect, not the fix", () => {
  // A stop between the two edges is exactly the BTC failure: ordinary movement
  // inside the zone takes it out while the zone itself never fails.
  assert(
    /sl > anchorZone\.low && sl < anchorZone\.high/.test(scanner),
    "inside-the-zone must be tested against both edges, direction-independent",
  );
  // Sanity-check the predicate against the BTC numbers.
  const insideZone = (sl: number) => sl > 79000 && sl < 80354.65;
  assertEquals(insideZone(79487.76), true, "the 150-point stop that lost was inside");
  assertEquals(insideZone(78999), false, "the anchored stop is outside");
});

Deno.test("the target is recomputed from the new risk", () => {
  const i = scanner.indexOf("const anchoredRisk");
  assert(i > -1, "anchored risk not computed");
  const branch = scanner.slice(i, i + 300);
  assert(
    /anchoredRisk \* config\.tpRatio/.test(branch),
    "TP must be rebuilt at tpRatio from the anchored risk, matching execution",
  );
});

Deno.test("it runs last so it overrides the other SL paths", () => {
  // Impulse, unified and cascade overrides all place stops inside the zone.
  // Whichever ran last would otherwise win.
  const anchored = scanner.indexOf("Zone-Anchored Stop (flag: zoneAnchoredStop");
  for (const other of [
    "Impulse Zone SL Override",
    "Unified Zone SL Override",
    "Cascade Zone SL Override",
  ]) {
    assert(scanner.indexOf(other) < anchored, `${other} must precede the anchored stop`);
  }
});

Deno.test("it only acts when price is actually at the zone", () => {
  assert(
    /anchorZone && anchorZone\.priceAtZone/.test(scanner),
    "no zone or price nowhere near it means there is nothing to anchor to",
  );
});

Deno.test("the flag defaults off and lives in the live mapper", () => {
  assert(/zoneAnchoredStop: false/.test(mapper), "RUNTIME_DEFAULTS entry missing");
  assert(
    /zoneAnchoredStop: strategy\.zoneAnchoredStop \?\? raw\.zoneAnchoredStop \?\? RUNTIME_DEFAULTS\.zoneAnchoredStop/.test(mapper),
    "must be mapped in configMapper, not bot-scanner's dead legacy mapper",
  );
  assert(
    /\(pairConfig as any\)\.zoneAnchoredStop === true/.test(scanner),
    "the read must require an explicit true so absence means off",
  );
});

Deno.test("bot-scanner DEFAULTS mirrors the mapper", () => {
  // STYLE_OVERRIDES compares resolved values against bot-scanner's DEFAULTS to
  // decide "did the user set this?". Divergence makes that misfire.
  const a = scanner.match(/^  zoneAnchoredStop: (\w+),/m);
  const b = mapper.match(/^  zoneAnchoredStop: (\w+),/m);
  assert(a && b, "missing from one defaults object");
  assertEquals(a[1], b[1]);
});

Deno.test("the BTC case: anchored stop exceeds the cap, so it would skip", () => {
  // zone 79000-80354.65, price 79637.76, buffer 1 pip @ pipSize 1.
  // anchored = 79000 - 1 = 78999 → 638.76 points.
  // cap = MIN_SL_PIPS 150 * scalper multiplier 1.5 = 225.
  const anchoredPips = Math.abs(79637.76 - (79000 - 1)) / 1;
  const cap = 150 * 1.5;
  assertEquals(Math.round(anchoredPips * 100) / 100, 638.76);
  assert(anchoredPips > cap, "638.76 exceeds the 225 cap — the setup should skip");
  // The trade that was taken used a 150-point stop and lost. Skipping is the
  // intended outcome, not a wider stop.
});
