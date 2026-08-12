// Pre-touch invalidation is not the position stop loss.
//
// Step 1 of the corrected sequence in docs/PREARM_GATE_AUDIT.md, and a blocker
// for pre-arming.
//
// bot-scanner:2588 cancelled any row with status 'pending' when price breached
// stop_loss — touched or not. A stop loss is sized for a position that EXISTS:
// entry minus risk, floored by MIN_SL_PIPS and spread. Before entry the
// question is whether the ZONE or IMPULSE that produced the setup has broken.
//
// Observed 2026-08-12 on the GBP/CHF watchlist entry: invalidation 1.08597
// against a zone floor of 1.08617 — about 2 pips, on a pair whose minimum stop
// is 25 pips. Pre-arming under the position stop means the order dies on any
// overshoot before it can fill.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  invalidationBreached,
  invalidationForPhase,
} from "../../functions/_shared/watchlistInvalidation.ts";

// GBP/CHF, from the live watchlist card.
const zoneFloor = 1.08617;
const structural = 1.08597; // ~2 pips below the zone
const positionStop = 1.08370; // ~25 pips — the pair's MIN_SL_PIPS floor

Deno.test("before touch, the structural boundary governs", () => {
  const r = invalidationForPhase({
    direction: "long",
    structuralInvalidation: structural,
    stopLoss: positionStop,
    zoneTouchTime: null,
  });
  assertEquals(r.phase, "pre_touch");
  assertEquals(r.level, structural);
  assertEquals(r.source, "structural");
});

Deno.test("after touch, the position stop governs", () => {
  const r = invalidationForPhase({
    direction: "long",
    structuralInvalidation: structural,
    stopLoss: positionStop,
    zoneTouchTime: "2026-08-12T01:00:00.000Z",
  });
  assertEquals(r.phase, "post_touch");
  assertEquals(r.level, positionStop);
  assertEquals(r.source, "position_stop");
});

Deno.test("the two boundaries genuinely differ — this is not a rename", () => {
  assert(
    Math.abs(structural - positionStop) > 0.002,
    "if they were interchangeable this whole change would be pointless; on GBP/CHF " +
      "they are ~23 pips apart",
  );
});

Deno.test("a legacy row with no structural level falls back, and says so", () => {
  const r = invalidationForPhase({
    direction: "long",
    structuralInvalidation: null,
    stopLoss: positionStop,
    zoneTouchTime: null,
  });
  assertEquals(r.level, positionStop);
  assertEquals(
    r.source,
    "position_stop_fallback",
    "every row written before the column existed has none; an un-invalidated order " +
      "is worse than one invalidated early, but the fallback must be countable rather " +
      "than silently indistinguishable from a real structural level",
  );
});

Deno.test("a non-finite structural level is treated as absent", () => {
  for (const bad of [NaN, Infinity]) {
    const r = invalidationForPhase({
      direction: "long",
      structuralInvalidation: bad,
      stopLoss: positionStop,
      zoneTouchTime: null,
    });
    assertEquals(r.source, "position_stop_fallback", `${bad} must not become a price`);
  }
});

Deno.test("breach is direction-aware", () => {
  assertEquals(invalidationBreached("long", 1.08590, structural), true);
  assertEquals(invalidationBreached("long", 1.08600, structural), false);
  assertEquals(invalidationBreached("short", 1.08600, structural), true);
  assertEquals(invalidationBreached("short", 1.08590, structural), false);
});

Deno.test("the GBP/CHF case: an approach that would have died now survives", () => {
  // Price dips 5 pips through the zone floor while retracing into it. Under the
  // old check this breached and the setup was gone before it could fill.
  const dip = zoneFloor - 0.00050;

  const preTouch = invalidationForPhase({
    direction: "long",
    structuralInvalidation: structural,
    stopLoss: positionStop,
    zoneTouchTime: null,
  });
  assertEquals(
    invalidationBreached("long", dip, preTouch.level),
    true,
    "5 pips through a 2-pip structural boundary IS a structural break — the point is " +
      "not that nothing invalidates, but that the correct level decides",
  );

  // Same dip against the position stop: not a breach. Which is why using the
  // position stop pre-touch is not merely stricter — it is answering a
  // different question, and on this pair it answers it 23 pips away.
  assertEquals(invalidationBreached("long", dip, positionStop), false);
});

// ─── Wiring ──────────────────────────────────────────────────────────

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the pending loop no longer compares raw stop_loss before touch", () => {
  assert(
    !/if \(pending\.direction === "long" && currentPrice < slLevel\)/.test(scanner),
    "the unconditional position-stop comparison must be gone, not merely guarded",
  );
  assert(
    !/if \(pending\.direction === "short" && currentPrice > slLevel\)/.test(scanner),
    "both directional branches must be replaced, or shorts keep the old behaviour",
  );
  assert(scanner.includes("invalidationForPhase("), "the phase decision must be consulted");
});

Deno.test("the structural level is persisted, or the phase decision has nothing to read", () => {
  assert(scanner.includes("structural_invalidation: pendingStructuralInvalidation"));
  assert(
    scanner.includes("structural_invalidation_source:"),
    "recording which structure produced the level makes a wrong boundary diagnosable",
  );
});
