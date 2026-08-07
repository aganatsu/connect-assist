import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const zoneEngine = await Deno.readTextFile(new URL("../functions/_shared/impulseZoneEngine.ts", import.meta.url));
const impulseDetector = await Deno.readTextFile(new URL("../functions/_shared/canonicalImpulseDetector.ts", import.meta.url));

Deno.test("impulse engines compare canonical structure and require explicit enforcement for ownership", () => {
  assertStringIncludes(zoneEngine, "canonicalStructureForLegacyConsumers(candles)");
  assertStringIncludes(zoneEngine, "structureAuthorityMode === \"enforce\"");
  assertStringIncludes(zoneEngine, "activeBreaks");
  assertStringIncludes(zoneEngine, "activeSwings");
  assertStringIncludes(impulseDetector, "canonicalStructureForLegacyConsumers(candles)");
  assertStringIncludes(impulseDetector, "structure.breaks");
  assertStringIncludes(impulseDetector, "structure.swings");
});
