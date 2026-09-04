import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Staged setups were being destroyed by the very thing they were waiting for.
 *
 * Two invalidation rules did it, and both keyed off state that changes as price
 * TRAVELS TO the zone rather than state that says the zone is broken:
 *
 *   1. Direction reversal. Reaching a demand zone below price requires price to
 *      FALL, and a falling entry timeframe reads bearish — so any staged long
 *      was cancelled on approach with "Direction reversed to short". Mirror
 *      image for shorts waiting on a rally into supply.
 *
 *   2. Score drop. A staged setup lives in the below_threshold branch by
 *      definition — being under threshold is why it was staged. Score is
 *      computed at CURRENT price, so as price travels toward the zone the
 *      "at level" factors (Order Block, FVG, Premium/Discount) fall away and
 *      the score drops below watchThreshold. Cancelled for approaching.
 *
 * Observed 2026-09-04: ten setups sat in the zone story and none fired.
 *
 * A zone is a price level. It stays valid until price breaks it. What may still
 * kill a staged setup is price- or time-based only: sl_level breached, TTL
 * exceeded (keyed off staged_at, 120min for scalper), manual dismissal.
 *
 * Promotion still requires the direction to match, which is the correct
 * sequence — price falls into the zone with the entry timeframe bearish (setup
 * waits), then reverses bullish (setup promotes). Removing the invalidation is
 * what lets it survive the first half.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("a direction flip no longer invalidates a staged setup", () => {
  assert(
    !/invalidation_reason: `Direction reversed to/.test(scanner),
    "the direction-reversal invalidation must be gone — approaching a demand " +
      "zone requires the fall that triggers it",
  );
  assert(
    !/stagedMap\.delete\(`\$\{pair\}:\$\{oppositeDir\}`\)/.test(scanner),
    "the opposite-direction staged setup must not be dropped from stagedMap",
  );
});

Deno.test("a score dip no longer invalidates a staged setup", () => {
  assert(
    !/invalidation_reason: `Score dropped to/.test(scanner),
    "the score-drop invalidation must be gone — the score falls precisely " +
      "because price is moving toward the level",
  );
  assert(
    !/reason: "score_dropped"/.test(scanner),
    "no staging action should report score_dropped as an invalidation",
  );
});

Deno.test("the price-based invalidation is retained", () => {
  // This is the one rule that means the level is actually broken.
  assert(
    /invalidation_reason: `SL level breached/.test(scanner),
    "sl_level breach must still invalidate — it is the correct rule",
  );
  assert(
    /const slBreached = existingStaged\.direction === "long"/.test(scanner),
    "the breach test must use the STAGED direction, not the current bar's",
  );
});

Deno.test("TTL expiry is retained as a backstop", () => {
  assert(
    /invalidation_reason: `TTL expired/.test(scanner),
    "TTL must still expire stale setups so they cannot accumulate forever",
  );
  // Keyed off staged_at rather than last activity, so a setup that waits
  // through an adverse direction reading is not penalised for waiting.
  assert(
    /const stagedAtMs = new Date\(s\.staged_at\)\.getTime\(\)/.test(scanner),
    "TTL must key off staged_at — keying off activity would re-introduce the " +
      "bug by expiring setups that sit quietly while price approaches",
  );
});

Deno.test("promotion still requires the direction to match", () => {
  // The fix must not let a staged long promote into a short trade. The trade is
  // placed with analysis.direction, so promotion has to agree with it.
  assert(
    /if \(existingStaged && effectiveScore >= conflictAdjustedMinConfluence && analysis\.direction/.test(scanner),
    "promotion must still be gated on analysis.direction",
  );
  assert(
    /const stagedKey = analysis\.direction \? `\$\{pair\}:\$\{analysis\.direction\}` : null/.test(scanner),
    "existingStaged is looked up by current direction, so a staged setup only " +
      "promotes once direction returns to match — that is the intended sequence",
  );
});

Deno.test("the below-threshold state is still reported", () => {
  // Removing the invalidation must not make a waiting setup invisible.
  assert(
    /action: "watching_below_threshold"/.test(scanner),
    "a staged setup under threshold should report that it is still watching",
  );
});
