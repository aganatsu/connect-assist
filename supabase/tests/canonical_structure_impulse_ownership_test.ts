import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const zoneEngine = await Deno.readTextFile(
  new URL("../functions/_shared/impulseZoneEngine.ts", import.meta.url),
);
const impulseDetector = await Deno.readTextFile(
  new URL("../functions/_shared/canonicalImpulseDetector.ts", import.meta.url),
);

Deno.test("Impulse Zone Engine exclusively owns leg selection and canonical module only measures", () => {
  assertStringIncludes(
    zoneEngine,
    "canonicalStructureForLegacyConsumers(candles)",
  );
  assertStringIncludes(zoneEngine, 'structureAuthorityMode === "enforce"');
  assertStringIncludes(zoneEngine, "activeBreaks");
  assertStringIncludes(zoneEngine, "activeSwings");
  assertStringIncludes(zoneEngine, "qualifyImpulseLeg");
  assertStringIncludes(zoneEngine, "if (!impulseQualification.qualified)");
  assertStringIncludes(impulseDetector, "does not select an impulse leg");
  assertStringIncludes(impulseDetector, "measureCanonicalImpulseMetrics");
  if (impulseDetector.includes("detectCanonicalImpulse")) {
    throw new Error(
      "Canonical metrics module must not select a competing impulse",
    );
  }
});
