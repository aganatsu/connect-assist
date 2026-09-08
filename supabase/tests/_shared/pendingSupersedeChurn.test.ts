import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Measured 2026-09-06 over 60 days of pending_orders:
 *
 *   status        orders   reached_zone_and_hunted
 *   cancelled       645          1
 *   expired         211          1
 *   invalidated      42         23
 *   filled            1          0
 *
 * 899 orders, one fill, and only 25 ever touched their zone. Of the 645
 * cancellations:
 *
 *   superseded by new setup    400
 *   thesis validation          202
 *   SL breached                 16
 *   manually cancelled          12
 *   everything else             15
 *
 * And of those 400 supersessions, 309 replaced the order at the IDENTICAL
 * entry price. Average movement across the rest was under a pip on FX
 * (USD/CAD 0.000028, EUR/USD 0.000013; GBP/CAD, XAU/USD and GBP/JPY had zero
 * moved at all).
 *
 * So the dominant case is a setup being re-detected unchanged and the order
 * being torn down and rebuilt for nothing: new order_id, confirmation_attempts
 * reset, and 400 "cancelled" rows that read as the bot changing its mind.
 *
 * This refreshes in place when the level has not moved. expires_at is extended
 * exactly as a reinsert would have done, so effective lifetime is unchanged.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** The partition the scanner performs. */
function partition(existing: Array<{ id: string; entry_price: number }>, newPrice: number) {
  return {
    same: existing.filter(o => Number(o.entry_price) === Number(newPrice)),
    moved: existing.filter(o => Number(o.entry_price) !== Number(newPrice)),
  };
}

Deno.test("an unchanged level refreshes rather than replaces", () => {
  const p = partition([{ id: "a", entry_price: 1.16234 }], 1.16234);
  assertEquals(p.same.length, 1);
  assertEquals(p.moved.length, 0);
});

Deno.test("a moved level still supersedes", () => {
  // EUR/AUD had 22 of 85 genuinely move. Those must keep the old behaviour —
  // a resting order at a level the engine no longer believes in is stale.
  const p = partition([{ id: "a", entry_price: 1.16234 }], 1.16250);
  assertEquals(p.same.length, 0);
  assertEquals(p.moved.length, 1);
});

Deno.test("a mixed batch splits, it does not pick one branch", () => {
  const p = partition(
    [{ id: "a", entry_price: 1.1 }, { id: "b", entry_price: 1.2 }, { id: "c", entry_price: 1.1 }],
    1.1,
  );
  assertEquals(p.same.map(o => o.id), ["a", "c"]);
  assertEquals(p.moved.map(o => o.id), ["b"]);
});

Deno.test("comparison is numeric, not string", () => {
  // entry_price comes back from Postgres NUMERIC as a string. "1.16234" and
  // 1.16234 must match, or every order would look moved and nothing changes.
  const p = partition([{ id: "a", entry_price: "1.16234" as unknown as number }], 1.16234);
  assertEquals(p.same.length, 1, "string/number must compare equal");
  assert(
    /Number\(s\.entry_price\) === Number\(limitEntry\.price\)/.test(scanner),
    "both sides must be coerced",
  );
});

Deno.test("the refresh extends expires_at, so lifetime is unchanged", () => {
  // Bounded to the refresh branch's own update call. A fixed byte window
  // reached into the movedOrders branch below, which legitimately cancels.
  const i = scanner.indexOf("if (samePriceOrders.length > 0) {");
  const block = scanner.slice(i, scanner.indexOf('.in("order_id", samePriceOrders', i));
  assert(/expires_at: expiresAt/.test(block), "a reinsert would have set a fresh TTL; so must this");
  assert(/signal_score: analysis\.score/.test(block), "the newer score should win");
  assert(!/status:/.test(block), "the refresh must not touch status");
  assert(
    !/confirmation_attempts/.test(block),
    "and must not reset the hunt counter, which a reinsert did",
  );
});

Deno.test("a refreshed order is not also inserted", () => {
  // Two live orders at the same level for the same symbol and direction would
  // double the position if both filled.
  const refresh = scanner.indexOf('action: "refreshed_in_place"');
  const insert = scanner.indexOf('from("pending_orders").insert(');
  assert(refresh > -1 && insert > refresh, "the guard must come before the insert");
  const between = scanner.slice(refresh, insert);
  assert(/continue;/.test(between), "the refreshed path must skip the insert");
});

Deno.test("the supersede path now records resolved_at", () => {
  // Every other cancel sets it. This one did not, which is why
  // avg_life_minutes came back NULL for the largest bucket in the table and
  // order lifetime could not be measured at all.
  const i = scanner.indexOf("if (movedOrders.length > 0) {");
  const block = scanner.slice(i, i + 900);
  assert(/status: "cancelled"/.test(block));
  assert(/resolved_at: new Date\(\)\.toISOString\(\)/.test(block), "resolved_at must be set");
});

Deno.test("the cancel reason reports the order it actually cancelled", () => {
  // It read stalePending[0] while cancelling a filtered subset, so the logged
  // "old entry" could belong to an order that was not touched.
  assert(
    !/vs old \$\{stalePending\[0\]/.test(scanner),
    "the reason must reference movedOrders, not the unfiltered list",
  );
  assert(/movedOrders\[0\]\.entry_price/.test(scanner));
});
