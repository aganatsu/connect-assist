import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSingleOwnershipMode,
} from "../../functions/_shared/singleOwnershipEnforcement.ts";
import {
  resolveCanonicalScannerMode,
} from "../../functions/_shared/canonicalScannerEnforcement.ts";
import {
  resolveCanonicalStructureMode,
} from "../../functions/_shared/canonicalStructureDecision.ts";

Deno.test("trade decision enforcement resolves directly from saved config", () => {
  assertEquals(resolveSingleOwnershipMode("enforce"), {
    requestedMode: "enforce",
    effectiveMode: "enforce",
    reasonCode: "requested_mode_enabled",
  });
});

Deno.test("scanner workflow stays observe until trade decision enforcement owns authorization", () => {
  assertEquals(
    resolveCanonicalScannerMode({
      requestedMode: "enforce",
      singleOwnershipEffectiveMode: "observe",
    }),
    {
      requestedMode: "enforce",
      effectiveMode: "observe",
      reasonCode: "single_ownership_required",
    },
  );
  assertEquals(
    resolveCanonicalScannerMode({
      requestedMode: "enforce",
      singleOwnershipEffectiveMode: "enforce",
    }).effectiveMode,
    "enforce",
  );
});

Deno.test("market structure stays observe until trade decision enforcement owns authorization", () => {
  assertEquals(
    resolveCanonicalStructureMode({
      requestedMode: "enforce",
      singleOwnershipEffectiveMode: "observe",
    }).effectiveMode,
    "observe",
  );
  assertEquals(
    resolveCanonicalStructureMode({
      requestedMode: "enforce",
      singleOwnershipEffectiveMode: "enforce",
    }).effectiveMode,
    "enforce",
  );
});
