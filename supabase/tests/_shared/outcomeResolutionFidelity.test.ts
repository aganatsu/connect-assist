import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The counterfactual tracker decides whether a rejected setup "would have won".
 * Those verdicts are the only evidence we have about whether the gates are
 * worth keeping, so a bias in the measurement reads as a fact about strategy.
 *
 * It had two, both deleting wins and preserving losses:
 *
 *   1. Outcomes were resolved on 1H candles. At 2:1 R:R the stop sits half as
 *      far as the target, so an hourly bar hits the stop alone easily but
 *      rarely reaches the target without also touching the stop. Clean losses
 *      survived; wins collapsed into "inconclusive". The tracker's own comment
 *      recorded the scale of it — 130 of 161 apparent winners were both-hit.
 *
 *   2. MIN_AGE_MS was 1 hour against a 24 hour window, and a setup is
 *      classified once and never revisited. Verdicts froze after 1/24th of the
 *      window, and since the stop is the nearer barrier that truncation
 *      resolved losses while leaving slower winners permanently inconclusive.
 *
 * Together these produced "0 of 103 premium/discount rejections would have
 * won" — a number with probability ~1e-18 under any honest filter, which is
 * what gave it away. See simulateOutcome.test.ts for the behavioural
 * demonstration; this file guards the configuration that feeds it.
 */

const tracker = await Deno.readTextFile(
  new URL("../../functions/outcome-tracker/index.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("outcomes are resolved on 5m candles, not hourly ones", () => {
  assert(
    /interval:\s*"5m"/.test(tracker),
    'outcome-tracker must fetch 5m candles — 1H bars cannot order a stop and a ' +
      'target that fall in the same bar, and scalper trades resolve in minutes',
  );
  assert(
    !/interval:\s*"1h"/.test(tracker),
    "outcome-tracker must not resolve outcomes on 1H candles",
  );
});

Deno.test("the fetch covers the outcome window with headroom", () => {
  const windowMatch = tracker.match(/OUTCOME_WINDOW_HOURS\s*=\s*(\d+)/);
  const limitMatch = tracker.match(/interval:\s*"5m",\s*\n\s*limit:\s*(\d+)/);
  assert(windowMatch, "OUTCOME_WINDOW_HOURS not found");
  assert(limitMatch, "5m fetch limit not found");

  const windowHours = parseInt(windowMatch[1], 10);
  const bars = parseInt(limitMatch[1], 10);
  const barsPerWindow = (windowHours * 60) / 5;

  // 2x headroom, so a tracker that has fallen behind still has candles that
  // cover the window rather than silently returning "inconclusive".
  assert(
    bars >= barsPerWindow * 2,
    `${bars} 5m bars covers only ${(bars * 5 / 60).toFixed(1)}h against a ` +
      `${windowHours}h window — needs at least ${barsPerWindow * 2}`,
  );
});

Deno.test("a setup is not judged before its window has elapsed", () => {
  // The pending query filters on outcome_status = 'pending', so whatever
  // verdict is written first is permanent. Checking early is not a partial
  // answer that gets refined later — it is the final answer.
  assert(
    /MIN_AGE_MS\s*=\s*OUTCOME_WINDOW_HOURS\s*\*/.test(tracker),
    "MIN_AGE_MS must be derived from OUTCOME_WINDOW_HOURS so every setup is " +
      "judged on the full window; it was 1 hour against a 24 hour window",
  );
});

Deno.test("rejections record the premium/discount reading on every timeframe", () => {
  // The P/D gate reads the ENTRY timeframe only — 5m for a scalper — while
  // htfPDD/htfPD4H/htfPD1H are computed for the zone engine and dropped. Gold
  // on 2026-09-03 read 39.1% discount on 5m and 80.9% premium on the 1H
  // impulse. Without both stored, a rejection cannot be scored against the
  // higher timeframe that disagreed with it.
  assert(
    /function buildPdSnapshot/.test(scanner),
    "buildPdSnapshot must exist to capture the P/D readings at rejection time",
  );
  for (const tf of ["entry", "h1", "h4", "d"]) {
    assert(
      new RegExp(`\\b${tf}:\\s*read\\(`).test(scanner),
      `buildPdSnapshot must record the ${tf} premium/discount reading`,
    );
  }
});

Deno.test("both rejection paths persist the snapshot", () => {
  // Two call sites: gate_blocked, and below_threshold_strong_t1. The second is
  // the control group — rejected on score rather than by the P/D gate — so it
  // is only useful for comparison if it carries the same fields.
  const calls = scanner.match(/rawDetail:\s*buildPdSnapshot\(/g) ?? [];
  assert(
    calls.length === 2,
    `expected both logRejectedSetup call sites to pass rawDetail, found ${calls.length}`,
  );
});
