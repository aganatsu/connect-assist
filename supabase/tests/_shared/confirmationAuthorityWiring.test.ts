import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const hierarchy = await Deno.readTextFile(
  "./supabase/functions/_shared/confirmationHierarchy.ts",
);
const zone = await Deno.readTextFile(
  "./supabase/functions/_shared/zoneConfirmation.ts",
);
const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const fastScanner = await Deno.readTextFile(
  "./supabase/functions/zone-confirmation-scanner/index.ts",
);

Deno.test("all confirmation mechanisms expose one observation contract", () => {
  assertStringIncludes(hierarchy, "attachHierarchyAuthority");
  assertStringIncludes(zone, '"unified_hierarchy"');
  assertStringIncludes(zone, '"legacy_tier"');
  assertStringIncludes(scanner, "buildRoutedConfirmationObservation");
  assertStringIncludes(fastScanner, "buildRoutedConfirmationObservation");
});

Deno.test("the sole pending fill route persists confirmation authority", () => {
  assertStringIncludes(
    fastScanner,
    "authority: confirmedSignal.authority || null",
  );
  assertStringIncludes(fastScanner, "authority: confirmationAuthority");
  assert(
    !scanner.includes("authority: confirmedSignal.authority || null"),
    "bot-scanner must not persist confirmation from a duplicate pending route",
  );
});

Deno.test("observation metadata does not become an authorization branch", () => {
  assert(!scanner.includes("authority.entryReadyUnderCurrentBehavior"));
  assert(!fastScanner.includes("authority.entryReadyUnderCurrentBehavior"));
  assert(!scanner.includes("authority.affectsAuthorization"));
});
