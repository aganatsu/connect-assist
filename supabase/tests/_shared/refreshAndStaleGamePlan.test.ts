import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Two regressions I introduced, found by review on 2026-09-08.
 *
 * 1. #471 made a re-detected order refresh in place instead of being replaced,
 *    but updated only signal_score, expires_at and current_price. The stop,
 *    target and size stayed as computed on the scan that first armed the order.
 *    Combined with the refreshed TTL, an order could live for hours or days and
 *    then fill carrying risk levels from a scan that no longer described the
 *    market. The replace-and-reinsert it replaced did not have this problem,
 *    because the new row carried fresh values.
 *
 * 2. #476 changed the thesis-validation game-plan lookup from "search the last
 *    20 scan_logs rows" to "filter by type". That fixed the real problem — the
 *    plan was invisible most of the time because scans write a row every cycle
 *    and plans regenerate every ~4 hours — but the 20-row window had also been
 *    an accidental AGE bound. Removing it meant the most recent plan was used
 *    however old it was, so a bias from days ago could cancel a live setup.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("a refreshed order gets fresh risk levels, not just a fresh clock", () => {
  const i = scanner.indexOf("if (samePriceOrders.length > 0) {");
  assert(i > -1, "the refresh branch was not found");
  const block = scanner.slice(i, scanner.indexOf(".in(\"order_id\", samePriceOrders", i));
  for (const f of ["signal_score", "expires_at", "current_price", "stop_loss", "take_profit", "size"]) {
    assert(new RegExp(`${f}:`).test(block), `the refresh must update ${f}`);
  }
});

Deno.test("the refresh writes the values from THIS scan", () => {
  const i = scanner.indexOf("if (samePriceOrders.length > 0) {");
  const block = scanner.slice(i, scanner.indexOf(".in(\"order_id\", samePriceOrders", i));
  assert(/stop_loss: limitSL/.test(block), "stop must come from the current scan");
  assert(/take_profit: limitTP/.test(block), "target must come from the current scan");
  assert(/size: limitSize/.test(block), "size must come from the current scan");
});

Deno.test("entry price is deliberately not rewritten", () => {
  // An unchanged entry is what defines this branch — the orders in it were
  // selected precisely because their entry equals the new one. Writing it would
  // be harmless but would blur why the branch exists.
  const i = scanner.indexOf("if (samePriceOrders.length > 0) {");
  const block = scanner.slice(i, scanner.indexOf(".in(\"order_id\", samePriceOrders", i));
  assert(!/entry_price:/.test(block), "entry is unchanged by definition here");
  assert(
    /Number\(s\.entry_price\) === Number\(limitEntry\.price\)/.test(scanner),
    "and that is what the partition guarantees",
  );
});

Deno.test("the game plan is bounded by age, not just by type", () => {
  assert(/\.gte\("created_at", gpCutoff\)/.test(scanner), "an age bound must be applied");
  assert(
    /const gpRefreshHours = Number\(\(config as any\)\.gamePlanRefreshHours\) \|\| 4;/.test(scanner),
    "the window should follow the configured refresh interval, not a literal",
  );
  assert(
    /gpRefreshHours \* 2 \* 60 \* 60 \* 1000/.test(scanner),
    "two refresh intervals of slack before a plan is considered stale",
  );
});

Deno.test("the age window tracks the configured refresh interval", () => {
  const win = (h: unknown) => (Number(h) || 4) * 2;
  assertEquals(win(4), 8, "default 4h refresh -> 8h window");
  assertEquals(win(1), 2);
  assertEquals(win(12), 24);
  // Unset, null and garbage all fall back to the documented default rather
  // than collapsing the window to zero and disabling the check silently.
  assertEquals(win(undefined), 8);
  assertEquals(win(null), 8);
  assertEquals(win("nonsense"), 8);
  assertEquals(win(0), 8, "zero must not mean 'never valid'");
});

Deno.test("an absent plan is reported, not silently skipped", () => {
  // gp_bias_reversal failing open is correct; failing open invisibly is how
  // this class of problem survives.
  assert(
    /no game plan within \$\{gpRefreshHours \* 2\}h — gp_bias_reversal will not run/.test(scanner),
    "the fail-open must say so",
  );
});
