import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * scan_logs detail recorded no price. Not `lastPrice`, not anything.
 *
 * Every retrospective question about where price sat relative to a zone was
 * therefore unanswerable from history, and had to be inferred from
 * pending_orders.current_price — which is overwritten every cycle and only
 * survives as the last value before the order resolved. Over 2026-09-06 that
 * cost several rounds of guessing at mechanisms the logs could have settled
 * directly.
 *
 * One field, no behaviour change.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("scan detail records the price it was evaluating", () => {
  assert(/lastPrice: analysis\.lastPrice,/.test(scanner), "detail must carry lastPrice");
});

Deno.test("it sits on the detail object, not nested in a sub-object", () => {
  // Nested under analysis_snapshot or similar it would be far harder to reach
  // from the jsonb_array_elements queries these logs are read with.
  // Structural, not a byte window: lastPrice must sit between the opening of
  // the detail object and a stable sibling on the same level. A fixed offset
  // breaks whenever another field is added above it.
  const i = scanner.indexOf("const detail: any = {");
  assert(i > -1, "the detail object was not found");
  const j = scanner.indexOf("      lastPrice: analysis.lastPrice,", i);
  const sibling = scanner.indexOf("      score: analysis.score,", i);
  assert(j > i, "lastPrice must appear inside the detail object");
  assert(sibling > j, "and at the same level, before its known sibling");
});

Deno.test("it is the analysis price, not a re-derived one", () => {
  // Anything recomputed here could disagree with the price every gate and zone
  // comparison in this cycle actually used, which would make the log worse than
  // no log.
  assert(
    !/lastPrice: candles\[|lastPrice: currentPrice/.test(scanner),
    "must be analysis.lastPrice, the value the cycle actually reasoned about",
  );
});
