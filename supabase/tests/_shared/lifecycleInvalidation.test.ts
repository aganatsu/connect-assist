// Pre-entry invalidation is structural. The position stop governs only a
// position that exists.
//
// Step 1 of the corrected sequence in docs/PREARM_GATE_AUDIT.md.
//
// bot-scanner:2588 cancelled any 'pending' row by comparing price against
// stop_loss. Nothing in pending_orders has entered — through BOTH 'pending' and
// 'awaiting_confirmation' there is no position, so a stop sized as entry minus
// risk (floored by MIN_SL_PIPS and spread) has nothing to govern.
//
// Direction of the change, which an earlier draft of this file got backwards:
// on the observed GBP/CHF setup structural sits ~2 pips below the zone floor
// and the position stop ~23 pips lower. Structural is TIGHTER, so switching to
// it makes pre-entry invalidation fire EARLIER. That is intended. A setup whose
// zone has broken is dead regardless of how much room a hypothetical position
// would have had.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  invalidationBreached,
  invalidationForLifecycle,
  freezeStructuralInvalidation,
} from "../../functions/_shared/watchlistInvalidation.ts";

// GBP/CHF, from the live watchlist card.
const zoneFloor = 1.08617;
const structural = 1.08597;    // ~2 pips below the zone
const positionStop = 1.08370;  // ~25 pips — the pair's MIN_SL_PIPS floor

Deno.test("structural is TIGHTER than the position stop, not looser", () => {
  // The premise of the whole change. For a long, invalidation lies below, and
  // the structural level is the HIGHER of the two — so it is reached first.
  assert(
    structural > positionStop,
    "if the position stop were tighter, the old check would have been the " +
      "conservative one and this change would loosen invalidation",
  );
  assert(Math.abs(structural - positionStop) > 0.002, "~23 pips apart on this pair");
});

Deno.test("'pending' uses the structural boundary", () => {
  const r = invalidationForLifecycle({
    direction: "long",
    status: "pending",
    structuralInvalidation: structural,
    stopLoss: positionStop,
  });
  assertEquals(r.lifecycle, "pre_entry");
  assertEquals(r.level, structural);
  assertEquals(r.source, "structural");
});

Deno.test("'awaiting_confirmation' ALSO uses the structural boundary", () => {
  // The correction that matters most. Price arriving at the zone is not entry.
  // Keying on touch would hand the position stop authority over a trade that
  // does not exist yet.
  const r = invalidationForLifecycle({
    direction: "long",
    status: "awaiting_confirmation",
    structuralInvalidation: structural,
    stopLoss: positionStop,
  });
  assertEquals(r.lifecycle, "pre_entry");
  assertEquals(
    r.source,
    "structural",
    "touch means price arrived, not that a position exists",
  );
});

Deno.test("an entered position uses the position stop", () => {
  const r = invalidationForLifecycle({
    direction: "long",
    status: "filled",
    structuralInvalidation: structural,
    stopLoss: positionStop,
  });
  assertEquals(r.lifecycle, "entered");
  assertEquals(r.level, positionStop);
  assertEquals(r.source, "position_stop");
});

Deno.test("the switch invalidates EARLIER — stated plainly so it cannot be misread", () => {
  // A 5-pip overshoot through the zone floor.
  const dip = zoneFloor - 0.00050;
  assertEquals(
    invalidationBreached("long", dip, structural),
    true,
    "structural: broken — the zone that produced the setup has failed",
  );
  assertEquals(
    invalidationBreached("long", dip, positionStop),
    false,
    "position stop: not breached. The OLD behaviour let this setup live on; the " +
      "new behaviour kills it. Tighter, deliberately.",
  );
});

