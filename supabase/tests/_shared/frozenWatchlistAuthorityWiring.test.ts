import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const preZone = await Deno.readTextFile(
  new URL("../../functions/_shared/preZoneObservation.ts", import.meta.url),
);

Deno.test("frozen candidates are found by pair even when fresh direction changes", () => {
  assertStringIncludes(scanner, "const stagedByPair = new Map");
  assertStringIncludes(
    scanner,
    "const stagedCandidatesForPair = stagedByPair.get(pair) || []",
  );
  assertStringIncludes(
    scanner,
    "for (const stagedCandidate of stagedCandidatesForPair)",
  );
});

Deno.test("fresh direction disagreement does not invalidate frozen candidate", () => {
  assertEquals(scanner.includes("Direction reversed to"), false);
  assertStringIncludes(
    scanner,
    "Fresh direction disagreement does not invalidate frozen zone structure",
  );
  assertStringIncludes(scanner, 'action: "retained"');
});

Deno.test("fresh score drop does not invalidate frozen candidate", () => {
  assertEquals(
    scanner.includes('reason: "score_dropped"'),
    false,
  );
  assertStringIncludes(
    scanner,
    "Frozen candidate retained: current scan",
  );
});

Deno.test("a missing fresh zone cannot downgrade frozen executable evidence", () => {
  assertStringIncludes(
    preZone,
    "isPreZoneObservation(setup) && nextExecutionEligible",
  );
  assertStringIncludes(
    scanner.replace(/\s+/g, " "),
    "!watchResult && existingStaged && isPreZoneObservation(existingStaged)",
  );
  assertEquals(
    scanner.includes(
      "Frozen execution zone is no longer valid; continuing as a new observe-only candidate",
    ),
    false,
  );
});
