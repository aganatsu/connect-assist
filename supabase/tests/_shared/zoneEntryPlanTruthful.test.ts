import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The Zone Story showed an entry plan that could never be traded.
 *
 * Three different SL/TP calculations exist and only one survives:
 *
 *   calculateSLTP        honours the configured slMethod/tpMethod, then is
 *                        overwritten
 *   bot-scanner          structural stop, floored by MIN_SL_PIPS and the ATR
 *                        floor, target recomputed at entry +/- risk * tpRatio
 *                        <- THIS IS WHAT TRADES
 *   unifiedZoneEngine    stop = zone edge +/- half the zone's own WIDTH, target
 *                        = impulse BOS level  <- THIS WAS ON SCREEN
 *
 * Observed 2026-09-04 on NZD/USD: a 2.7-pip zone produced "Risk 1.3 pips, R:R
 * 31.48:1". The Unified Zone SL Override guard requires
 * `unifiedSlPips >= effectiveMinSlPips`, so that stop was rejected and the
 * floored structural stop was used instead — the displayed plan was unreachable.
 * Nothing on screen said so, and it was read as an exceptional setup twice.
 *
 * The raw fields are deliberately unchanged: slPrice feeds the override guard
 * and rrRatio feeds the minRR check that decides whether an entry object exists
 * at all. Moving either changes trade selection. `executable` is additive.
 */