Deno.test("legacy rows fall back and are labelled as migration debt", () => {
  const r = invalidationForLifecycle({
    direction: "long",
    status: "pending",
    structuralInvalidation: null,
    stopLoss: positionStop,
  });
  assertEquals(r.level, positionStop);
  assertEquals(
    r.source,
    "legacy_stop_fallback",
    "should trend to zero as old rows terminate; a persistent count on NEW rows " +
      "means the zone is not reaching the insert",
  );
});

Deno.test("a non-finite structural level is treated as absent", () => {
  for (const bad of [NaN, Infinity]) {
    const r = invalidationForLifecycle({
      direction: "long",
      status: "pending",
      structuralInvalidation: bad,
      stopLoss: positionStop,
    });
    assertEquals(r.source, "legacy_stop_fallback", `${bad} must not become a price`);
  }
});

Deno.test("breach is direction-aware", () => {
  assertEquals(invalidationBreached("long", 1.08590, structural), true);
  assertEquals(invalidationBreached("long", 1.08600, structural), false);
  assertEquals(invalidationBreached("short", 1.08600, structural), true);
  assertEquals(invalidationBreached("short", 1.08590, structural), false);
});

Deno.test("an unknown status is treated as entered, not pre-entry", () => {
  // Fail towards the position stop for statuses this function does not know.
  // Treating an unrecognised status as pre-entry would apply a structural level
  // to a real position.
  const r = invalidationForLifecycle({
    direction: "long",
    status: "some_future_status",
    structuralInvalidation: structural,
    stopLoss: positionStop,
  });
  assertEquals(r.lifecycle, "entered");
});

// ─── Wiring ──────────────────────────────────────────────────────────

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the pending loop no longer compares raw stop_loss", () => {
  assert(
    !/if \(pending\.direction === "long" && currentPrice < slLevel\)/.test(scanner),
    "the unconditional position-stop comparison must be gone",
  );
  assert(
    !/if \(pending\.direction === "short" && currentPrice > slLevel\)/.test(scanner),
    "both directional branches, or shorts keep the old behaviour",
  );
  assert(scanner.includes("invalidationForLifecycle("));
});

Deno.test("the scanner keys on status, not on zone_touch_time", () => {
  const call = scanner.slice(
    scanner.indexOf("invalidationForLifecycle({"),
    scanner.indexOf("});", scanner.indexOf("invalidationForLifecycle({")),
  );
  assert(call.includes("status: pending.status"), "lifecycle state decides");
  assert(
    !call.includes("zoneTouchTime"),
    "touch presence is not entry — awaiting_confirmation has no position either",
  );
});

Deno.test("the structural level is persisted", () => {
  assert(scanner.includes("structural_invalidation: pendingStructuralInvalidation"));
  assert(scanner.includes("structural_invalidation_source:"));
});

// ─── Freezing across promotion ───────────────────────────────────────
//
// The watchlist froze a structural level in staged_setups.sl_level when the
// setup was first staged. Recomputing at promotion, from the CURRENT scan's
// bestZone, would hand the same lifecycle candidate a different boundary than
// it was staged under — the detected zone drifts slightly between scans, so
// nothing errors, the numbers just disagree, and the candidate is judged
// against a level it was never staged with.

Deno.test("promotion copies the staged level EXACTLY", () => {
  const stagedLevel = 1.08597;
  let derived = 0;
  const r = freezeStructuralInvalidation({ stagedLevel }, () => {
    derived++;
    // Deliberately different: a rescan's zone would drift.
    return { level: 1.08604, source: "zone_boundary", bufferPrice: 0, zone: null, adjusted: false };
  });
  assertEquals(r.level, stagedLevel, "the frozen level, not a recomputed one");
  assertEquals(
    derived,
    0,
    "derive must not even run for a promotion — computing then discarding would " +
      "still leave the recompute in place for someone to later 'fix' into being used",
  );
});

