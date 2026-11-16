import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * USD/CAD short 2026-11-13 21:25 UTC opened with an 8.6-pip stop against an 18-pip
 * floor (scan detail slAtEntry.belowFloor = true; slFloor.actualSlPips 6.7;
 * impulseZoneSLOverride.impulseSL 8.6) and lost.
 *
 * The floor widened the 6.7p structure stop to 18p, but the Impulse Zone SL override
 * compared its 8.6p candidate against actualSlDistance — the distance captured BEFORE
 * the floor — so 8.6 > 6.7 "won" and replaced the 18p stop. The override must compare
 * against the stop as it stands after the floor.
 */
const src = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("impulse SL override compares against the post-floor stop, not the pre-floor distance", () => {
  assert(src.includes("const currentSlDistance = Math.abs(analysis.lastPrice - sl);"));
  assert(src.includes("if (impulseSlDistance > currentSlDistance && impulseSlPips <= maxImpulseSlPips) {"));
  assert(!src.includes("impulseSlDistance > actualSlDistance"), "stale pre-floor comparison is back");
});

Deno.test("the floor still runs before the impulse override", () => {
  const floorAt = src.indexOf("if (actualSlDistance < minSlDistance) {");
  const overrideAt = src.indexOf("if (impulseSlDistance > currentSlDistance");
  assert(floorAt > 0 && overrideAt > floorAt);
});

Deno.test("unified and cascade overrides keep their own floor checks", () => {
  assert(src.includes("if (unifiedSlPips >= effectiveMinSlPips && unifiedSlPips <= maxUnifiedSlPips) {"));
  assert(src.includes("if (cascadeSlPips >= effectiveMinSlPips && cascadeSlPips <= maxCascadeSlPips) {"));
});
