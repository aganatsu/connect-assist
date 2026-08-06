import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const watchlist = await Deno.readTextFile(
  new URL("../../../src/components/WatchlistPanel.tsx", import.meta.url),
);

Deno.test("scanner records pre-zone candidates before the hard unified skip", () => {
  const classification = scanner.indexOf(
    "const unifiedWatchDisposition = classifyUnifiedWatch",
  );
  const hardSkip = scanner.indexOf(
    "} else if (pairConfig.requireUnifiedZone)",
    classification,
  );
  assert(classification >= 0);
  assert(hardSkip > classification);
  const section = scanner.slice(classification, hardSkip);
  assertStringIncludes(section, '"execution_watch"');
  assertStringIncludes(section, "stageUnifiedWatch(true)");
});

Deno.test("pre-zone observations are explicitly non-executable", () => {
  assertStringIncludes(
    scanner,
    "setupType = executionEligible",
  );
  assertStringIncludes(
    scanner,
    ': "waiting_for_unified_zone"',
  );
  assertStringIncludes(
    scanner,
    "execution_eligible: executionEligible",
  );
  assertStringIncludes(
    scanner,
    "existingStaged.execution_eligible !== false",
  );
  assertStringIncludes(
    scanner,
    "sl_level: executionEligible ? watchlistInvalidation?.level : null",
  );
});

Deno.test("a complete zone creates a fresh candidate rather than rewriting the observation", () => {
  assertStringIncludes(scanner, "requiresFreshCandidateHandoff(");
  assertStringIncludes(scanner, "observation_parent_id: handoffParentId");
  assertStringIncludes(
    scanner,
    "Pre-zone observation resolved; complete zone requires a fresh execution candidate",
  );
  assertStringIncludes(
    scanner,
    "created a fresh frozen execution candidate for the next scan",
  );
});

Deno.test("Watchlist labels observations and derives near-zone count from lifecycle", () => {
  assertStringIncludes(watchlist, "getWatchlistDisplay");
  assertStringIncludes(
    watchlist,
    'watchlistDisplay.state === "monitoring"',
  );
  assertStringIncludes(watchlist, "const nearZoneCount = active.filter");
  assertStringIncludes(watchlist, '"approaching_zone", "at_zone"');
});