Deno.test("the inherited source is labelled distinctly", () => {
  const r = freezeStructuralInvalidation({ stagedLevel: 1.08597 }, () => ({
    level: 1.08597,
    source: "zone_boundary",
    bufferPrice: 0,
    zone: null,
    adjusted: false,
  }));
  assertEquals(
    r.source,
    "staged_inherited",
    "an inherited level must never be mistaken for a freshly derived one that " +
      "happened to agree — otherwise a broken inheritance looks healthy",
  );
});

Deno.test("direct creation derives once", () => {
  let derived = 0;
  const r = freezeStructuralInvalidation({ stagedLevel: null }, () => {
    derived++;
    return { level: 1.08590, source: "zone_boundary", bufferPrice: 0, zone: null, adjusted: false };
  });
  assertEquals(r.level, 1.08590);
  assertEquals(r.source, "zone_boundary");
  assertEquals(derived, 1, "exactly once — the persisted value is the contract");
});

Deno.test("a non-finite staged level is not inherited", () => {
  for (const bad of [NaN, Infinity, null, undefined]) {
    const r = freezeStructuralInvalidation({ stagedLevel: bad as number | null }, () => ({
      level: 1.086,
      source: "zone_boundary",
      bufferPrice: 0,
      zone: null,
      adjusted: false,
    }));
    assertEquals(r.source, "zone_boundary", `${bad} must fall through to derive`);
  }
});

Deno.test("an underivable boundary stays null rather than being invented", () => {
  const r = freezeStructuralInvalidation({ stagedLevel: null }, () => ({
    level: null,
    source: "none",
    bufferPrice: 0,
    zone: null,
    adjusted: false,
  }));
  assertEquals(
    r.level,
    null,
    "null persists, so invalidationForLifecycle reports legacy_stop_fallback " +
      "instead of a fabricated level",
  );
});

Deno.test("the scanner freezes rather than recomputing on promotion", () => {
  assert(
    scanner.includes("freezeStructuralInvalidation("),
    "promotion must copy the staged level, not recompute from this scan's zone",
  );
  const call = scanner.slice(
    scanner.indexOf("freezeStructuralInvalidation("),
    scanner.indexOf("freezeStructuralInvalidation(") + 700,
  );
  assert(
    call.includes("existingStaged?.sl_level"),
    "the staged level is the frozen contract and must be the first source",
  );
});

Deno.test("Watchlist lifecycle monitoring reads the frozen boundary", () => {
  const monitorStart = scanner.indexOf("for (const setup of executableWatchlist)");
  const monitorEnd = scanner.indexOf("// ── Thesis Conviction Tracker", monitorStart);
  const monitor = scanner.slice(monitorStart, monitorEnd);
  const invalidationStart = monitor.indexOf("const invalidation = deriveWatchlistInvalidation({");
  const invalidationEnd = monitor.indexOf("});", invalidationStart);
  const invalidationCall = monitor.slice(invalidationStart, invalidationEnd);

  assert(invalidationStart >= 0, "the lifecycle monitor must resolve invalidation");
  assert(
    invalidationCall.includes("proposedLevel: setup.sl_level"),
    "monitoring must use the level frozen when the setup was staged",
  );
  assert(
    !invalidationCall.includes("zone,"),
    "passing the zone would make deriveWatchlistInvalidation replace the frozen level",
  );
  assert(
    !invalidationCall.includes("impulse:"),
    "a later scan must not re-derive the frozen boundary from impulse data",
  );
});

Deno.test("routine Watchlist refresh does not rewrite sl_level", () => {
  const updateMarker = "// Update observation fields without rewriting frozen executable geometry.";
  const updateStart = scanner.indexOf(updateMarker);
  const updateEnd = scanner.indexOf("if (zoneWatchUpdateError)", updateStart);
  const update = scanner.slice(updateStart, updateEnd);

  assert(updateStart >= 0, "expected the existing Watchlist refresh path");
  assert(
    !update.includes("sl_level:"),
    "a refresh may update observations, but the structural boundary is immutable",
  );
});