const engine = await Deno.readTextFile(
  new URL("../../functions/_shared/unifiedZoneEngine.ts", import.meta.url),
);
const panel = await Deno.readTextFile(
  new URL("../../../src/components/ZoneStoryPanel.tsx", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** Reproduce the executable maths the engine performs. */
function executable(
  entry: number, rawSL: number, dir: "long" | "short",
  pipSize: number, minSlPips: number, tpRatio: number,
) {
  const rawRisk = Math.abs(entry - rawSL);
  const risk = Math.max(rawRisk, minSlPips * pipSize);
  return {
    slPrice: dir === "long" ? entry - risk : entry + risk,
    tpPrice: dir === "long" ? entry + risk * tpRatio : entry - risk * tpRatio,
    riskPips: risk / pipSize,
    rrRatio: tpRatio,
    slWidenedToFloor: risk > rawRisk,
  };
}

Deno.test("the NZD/USD case produces a tradeable plan", () => {
  // Zone [0.58955, 0.58982], short at the high, raw stop half a zone-width above.
  const entry = 0.58982;
  const rawSL = 0.58982 + (0.58982 - 0.58955) * 0.5;   // 0.589955
  const e = executable(entry, rawSL, "short", 0.0001, 8, 2);

  // Raw risk was 1.35 pips — the number that rendered as R:R 31.48:1.
  assert(Math.abs(entry - rawSL) / 0.0001 < 2, "raw risk should be under 2 pips");
  assertEquals(e.slWidenedToFloor, true);
  assertEquals(Math.round(e.riskPips * 10) / 10, 8);
  assertEquals(e.rrRatio, 2);
});

Deno.test("a stop already above the floor is left alone", () => {
  const e = executable(1.1000, 1.0980, "long", 0.0001, 8, 2);
  assertEquals(e.slWidenedToFloor, false);
  assertEquals(Math.round(e.riskPips), 20);
  assertEquals(Math.round(e.tpPrice * 10000) / 10000, 1.1040);
});

Deno.test("the executable target uses tpRatio, never the BOS level", () => {
  // The engine's tpPrice is impulse.bosPrice, which bears no relation to risk.
  // Execution always recomputes as entry +/- risk * tpRatio.
  assert(
    /tpPrice = entryDirection === "long"\s*\?\s*entryPrice \+ execRiskPrice \* tpRatio/.test(
      engine.replace(/const exec/g, ""),
    ) || /execRiskPrice \* tpRatio/.test(engine),
    "executable target must derive from tpRatio",
  );
});

Deno.test("the raw fields that feed gates are untouched", () => {
  // slPrice feeds the SL-override guard; rrRatio feeds the minRR check.
  assert(
    /slPrice = zonePOI\.poi\.high \+ \(zonePOI\.poi\.high - zonePOI\.poi\.low\) \* 0\.5/.test(engine),
    "the raw zone-derived stop must keep its original formula",
  );
  assert(
    /if \(rrRatio !== null && rrRatio < minRR\)/.test(engine),
    "the minRR check must still test the raw rrRatio, not the executable one",
  );
});

Deno.test("executable is null unless the caller supplies both inputs", () => {
  // Without minSlPips and tpRatio the engine cannot know what execution does,
  // and must not guess — the panel falls back to the raw values.
  assert(
    /typeof minSlPips === "number" && minSlPips > 0/.test(engine)
      && /typeof tpRatio === "number" && tpRatio > 0/.test(engine),
    "both inputs must be required before computing an executable plan",
  );
});

Deno.test("the scanner supplies the same floor it applies to real stops", () => {
  assert(
    /minSlPips: effectiveMinSlPipsForZone/.test(scanner),
    "bot-scanner must pass the floor into the zone engine",
  );
  assert(
    /Math\.max\(zoneStaticMinSlPips, zoneAtrFloorPips\)/.test(scanner),
    "the floor must be max(MIN_SL_PIPS, ATR floor), matching the entry path",
  );
  assert(
    /tpRatio: config\.tpRatio/.test(scanner),
    "the reward multiple must come from config, not a literal",
  );
});

Deno.test("minRR and requireConfirmation are not passed", () => {
  // Both gate whether an entry object exists. Supplying them here would change
  // trade selection, which this change must not do.
  const call = scanner.slice(
    scanner.indexOf("minSlPips: effectiveMinSlPipsForZone") - 400,
    scanner.indexOf("minSlPips: effectiveMinSlPipsForZone") + 200,
  );
  assert(!/minRR:/.test(call), "minRR must stay at its default");
  assert(!/requireConfirmation:/.test(call), "requireConfirmation must stay at its default");
});

Deno.test("the panel renders the executable plan", () => {
  for (const field of ["slPrice", "tpPrice", "riskPips", "rewardPips", "rrRatio"]) {
    assert(
      new RegExp(`executable\\?\\.${field}`).test(panel),
      `the panel must prefer executable.${field}`,
    );
  }
  assert(
    /slWidenedToFloor/.test(panel),
    "the panel should say when the stop had to widen to the floor",
  );
  assert(
    /Structural target \(BOS\)/.test(panel),
    "the BOS level should still be shown, labelled as not traded",
  );
});

/**
 * Second pass, 2026-09-05. The first fix corrected the RATIO but left two
 * falsehoods:
 *
 *   1. entryPrice was presented as a fill price. Both routes fill at LIVE price
 *      — market-fill-at-zone uses analysis.lastPrice, and the pending route sets
 *      `const actualFillPrice = currentPrice` while logging "limit was X". The
 *      zone edge is a target level, never a fill.
 *
 *   2. The stop shown could be one execution would refuse. The Unified Zone SL
 *      Override applies the zone stop only when it sits within
 *      [effectiveMinSlPips, staticMinSlPips * impulseSlCapMultiplier]. Outside
 *      that band it is discarded and a structural stop is used instead.
 *
 * BTC/USD 2026-09-04 hit both: level 79000 shown, filled 79637.76; zone stop
 * 677.3 points against a 225-point cap (MIN_SL_PIPS 150 x scalper 1.5), rejected,
 * and execution fell back to a 150-point structural stop — the bare floor —
 * inside a 1354-point zone. Result: -$532.50, stopped out without price ever
 * testing the zone.
 */

Deno.test("a zone stop above the override cap is reported as rejected", () => {
  assert(
    /rawRiskPips > maxSlPips/.test(engine),
    "the engine must compare the zone stop against the override cap",
  );
  assert(
    /slDisposition = "rejected_too_wide"/.test(engine),
    "an over-wide stop must be labelled, not silently shown",
  );
});

Deno.test("no executable plan is invented when the stop is rejected", () => {
  // Execution falls back to a structural stop the zone engine cannot see, so
  // there is no honest plan to display.
  const i = engine.indexOf('slDisposition = "rejected_too_wide"');
  assert(i > -1);
  const branch = engine.slice(i, i + 500);
  assert(/executable: null/.test(branch), "executable must be null when rejected");
});

Deno.test("the disposition covers every band", () => {
  for (const d of ["accepted", "widened_to_floor", "rejected_too_wide", "unknown"]) {
    assert(new RegExp(`"${d}"`).test(engine), `missing disposition: ${d}`);
  }
  assert(
    /slDisposition = execRiskPrice > rawRiskPrice \? "widened_to_floor" : "accepted"/.test(engine),
    "in-band stops must distinguish widened from accepted",
  );
});

Deno.test("fillsAtMarket is always true and the panel says so", () => {
  assert(/fillsAtMarket: true/.test(engine), "both routes fill at live price");
  assert(/fills at market/.test(panel), "the panel must state that fills are at market");
  assert(
    /target \{fmt\(unifiedData\.entry\.entryPrice\)\}/.test(panel),
    'the entry must read as a target level, not "@ price"',
  );
});

Deno.test("the panel surfaces a rejected stop prominently", () => {
  assert(
    /slDisposition === "rejected_too_wide"/.test(panel),
    "the panel must show when execution will discard the zone stop",
  );
  assert(
    /execution uses structural stop/.test(panel),
    "and say what execution will do instead",
  );
});

Deno.test("the scanner passes the same cap the override enforces", () => {
  assert(
    /maxSlPips: \(MIN_SL_PIPS\[pair\] \?\? 15\) \* \(pairConfig\.impulseSlCapMultiplier \?\? 4\)/.test(scanner),
    "the cap must match maxUnifiedSlPips in the override guard",
  );
});

Deno.test("the BTC case would now be labelled rejected", () => {
  // zone 79000-80354.65, stop = low - half width = 78322.675 → 677.325 points.
  // cap = MIN_SL_PIPS 150 * scalper 1.5 = 225.
  const rawRiskPips = (79000 - 78322.675) / 1;
  const cap = 150 * 1.5;
  assertEquals(Math.round(rawRiskPips * 1000) / 1000, 677.325);
  assert(rawRiskPips > cap, "677.325 must exceed the 225 cap");
});
