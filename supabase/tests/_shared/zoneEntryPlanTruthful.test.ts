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