Deno.test("frozen candidate evaluation never re-derives its boundary from a nested trigger", () => {
  const loopStart = scanner.indexOf(
    "// Evaluate every frozen candidate for the pair",
  );
  const loopEnd = scanner.indexOf(
    "// Apply FOTSI penalty",
    loopStart,
  );
  const loop = scanner.slice(loopStart, loopEnd);

  assert(loopStart >= 0, "expected the frozen-candidate evaluation loop");
  assert(
    loop.includes("proposedLevel: storedLevel"),
    "the persisted staged level must be the only invalidation input",
  );
  assert(
    !loop.includes("stagedCandidate.originating_zone"),
    "a nested Fib trigger must never replace the frozen parent-zone boundary",
  );
  assert(
    !loop.includes('reasonCode: "structural_boundary_repaired"'),
    "routine evaluation must not mutate a frozen structural boundary",
  );
  assert(
    !loop.includes("sl_level: boundaryLevel"),
    "the scanner must not rewrite sl_level after staging",
  );
});

Deno.test("nested zone-watch creation freezes complete geometry", () => {
  const start = scanner.indexOf("const zoneWatchInvalidation =");
  const end = scanner.indexOf(
    "const zoneWatchRow =",
    start,
  );
  const creation = scanner.slice(start, end);

  assert(start >= 0, "expected the impulse zone-watch creation path");
  assert(
    creation.includes("structuralInvalidation: zoneWatchInvalidation.level"),
    "the frozen entry-zone contract must contain the parent-derived boundary",
  );
  assert(
    creation.includes("positionStop: analysis.stopLoss"),
    "the discovery-time position stop must remain available as provenance",
  );
  assert(
    creation.includes("target: analysis.takeProfit"),
    "the frozen target must not live only in the staged table column",
  );
  assert(
    /stagedDecisionFields\(\s*zoneWatchOrigin,\s*true,\s*zoneWatchFrozenEntryZone,?\s*\)/s
      .test(creation),
    "the complete geometry must be passed to the existing frozen-contract owner",
  );
});

Deno.test("score refresh paths preserve all staged execution geometry", () => {
  const confirmingStart = scanner.indexOf(
    "// Score is above gate but hasn't been staged long enough",
  );
  const confirmingEnd = scanner.indexOf(
    "scanDetails.push(detail);",
    confirmingStart,
  );
  const confirming = scanner.slice(confirmingStart, confirmingEnd);

  const belowThresholdStart = scanner.indexOf(
    "// Update existing staged setup with new score and factors",
  );
  const belowThresholdEnd = scanner.indexOf(
    "detail.status = \"staged_watching\"",
    belowThresholdStart,
  );
  const belowThreshold = scanner.slice(
    belowThresholdStart,
    belowThresholdEnd,
  );

  for (const [name, refresh] of [
    ["confirmation", confirming],
    ["below-threshold", belowThreshold],
  ] as const) {
    assert(refresh.length > 0, `expected the ${name} refresh path`);
    assert(
      !refresh.includes("entry_price:"),
      `${name} refresh must not move the frozen entry`,
    );
    assert(
      !refresh.includes("sl_level:"),
      `${name} refresh must not replace structural invalidation`,
    );
    assert(
      !refresh.includes("tp_level:"),
      `${name} refresh must not move the frozen target`,
    );
  }
});

const restoreMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260830170000_restore_frozen_nested_boundaries.sql",
    import.meta.url,
  ),
);

Deno.test("active nested boundaries are restored only from their own audit history", () => {
  assert(
    restoreMigration.includes("reason_code = 'structural_boundary_repaired'"),
    "the repair must use the exact recorded regression event",
  );
  assert(
    restoreMigration.includes("s.sl_level = repair.repaired_boundary"),
    "a later legitimate boundary change must not be overwritten",
  );
  assert(
    restoreMigration.includes("s.status IN ('watching', 'qualified')"),
    "terminal history must remain immutable",
  );
});
